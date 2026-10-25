import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { askShouldPublish, appendSource, publishPage } from "../src/confluence.js";
import { parseMarkdown, parseRecord, writeJson, writeMarkdown, writeRecord } from "../src/core.js";
import { createRecord, initStore, locateStore, readStoreConfig, supersede, transition } from "../src/store.js";
import { startServer } from "../src/web.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(root, "dist", "src", "cli.js");

async function tempHome(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "decision-home-"));
}

function runCli(home: string, args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, HOME: home, DECISION_DIR: "", DECISION_RECORDED_BY: "" },
      cwd: home,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

describe("canonical records", () => {
  it("round-trips every example through markdown and json", async () => {
    const dir = path.join(root, "examples");
    const names = (await readdir(dir)).filter((name) => name.endsWith(".md"));
    assert.equal(names.length, 8);
    for (const name of names) {
      const original = await readFile(path.join(dir, name), "utf8");
      const record = parseMarkdown(original);
      assert.equal(writeMarkdown(record), original);
      const json = writeJson(record);
      assert.equal(writeMarkdown(parseRecord(json, "json")), original);
      assert.equal(writeRecord(parseRecord(writeRecord(record, "json"), "json"), "md"), original);
    }
  });
});

describe("store", () => {
  it("falls back to the personal store and keeps the recorder out of the shared config", async () => {
    const home = await tempHome();
    const project = path.join(home, "project");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(project);
    const found = await locateStore({ cwd: project, home, env: undefined });
    assert.equal(found.reason, "personal");
    assert.equal(found.root, path.join(home, "Decisions"));
    await initStore(path.join(project, "decisions"));
    const projectStore = await locateStore({ cwd: path.join(project, "nested"), home });
    assert.equal(projectStore.reason, "project");
    await initStore(found.root);
    await createRecord(found.root, found.config, { decision: "Keep the receipt", recordedBy: "Ada" });
    const config = await readStoreConfig(found.root);
    assert.equal(JSON.stringify(config).includes("Ada"), false);
    const marker = await readFile(path.join(found.root, ".decision.json"), "utf8");
    assert.equal(marker.includes("Ada"), false);
    await rm(home, { recursive: true, force: true });
  });

  it("writes enriched or short bodies and supersedes both files", async () => {
    const home = await tempHome();
    const dir = path.join(home, "store");
    await initStore(dir, { capture: "enriched" });
    const config = await readStoreConfig(dir);
    const short = await createRecord(dir, config, { decision: "Short call", enriched: false, recordedBy: "Ada" });
    assert.equal(short.record.body, "");
    assert.equal(short.record.decidedAt, undefined);
    const full = await createRecord(dir, config, { decision: "Longer call", recordedBy: "Ada" });
    assert.match(full.record.body, /## Context\n\n## Rationale/);
    const proposal = await createRecord(dir, config, { decision: "Maybe later", status: "proposed", enriched: false });
    const moved = await transition(dir, proposal, "rejected");
    assert.equal(moved.record.status, "rejected");
    await assert.rejects(() => transition(dir, moved, "decided"));
    const proposed = await createRecord(dir, config, { decision: "Try the new plan", status: "proposed" });
    const decided = await transition(dir, proposed, "decided");
    assert.match(decided.record.decidedAt ?? "", /^\d{4}-\d{2}-\d{2}$/);
    const pair = await supersede(dir, config, decided, "Replace the plan");
    assert.equal(pair.previous.record.status, "superseded");
    assert.deepEqual(pair.previous.record.supersededBy, [pair.next.record.id]);
    assert.deepEqual(pair.next.record.supersedes, [decided.record.id]);
    await rm(home, { recursive: true, force: true });
  });
});

describe("confluence choices", () => {
  it("asks only when a person can answer, and defaults to no", () => {
    assert.equal(askShouldPublish({ isTTY: true, answer: "" }), false);
    assert.equal(askShouldPublish({ isTTY: true, answer: "y" }), true);
    assert.equal(askShouldPublish({ isTTY: false, answer: "y" }), false);
    assert.equal(askShouldPublish({ isTTY: true, publish: true, answer: "n" }), true);
    assert.equal(askShouldPublish({ isTTY: true, noPublish: true, answer: "y" }), false);
  });

  it("appends the page URL and keeps the local file when publish fails", async () => {
    const home = await tempHome();
    const dir = path.join(home, "store");
    await initStore(dir, {
      confluence: { enabled: true, baseUrl: "https://example.atlassian.net", spaceKey: "ENG", parentPageId: "1" },
    });
    const config = await readStoreConfig(dir);
    const stored = await createRecord(dir, config, { decision: "Ship the notes", recordedBy: "Ada" });
    const target = {
      baseUrl: "https://example.atlassian.net",
      spaceKey: "ENG",
      parentPageId: "1",
      email: "ada@example.com",
      token: "secret",
    };
    const url = await publishPage(stored.record, target, async () => {
      return new Response(JSON.stringify({ id: "99", _links: { base: "https://example.atlassian.net/wiki", webui: "/spaces/ENG/pages/99/Ship" } }), { status: 200 });
    });
    assert.match(url, /\/pages\/99\//);
    const next = appendSource(stored.record, url);
    assert.equal(next.sources?.[0], url);
    await assert.rejects(() => publishPage(stored.record, target, async () => new Response("nope", { status: 500 })));
    const text = await readFile(stored.filePath, "utf8");
    assert.equal(text.includes("pages/99"), false);
    await rm(home, { recursive: true, force: true });
  });
});

describe("cli", () => {
  it("checks the examples and captures without writing the name into the store", async () => {
    const home = await tempHome();
    const checked = await runCli(home, ["check", path.join(root, "examples")]);
    assert.equal(checked.stderr, "", checked.stderr);
    assert.equal(checked.code, 0);
    const store = path.join(home, "work");
    const created = await runCli(home, ["new", "Adopt trunk-based development", "--dir", store, "--by", "Ada"]);
    assert.equal(created.code, 0, created.stderr);
    assert.match(created.stdout, /Saved to /);
    const marker = await readFile(path.join(store, ".decision.json"), "utf8");
    assert.equal(marker.includes("Ada"), false);
    const listed = await runCli(home, ["list", "--dir", store]);
    assert.match(listed.stdout, /Adopt trunk-based development/);
    const where = await runCli(home, ["where", "--dir", store]);
    assert.match(where.stdout, /Reason: dir/);
    await rm(home, { recursive: true, force: true });
  });

  it("does not publish when the terminal is not interactive", async () => {
    const home = await tempHome();
    const store = path.join(home, "work");
    await runCli(home, ["confluence", "--dir", store, "--base-url", "https://example.atlassian.net", "--space", "ENG", "--parent", "1"]);
    const created = await runCli(home, ["new", "Stay local", "--dir", store, "--by", "Ada"]);
    assert.equal(created.code, 0, created.stderr);
    assert.equal(created.stdout.includes("Published"), false);
    const forced = await runCli(home, ["new", "Force a page", "--dir", store, "--by", "Ada", "--publish"]);
    assert.equal(forced.code, 1);
    assert.match(forced.stdout, /Saved to /);
    await rm(home, { recursive: true, force: true });
  });
});

describe("browser server", () => {
  it("rejects a missing token and serves capture, edit, search, and status", async () => {
    const home = await tempHome();
    const dir = path.join(home, "store");
    await initStore(dir, { suggestedTags: ["engineering"] });
    const server = await startServer(dir);
    const bare = await fetch(server.url.replace(/\?token.*/, "/api/records"));
    assert.equal(bare.status, 401);
    const created = await fetch(`${server.url.replace(/\/\?token/, "/api/records?token")}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${server.token}` },
      body: JSON.stringify({ decision: "Meet on Tuesday", enriched: true }),
    });
    assert.equal(created.status, 201);
    const payload = (await created.json()) as { record: { id: string; mtimeMs: number } };
    const edited = await fetch(`http://127.0.0.1:${server.port}/api/records/${payload.record.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${server.token}`, host: `127.0.0.1:${server.port}` },
      body: JSON.stringify({
        mtimeMs: payload.record.mtimeMs,
        sections: { Context: "The room is noisy.", Rationale: "", Alternatives: "", Consequences: "" },
      }),
    });
    assert.equal(edited.status, 200);
    const found = await fetch(`http://127.0.0.1:${server.port}/api/records?q=Tuesday`, {
      headers: { authorization: `Bearer ${server.token}`, host: `127.0.0.1:${server.port}` },
    });
    const rows = (await found.json()) as Array<{ decision: string }>;
    assert.equal(rows[0]?.decision, "Meet on Tuesday");
    const proposed = await fetch(`http://127.0.0.1:${server.port}/api/records`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${server.token}` },
      body: JSON.stringify({ decision: "Try a pilot", proposed: true }),
    });
    const proposal = (await proposed.json()) as { record: { id: string } };
    const decided = await fetch(`http://127.0.0.1:${server.port}/api/records/${proposal.record.id}/transition`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${server.token}` },
      body: JSON.stringify({ status: "decided" }),
    });
    const decidedBody = (await decided.json()) as { record: { status: string; decidedAt?: string } };
    assert.equal(decidedBody.record.status, "decided");
    assert.ok(decidedBody.record.decidedAt);
    const page = await fetch(server.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Decisions/);
    await server.close();
    await rm(home, { recursive: true, force: true });
  });
});
