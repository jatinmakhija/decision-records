import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(root, "dist", "src", "cli.js");

function runCli(
  home: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        DECISION_DIR: "",
        DECISION_RECORDED_BY: "",
        EDITOR: "/usr/bin/true",
        ...extraEnv,
      },
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
    child.stdin.end();
  });
}

function idOf(stdout: string, sentence: string): string {
  const line = stdout.split("\n").find((item) => item.includes(sentence));
  assert.ok(line, `No list row contains "${sentence}".\n${stdout}`);
  const id = line.slice(0, 8);
  assert.match(id, /^[0-9a-f]{8}$/);
  return id;
}

function savedFile(stdout: string): string {
  const match = stdout.match(/Saved to (.+)/);
  assert.ok(match?.[1], stdout);
  return match[1].trim();
}

describe("cli regression", () => {
  it("prints help", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "decision-cli-"));
    const help = await runCli(home, ["help"]);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /decision new/);
    const fields = await runCli(home, ["help", "fields"]);
    assert.match(fields.stdout, /Rationale/);
    const unknown = await runCli(home, ["nope"]);
    assert.equal(unknown.code, 1);
    await rm(home, { recursive: true, force: true });
  });

  it("runs the command lifecycle against an isolated store", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "decision-cli-"));
    const store = path.join(home, "store");
    const init = await runCli(home, ["init", "--dir", store]);
    assert.equal(init.code, 0, init.stderr);
    assert.match(init.stdout, /Initialized/);

    const where = await runCli(home, ["where", "--dir", store]);
    assert.match(where.stdout, /Reason: dir/);
    assert.match(where.stdout, /Confluence: off/);

    const created = await runCli(home, ["new", "Adopt trunk-based development", "--dir", store, "--by", "Ada"]);
    assert.equal(created.code, 0, created.stderr);
    const createdPath = savedFile(created.stdout);
    const listed = await runCli(home, ["list", "--dir", store]);
    const prefix = idOf(listed.stdout, "Adopt trunk-based development");
    const shown = await runCli(home, ["show", prefix, "--json", "--dir", store]);
    const record = JSON.parse(shown.stdout) as { id: string; status: string; decidedAt?: string; body: string };
    assert.equal(record.status, "decided");
    assert.equal(record.decidedAt, undefined);
    assert.equal(record.body, "");
    assert.match(createdPath, new RegExp(`${record.id}\\.md$`));

    const proposal = await runCli(home, [
      "new",
      "Pause external hiring for Q1",
      "--proposed",
      "--enriched",
      "--dir",
      store,
      "--by",
      "Ada",
    ]);
    assert.equal(proposal.code, 0, proposal.stderr);
    assert.match(await readFile(savedFile(proposal.stdout), "utf8"), /## Context/);
    const afterProposal = await runCli(home, ["list", "--status", "proposed", "--dir", store]);
    const proposalId = idOf(afterProposal.stdout, "Pause external hiring");
    const found = await runCli(home, ["search", "hiring", "--status", "proposed", "--dir", store]);
    assert.match(found.stdout, /Pause external hiring/);
    const missed = await runCli(home, ["search", "hiring", "--decider", "nobody", "--dir", store]);
    assert.equal(missed.stdout.trim(), "");

    const decided = await runCli(home, ["decide", proposalId, "--dir", store]);
    assert.equal(decided.code, 0, decided.stderr);
    const decidedView = JSON.parse((await runCli(home, ["show", proposalId, "--json", "--dir", store])).stdout) as {
      status: string;
      decidedAt: string;
    };
    assert.equal(decidedView.status, "decided");
    assert.match(decidedView.decidedAt, /^\d{4}-\d{2}-\d{2}$/);
    const decideAgain = await runCli(home, ["decide", proposalId, "--dir", store]);
    assert.equal(decideAgain.code, 1);

    const rejectable = await runCli(home, ["new", "Rewrite the service", "--proposed", "--dir", store, "--by", "Ada"]);
    assert.equal(rejectable.code, 0, rejectable.stderr);
    const rejectId = idOf((await runCli(home, ["list", "--dir", store])).stdout, "Rewrite the service");
    const rejected = await runCli(home, ["reject", rejectId, "--dir", store]);
    assert.equal(rejected.code, 0, rejected.stderr);

    const revocable = await runCli(home, ["new", "Buy the extra monitor", "--dir", store, "--by", "Ada"]);
    const revokeId = idOf((await runCli(home, ["list", "--dir", store])).stdout, "Buy the extra monitor");
    const revoked = await runCli(home, ["revoke", revokeId, "--dir", store]);
    assert.equal(revoked.code, 0, revoked.stderr);

    const replaced = await runCli(home, ["supersede", prefix, "Use short-lived branches", "--dir", store, "--by", "Ada"]);
    assert.equal(replaced.code, 0, replaced.stderr);
    assert.match(replaced.stdout, /Superseded/);
    const oldView = JSON.parse((await runCli(home, ["show", prefix, "--json", "--dir", store])).stdout) as {
      status: string;
      supersededBy: string[];
    };
    assert.equal(oldView.status, "superseded");
    assert.equal(oldView.supersededBy.length, 1);

    const edited = await runCli(home, ["edit", prefix, "--dir", store]);
    assert.equal(edited.code, 0, edited.stderr);

    const jsonRecord = await runCli(home, ["new", "Keep the receipt", "--format", "json", "--short", "--dir", store, "--by", "Ada"]);
    assert.match(savedFile(jsonRecord.stdout), /\.json$/);

    const exported = await runCli(home, ["export", "--json", "--id", revokeId, "--dir", store]);
    const copy = JSON.parse(exported.stdout) as { id: string };
    copy.id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const importFile = path.join(home, "import.json");
    await writeFile(importFile, `${JSON.stringify(copy, null, 2)}\n`);
    const imported = await runCli(home, ["import", importFile, "--dir", store]);
    assert.equal(imported.code, 0, imported.stderr);
    const duplicate = await runCli(home, ["import", importFile, "--dir", store]);
    assert.equal(duplicate.code, 1);

    const checked = await runCli(home, ["check", "--dir", store]);
    assert.equal(checked.code, 0, checked.stderr);
    assert.equal(checked.stderr, "");

    const confluence = await runCli(home, [
      "confluence",
      "--dir",
      store,
      "--base-url",
      "https://example.atlassian.net",
      "--space",
      "ENG",
      "--parent",
      "123",
    ]);
    assert.equal(confluence.code, 0, confluence.stderr);
    assert.match((await runCli(home, ["where", "--dir", store])).stdout, /Confluence: on/);
    const published = await runCli(home, ["publish", prefix, "--dir", store]);
    assert.equal(published.code, 1);
    assert.match(published.stderr, /CONFLUENCE_EMAIL/);
    const off = await runCli(home, ["confluence", "--off", "--dir", store]);
    assert.equal(off.code, 0, off.stderr);
    assert.match((await runCli(home, ["where", "--dir", store])).stdout, /Confluence: off/);

    const marker = await readFile(path.join(store, ".decision.json"), "utf8");
    assert.equal(marker.includes("Ada"), false);
    await rm(home, { recursive: true, force: true });
  });

  it("serves decision open without launching a browser", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "decision-open-"));
    const store = path.join(home, "store");
    await runCli(home, ["init", "--dir", store]);
    const child = spawn(process.execPath, [cli, "open", "--dir", store], {
      cwd: home,
      env: { ...process.env, HOME: home },
    });
    const url = await readUrl(child);
    try {
      const denied = await fetch(url.replace(/\?token.*/, "/api/records"));
      assert.equal(denied.status, 401);
      const page = await fetch(url);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /Decisions/);
    } finally {
      child.kill("SIGTERM");
      await onceExit(child);
      await rm(home, { recursive: true, force: true });
    }
  });

  it("creates a proposal through the MCP server", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "decision-mcp-"));
    const store = path.join(home, "store");
    await runCli(home, ["init", "--dir", store]);
    const child = spawn(process.execPath, [cli, "mcp"], {
      cwd: home,
      env: { ...process.env, HOME: home, DECISION_DIR: store },
    });
    try {
      const starting = readRpc(child, 1);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "0.0.0" },
        },
      })}\n`);
      const started = await starting;
      assert.equal(started.id, 1);
      const creating = readRpc(child, 2);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "create_proposal", arguments: { decision: "Review on Thursday", client: "test" } },
      })}\n`);
      const created = await creating;
      assert.equal(created.id, 2);
      const listed = await runCli(home, ["list", "--dir", store]);
      const prefix = idOf(listed.stdout, "Review on Thursday");
      const shown = JSON.parse((await runCli(home, ["show", prefix, "--json", "--dir", store])).stdout) as {
        status: string;
        recordedBy: string;
      };
      assert.equal(shown.status, "proposed");
      assert.equal(shown.recordedBy, "mcp:test");
    } finally {
      child.kill("SIGTERM");
      await onceExit(child);
      await rm(home, { recursive: true, force: true });
    }
  });
});

function readUrl(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for the local URL.\n${stdout}`)), 5000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[a-f0-9]+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    child.on("exit", () => {
      clearTimeout(timer);
      reject(new Error(`decision open exited early.\n${stdout}`));
    });
  });
}

function readRpc(child: ChildProcess, id: number): Promise<{ id: number }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for MCP response ${id}.\n${stdout}`)), 5000);
    child.stdout?.setEncoding("utf8");
    const onData = (chunk: string) => {
      stdout += chunk;
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line) as { id?: number };
          if (message.id === id) {
            clearTimeout(timer);
            child.stdout?.off("data", onData);
            resolve(message as { id: number });
          }
        } catch {
          // Partial JSON is completed by a later chunk.
        }
      }
    };
    child.stdout?.on("data", onData);
  });
}

function onceExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}
