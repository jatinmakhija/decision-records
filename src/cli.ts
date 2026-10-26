#!/usr/bin/env node
import { spawn } from "node:child_process";
import readline from "node:readline/promises";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { askShouldPublish, appendSource, publishPage, targetFromConfig } from "./confluence.js";
import {
  type DecisionRecord,
  type Status,
  isStatus,
  parseJson,
  toData,
  writeJson,
  writeMarkdown,
} from "./core.js";
import { startServer } from "./web.js";
import { startMcp } from "./mcp.js";
import {
  type LocatedStore,
  type StoredRecord,
  checkRecords,
  createRecord,
  initStore,
  loadStore,
  locateStore,
  readRecorderConfig,
  readStored,
  resolveId,
  searchRecords,
  supersede,
  transition,
  updateRecord,
  writeRecorderConfig,
  writeStoreConfig,
} from "./store.js";

const HELP = `decision — local decision records

Usage:
  decision init
  decision new "<sentence>" [--proposed] [--enriched | --short] [--edit] [--by name]
  decision list [--status s] [--tag t] [--json]
  decision show <id> [--json]
  decision search "<query>" [--status s] [--tag t] [--decider name] [--since date] [--until date]
  decision edit [id]
  decision decide <id>
  decision reject <id>
  decision revoke <id>
  decision supersede <id> "<sentence>"
  decision check [path] [--strict]
  decision export [--json] [--id id]
  decision import <file.json>
  decision open
  decision where
  decision confluence --base-url URL --space KEY --parent ID
  decision confluence --off
  decision publish <id>
  decision mcp
  decision help [fields]

Flags shared by write commands: --dir, --publish, --no-publish, --format md|json.
See docs/cli.md for the full reference.
`;

const FIELDS = `Decision       The choice, in one sentence.
Context        The situation at the time. Not the reasoning.
Rationale      Why this option won.
Alternatives   Options you seriously considered.
Consequences   What follows, including downsides.
Deciders       People accountable for the choice.
Participants   People present who did not decide.
Recorded by    Who wrote this down.
`;

interface Flags {
  dir?: string;
  proposed: boolean;
  enriched: boolean;
  short: boolean;
  edit: boolean;
  by?: string;
  publish: boolean;
  noPublish: boolean;
  format?: "md" | "json";
  status?: string;
  tags: string[];
  json: boolean;
  decider?: string;
  since?: string;
  until?: string;
  id?: string;
  strict: boolean;
  baseUrl?: string;
  space?: string;
  parent?: string;
  off: boolean;
  help: boolean;
}

function readFlags(argv: string[]): { flags: Flags; positionals: string[] } {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      dir: { type: "string" },
      proposed: { type: "boolean", default: false },
      enriched: { type: "boolean", default: false },
      short: { type: "boolean", default: false },
      edit: { type: "boolean", default: false },
      by: { type: "string" },
      publish: { type: "boolean", default: false },
      "no-publish": { type: "boolean", default: false },
      format: { type: "string" },
      status: { type: "string" },
      tag: { type: "string", multiple: true },
      json: { type: "boolean", default: false },
      decider: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      id: { type: "string" },
      strict: { type: "boolean", default: false },
      "base-url": { type: "string" },
      space: { type: "string" },
      parent: { type: "string" },
      off: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  const format = values.format === "json" || values.format === "md" ? values.format : undefined;
  if (values.format && !format) throw new Error("--format must be md or json.");
  return {
    positionals,
    flags: {
      dir: values.dir,
      proposed: values.proposed,
      enriched: values.enriched,
      short: values.short,
      edit: values.edit,
      by: values.by,
      publish: values.publish,
      noPublish: values["no-publish"],
      format,
      status: values.status,
      tags: values.tag ?? [],
      json: values.json,
      decider: values.decider,
      since: values.since,
      until: values.until,
      id: values.id,
      strict: values.strict,
      baseUrl: values["base-url"],
      space: values.space,
      parent: values.parent,
      off: values.off,
      help: values.help,
    },
  };
}

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

