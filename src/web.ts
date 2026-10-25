import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendSource, publishPage, targetFromConfig } from "./confluence.js";
import {
  type DecisionRecord,
  type Status,
  SECTIONS,
  isStatus,
  splitSections,
  toData,
} from "./core.js";
import {
  createRecord,
  loadStore,
  readStoreConfig,
  resolveId,
  searchRecords,
  supersede,
  transition,
  updateRecord,
  type StoredRecord,
} from "./store.js";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "web", "public");

export interface RunningServer {
  url: string;
  port: number;
  token: string;
  close: () => Promise<void>;
}

export async function startServer(root: string, port = 0): Promise<RunningServer> {
  const token = randomBytes(16).toString("hex");
  const server = createServer((req, res) => {
    void handle(req, res, root, token).catch((error: Error) => {
      sendJson(res, 500, { error: error.message });
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not bind the local server.");
  const actual = address.port;
  const url = `http://127.0.0.1:${actual}/?token=${token}`;
  return {
    url,
    port: actual,
    token,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function handle(req: IncomingMessage, res: ServerResponse, root: string, token: string): Promise<void> {
  const host = req.headers.host ?? "";
  if (!/^127\.0\.0\.1:\d+$/.test(host) && !/^localhost:\d+$/.test(host)) {
    sendJson(res, 403, { error: "This server only answers on localhost." });
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const cookie = /(?:^|; )decision_token=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
  const presented = url.searchParams.get("token") ?? cookie ?? bearer(req);
  if (presented !== token) {
    sendJson(res, 401, { error: "Missing session token." });
    return;
  }
  if (url.searchParams.get("token") === token) {
    res.setHeader("set-cookie", `decision_token=${token}; HttpOnly; SameSite=Strict; Path=/`);
  }
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    await sendFile(res, path.join(PUBLIC_DIR, "index.html"), "text/html; charset=utf-8");
    return;
  }
  if (req.method === "GET" && url.pathname === "/app.js") {
    await sendFile(res, path.join(PUBLIC_DIR, "app.js"), "text/javascript; charset=utf-8");
    return;
  }
  if (req.method === "GET" && url.pathname === "/app.css") {
    await sendFile(res, path.join(PUBLIC_DIR, "app.css"), "text/css; charset=utf-8");
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/meta") {
    const config = await readStoreConfig(root);
    sendJson(res, 200, {
      root,
      suggestedTags: config.suggestedTags,
      confluence: config.confluence.enabled,
      sections: SECTIONS,
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/records") {
    const records = await loadStore(root);
    const found = searchRecords(records, {
      text: url.searchParams.get("q") ?? undefined,
      status: statusParam(url.searchParams.get("status")),
      tags: url.searchParams.getAll("tag"),
    });
    sendJson(res, 200, found.map(present));
    return;
  }
  const one = /^\/api\/records\/([^/]+)$/.exec(url.pathname);
  const action = /^\/api\/records\/([^/]+)\/(transition|publish|open)$/.exec(url.pathname);
  if (req.method === "POST" && url.pathname === "/api/records") {
    const body = await readBody(req);
    const decision = String(body.decision ?? "").trim();
    if (!decision) {
      sendJson(res, 400, { error: "A decision sentence is required." });
      return;
    }
    const config = await readStoreConfig(root);
    const stored = await createRecord(root, config, {
      decision,
      status: body.proposed === true ? "proposed" : "decided",
      enriched: body.enriched === true,
      recordedBy: typeof body.recordedBy === "string" ? body.recordedBy : undefined,
      format: body.format === "json" ? "json" : undefined,
    });
    sendJson(res, 201, { record: present(stored), confluence: config.confluence.enabled });
    return;
  }
  if (req.method === "GET" && one) {
    const records = await loadStore(root);
    sendJson(res, 200, present(resolveId(records, decodeURIComponent(one[1] ?? ""))));
    return;
  }
  if (req.method === "PUT" && one) {
    const records = await loadStore(root);
    const current = resolveId(records, decodeURIComponent(one[1] ?? ""));
    const body = await readBody(req);
    const next = applyEdit(current.record, body);
    const expected = typeof body.mtimeMs === "number" ? body.mtimeMs : current.mtimeMs;
    const saved = await updateRecord(current, next, expected);
    const config = await readStoreConfig(root);
    sendJson(res, 200, {
      record: present(saved.stored),
      warned: saved.warned,
      confluence: config.confluence.enabled,
    });
    return;
  }
  if (req.method === "POST" && action?.[2] === "transition") {
    const records = await loadStore(root);
    const current = resolveId(records, decodeURIComponent(action[1] ?? ""));
    const body = await readBody(req);
    const status = String(body.status ?? "");
    if (!isStatus(status)) {
      sendJson(res, 400, { error: "Unknown status." });
      return;
    }
    if (status === "superseded") {
      const decision = String(body.decision ?? "").trim();
      if (!decision) {
        sendJson(res, 400, { error: "Superseding needs the new decision sentence." });
        return;
      }
      const config = await readStoreConfig(root);
      const result = await supersede(root, config, current, decision);
      sendJson(res, 200, { record: present(result.next), confluence: config.confluence.enabled });
      return;
    }
    const stored = await transition(root, current, status);
    const config = await readStoreConfig(root);
    sendJson(res, 200, { record: present(stored), confluence: config.confluence.enabled });
    return;
  }
  if (req.method === "POST" && action?.[2] === "publish") {
    const records = await loadStore(root);
    const current = resolveId(records, decodeURIComponent(action[1] ?? ""));
    const config = await readStoreConfig(root);
    const url = await publishPage(current.record, targetFromConfig(config.confluence));
    const saved = await updateRecord(current, appendSource(current.record, url), current.mtimeMs);
    sendJson(res, 200, { record: present(saved.stored), url });
    return;
  }
  if (req.method === "POST" && action?.[2] === "open") {
    const records = await loadStore(root);
    const current = resolveId(records, decodeURIComponent(action[1] ?? ""));
    const relative = path.relative(root, current.filePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      sendJson(res, 400, { error: "That file is outside the store." });
      return;
    }
    spawn("open", [current.filePath], { stdio: "ignore", detached: true }).unref();
    sendJson(res, 200, { path: current.filePath });
    return;
  }
  sendJson(res, 404, { error: "Not found." });
}

function statusParam(value: string | null): Status | undefined {
  if (!value) return undefined;
  return isStatus(value) ? value : undefined;
}

function present(item: StoredRecord) {
  const sections = Object.fromEntries(splitSections(item.record.body).map((section) => [section.name, section.text]));
  return {
    ...toData(item.record),
    file: item.filePath,
    mtimeMs: item.mtimeMs,
    format: item.format,
    sections,
  };
}

function applyEdit(record: DecisionRecord, body: Record<string, unknown>): DecisionRecord {
  const next: DecisionRecord = { ...record, extras: record.extras };
  if (typeof body.decision === "string" && body.decision.trim()) next.decision = body.decision.trim();
  for (const key of ["deciders", "participants", "tags", "sources"] as const) {
    if (Array.isArray(body[key])) {
      const values = (body[key] as unknown[]).map(String).map((item) => item.trim()).filter(Boolean);
      if (values.length) next[key] = values;
      else delete next[key];
    }
  }
  if (body.sections && typeof body.sections === "object") {
    const sections = body.sections as Record<string, unknown>;
    const chunks: string[] = [];
    for (const name of SECTIONS) {
      const text = typeof sections[name] === "string" ? sections[name].trim() : "";
      if (text) chunks.push(`## ${name}\n\n${text}\n`);
    }
    next.body = chunks.join("\n");
  }
  return next;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7) : undefined;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function sendFile(res: ServerResponse, filePath: string, type: string): Promise<void> {
  const text = await readFile(filePath);
  res.writeHead(200, { "content-type": type, "content-length": text.length });
  res.end(text);
}