async function recorder(flags: Flags, home: string): Promise<{ name: string; fallback: boolean }> {
  if (flags.by) return { name: flags.by, fallback: false };
  if (process.env.DECISION_RECORDED_BY) return { name: process.env.DECISION_RECORDED_BY, fallback: false };
  const saved = await readRecorderConfig(home);
  if (saved.recordedBy) return { name: saved.recordedBy, fallback: false };
  return { name: os.userInfo().username, fallback: true };
}

async function openStore(flags: Flags, home: string): Promise<LocatedStore> {
  return locateStore({
    dir: flags.dir,
    env: flags.dir ? undefined : process.env.DECISION_DIR,
    cwd: process.cwd(),
    home,
  });
}

async function ensureMarker(located: LocatedStore): Promise<void> {
  const marker = path.join(located.root, ".decision.json");
  try {
    await stat(marker);
  } catch {
    await initStore(located.root, located.config);
    if (located.reason === "personal") {
      process.stderr.write(`Created personal store at ${located.root}\n`);
    }
  }
}

function printSaved(filePath: string, fallbackName?: string): void {
  if (fallbackName) process.stdout.write(`Recording as ${fallbackName}\n`);
  process.stdout.write(`Saved to ${filePath}\n`);
}

async function maybePublish(
  located: LocatedStore,
  stored: StoredRecord,
  flags: Flags,
): Promise<void> {
  if (!located.config.confluence.enabled && !flags.publish) return;
  const should = askShouldPublish({
    publish: flags.publish,
    noPublish: flags.noPublish,
    isTTY: Boolean(process.stdin.isTTY),
    answer: process.stdin.isTTY && !flags.publish && !flags.noPublish
      ? await prompt("Publish to Confluence? [y/N] ")
      : "",
  });
  if (!should) return;
  try {
    const url = await publishPage(stored.record, targetFromConfig(located.config.confluence));
    const next = appendSource(stored.record, url);
    if (next !== stored.record) {
      const saved = await updateRecord({ ...stored, record: stored.record }, next, stored.mtimeMs);
      process.stdout.write(`Published ${saved.stored.filePath}\n${url}\n`);
    } else {
      process.stdout.write(`Published ${stored.filePath}\n${url}\n`);
    }
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    if (flags.publish) process.exitCode = 1;
  }
}

function openInBrowser(url: string): void {
  if (!process.stdout.isTTY) return;
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", () => {
    process.stderr.write(`Open this address in a browser: ${url}\n`);
  });
  child.unref();
}

async function openEditor(filePath: string): Promise<void> {
  const editor = process.env.EDITOR || "vi";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(editor, [filePath], { stdio: "inherit" });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${editor} exited ${code}.`))));
    child.on("error", reject);
  });
}

function requireStatus(value: string | undefined): Status | undefined {
  if (!value) return undefined;
  if (!isStatus(value)) throw new Error(`Unknown status "${value}".`);
  return value;
}

function formatList(items: StoredRecord[], asJson: boolean): void {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(items.map((item) => ({ ...toData(item.record), file: item.filePath })), null, 2)}\n`);
    return;
  }
  for (const item of items) {
    const tags = item.record.tags?.length ? `  ${item.record.tags.join(", ")}` : "";
    process.stdout.write(`${item.record.id.slice(0, 8)}  ${item.record.createdAt.slice(0, 10)}  ${item.record.status.padEnd(11)} ${item.record.decision}${tags}\n`);
  }
}

async function commandNew(located: LocatedStore, sentence: string, flags: Flags, home: string): Promise<void> {
  if (!sentence.trim()) throw new Error("decision new needs the decision sentence.");
  await ensureMarker(located);
  const who = await recorder(flags, home);
  const enriched = flags.short ? false : flags.enriched ? true : undefined;
  const stored = await createRecord(located.root, located.config, {
    decision: sentence.trim(),
    status: flags.proposed ? "proposed" : "decided",
    recordedBy: who.name,
    enriched,
    format: flags.format,
  });
  printSaved(stored.filePath, who.fallback ? who.name : undefined);
  if (flags.edit) await openEditor(stored.filePath);
  const fresh = await readStored(stored.filePath);
  await maybePublish({ ...located, config: await reload(located) }, fresh, flags);
}

async function reload(located: LocatedStore): Promise<LocatedStore["config"]> {
  const again = await locateStore({ dir: located.root, home: os.homedir() });
  return again.config;
}

async function main(argv: string[]): Promise<void> {
  const { flags, positionals } = readFlags(argv);
  const command = positionals[0] ?? (flags.help ? "help" : "");
  if (!command || command === "help" || command === "fields" || flags.help) {
    process.stdout.write(positionals[1] === "fields" || positionals[0] === "fields" ? FIELDS : HELP);
    return;
  }
  const home = os.homedir();
  if (command === "mcp") {
    await startMcp();
    return;
  }
  if (command === "init") {
    const root = flags.dir
      ? path.resolve(flags.dir)
      : path.join(process.cwd(), "decisions");
    await initStore(root);
    let saved = await readRecorderConfig(home);
    if (!saved.recordedBy && !process.env.DECISION_RECORDED_BY) {
      const username = os.userInfo().username;
      if (process.stdin.isTTY) {
        const answer = (await prompt(`Your name [${username}]: `)).trim();
        await writeRecorderConfig(answer || username, home);
      } else {
        await writeRecorderConfig(username, home);
        process.stdout.write(`Recording as ${username}\n`);
      }
      saved = await readRecorderConfig(home);
    }
    process.stdout.write(`Initialized ${root}\n`);
    if (saved.recordedBy) process.stdout.write(`Recording as ${saved.recordedBy}\n`);
    return;
  }

  const located = await openStore(flags, home);

  if (command === "where") {
    process.stdout.write(
      `Store: ${located.root}\nReason: ${located.reason}\nFormat: ${located.config.defaultFormat}\nConfluence: ${located.config.confluence.enabled ? "on" : "off"}\n`,
    );
    return;
  }
  if (command === "new") {
    await commandNew(located, positionals.slice(1).join(" "), flags, home);
    return;
  }
  if (command === "list" || command === "search") {
    await ensureMarker(located);
    const records = await loadStore(located.root);
    const found = searchRecords(records, {
      text: command === "search" ? positionals.slice(1).join(" ") : undefined,
      status: requireStatus(flags.status),
      tags: flags.tags,
      decider: flags.decider,
      since: flags.since,
      until: flags.until,
    });
    formatList(found, flags.json);
    return;
  }
  if (command === "show") {
    const records = await loadStore(located.root);
    const item = resolveId(records, positionals[1] ?? "");
    process.stdout.write(flags.json ? writeJson(item.record) : writeMarkdown(item.record));
    return;
  }
  if (command === "edit") {
    const records = await loadStore(located.root);
    const item = positionals[1]
      ? resolveId(records, positionals[1])
      : [...records].sort((a, b) => b.record.createdAt.localeCompare(a.record.createdAt))[0];
    if (!item) throw new Error("There are no records to edit.");
    await openEditor(item.filePath);
    return;
  }
  if (command === "decide" || command === "reject" || command === "revoke") {
    const records = await loadStore(located.root);
    const item = resolveId(records, positionals[1] ?? "");
    const status = command === "decide" ? "decided" : command === "reject" ? "rejected" : "revoked";
    const stored = await transition(located.root, item, status);
    printSaved(stored.filePath);
    await maybePublish(located, stored, flags);
    return;
  }
  if (command === "supersede") {
    const records = await loadStore(located.root);
    const item = resolveId(records, positionals[1] ?? "");
    const sentence = positionals.slice(2).join(" ").trim();
    if (!sentence) throw new Error("decision supersede needs the new decision sentence.");
    const who = await recorder(flags, home);
    const result = await supersede(located.root, located.config, item, sentence, {
      recordedBy: who.name,
      enriched: flags.short ? false : flags.enriched ? true : undefined,
      format: flags.format,
    });
    printSaved(result.next.filePath, who.fallback ? who.name : undefined);
    process.stdout.write(`Superseded ${result.previous.filePath}\n`);
    await maybePublish(located, result.next, flags);
    return;
  }
  if (command === "check") {
    const target = positionals[1] ? path.resolve(positionals[1]) : located.root;
    let records: StoredRecord[] = [];
    try {
      const info = await stat(target);
      records = info.isDirectory() ? await loadStore(target) : [await readStored(target)];
    } catch (error) {
      throw new Error((error as Error).message);
    }
    const issues = checkRecords(records);
    for (const issue of issues) {
      const where = issue.file ? `${issue.file}: ` : "";
      process.stderr.write(`${issue.level}: ${where}${issue.message}\n`);
    }
    if (issues.some((issue) => issue.level === "error" || (flags.strict && issue.level === "warning"))) {
      process.exitCode = 1;
    }
    return;
  }
  if (command === "export") {
    const records = await loadStore(located.root);
    const chosen = flags.id ? [resolveId(records, flags.id).record] : records.map((item) => item.record);
    if (flags.id && !flags.json) {
      const one = resolveId(records, flags.id);
      process.stdout.write(writeMarkdown(one.record));
      return;
    }
    const data = chosen.map((record) => toData(record));
    const payload = flags.id ? data[0] : data;
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  if (command === "import") {
    const file = positionals[1];
    if (!file) throw new Error("decision import needs a JSON file.");
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(path.resolve(file), "utf8");
    const record = parseJson(text);
    await ensureMarker(located);
    const existing = await loadStore(located.root);
    if (existing.some((item) => item.record.id === record.id)) {
      throw new Error(`A record with id ${record.id} already exists.`);
    }
    const stored = await createRecord(located.root, located.config, {
      ...recordToInput(record),
      format: flags.format ?? located.config.defaultFormat,
    });
    printSaved(stored.filePath);
    return;
  }
  if (command === "open") {
    await ensureMarker(located);
    const server = await startServer(located.root);
    process.stdout.write(`Open ${server.url}\n`);
    openInBrowser(server.url);
    await new Promise(() => {});
  }
  if (command === "confluence") {
    await ensureMarker(located);
    if (flags.off) {
      located.config.confluence.enabled = false;
      await writeStoreConfig(located.root, located.config);
      process.stdout.write("Confluence off\n");
      return;
    }
    if (!flags.baseUrl || !flags.space || !flags.parent) {
      throw new Error("decision confluence needs --base-url, --space, and --parent.");
    }
    located.config.confluence = {
      enabled: true,
      baseUrl: flags.baseUrl,
      spaceKey: flags.space,
      parentPageId: flags.parent,
    };
    await writeStoreConfig(located.root, located.config);
    process.stdout.write("Confluence on\n");
    return;
  }
  if (command === "publish") {
    const records = await loadStore(located.root);
    const item = resolveId(records, positionals[1] ?? "");
    const url = await publishPage(item.record, targetFromConfig(located.config.confluence));
    const next = appendSource(item.record, url);
    const saved = await updateRecord(item, next, item.mtimeMs);
    process.stdout.write(`Published ${saved.stored.filePath}\n${url}\n`);
    return;
  }
  throw new Error(`Unknown command "${command}".\n${HELP}`);
}

function recordToInput(record: DecisionRecord) {
  return {
    decision: record.decision,
    status: record.status,
    body: record.body,
    recordedBy: record.recordedBy,
    id: record.id,
    createdAt: record.createdAt,
    decidedAt: record.decidedAt,
    deciders: record.deciders,
    participants: record.participants,
    tags: record.tags,
    sources: record.sources,
    supersedes: record.supersedes,
    related: record.related,
    supersededBy: record.supersededBy,
    extras: record.extras,
  };
}

main(process.argv.slice(2)).catch((error: Error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
