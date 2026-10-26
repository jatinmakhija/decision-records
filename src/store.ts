import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type DecisionRecord,
  type Issue,
  type Status,
  SCHEMA_VERSION,
  assertTransition,
  decisionTextChanged,
  enrichedBody,
  linkWarnings,
  nowUtc,
  parseRecord,
  searchableText,
  slugify,
  todayUtc,
  validateRecord,
  writeRecord,
} from "./core.js";

export interface StoreConfig {
  schemaVersion: string;
  defaultFormat: "md" | "json";
  suggestedTags: string[];
  capture: "short" | "enriched";
  confluence: {
    enabled: boolean;
    baseUrl?: string;
    spaceKey?: string;
    parentPageId?: string;
  };
}

export interface LocatedStore {
  root: string;
  reason: "dir" | "env" | "project" | "personal";
  config: StoreConfig;
}

export interface StoredRecord {
  record: DecisionRecord;
  filePath: string;
  format: "md" | "json";
  mtimeMs: number;
}

export interface CreateInput {
  decision: string;
  status?: Status;
  body?: string;
  enriched?: boolean;
  recordedBy?: string;
  format?: "md" | "json";
  supersedes?: string[];
  id?: string;
  createdAt?: string;
  decidedAt?: string;
  deciders?: string[];
  participants?: string[];
  tags?: string[];
  sources?: string[];
  related?: string[];
  supersededBy?: string[];
  extras?: Array<[string, unknown]>;
}

const MARKER = ".decision.json";
const PERSONAL_NOTICE = "Created personal store";

export function personalStorePath(home = os.homedir()): string {
  return path.join(home, "Decisions");
}

export function configPath(home = os.homedir()): string {
  return path.join(home, ".config", "decision", "config.json");
}

export async function readRecorderConfig(home = os.homedir()): Promise<{ recordedBy?: string }> {
  try {
    const text = await readFile(configPath(home), "utf8");
    const parsed = JSON.parse(text) as { recordedBy?: unknown };
    if (typeof parsed.recordedBy === "string" && parsed.recordedBy.trim()) {
      return { recordedBy: parsed.recordedBy.trim() };
    }
  } catch {
    return {};
  }
  return {};
}

export async function writeRecorderConfig(recordedBy: string, home = os.homedir()): Promise<void> {
  const file = configPath(home);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ recordedBy }, null, 2)}\n`, "utf8");
}

function defaultConfig(): StoreConfig {
  return {
    schemaVersion: SCHEMA_VERSION,
    defaultFormat: "md",
    suggestedTags: [],
    capture: "short",
    confluence: { enabled: false },
  };
}

export function parseStoreConfig(text: string): StoreConfig {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const config = defaultConfig();
  if (parsed.defaultFormat === "json") config.defaultFormat = "json";
  if (parsed.capture === "enriched") config.capture = "enriched";
  if (Array.isArray(parsed.suggestedTags)) {
    config.suggestedTags = parsed.suggestedTags.filter((tag): tag is string => typeof tag === "string");
  }
  if (parsed.confluence && typeof parsed.confluence === "object") {
    const confluence = parsed.confluence as Record<string, unknown>;
    config.confluence = {
      enabled: confluence.enabled === true,
      baseUrl: typeof confluence.baseUrl === "string" ? confluence.baseUrl : undefined,
      spaceKey: typeof confluence.spaceKey === "string" ? confluence.spaceKey : undefined,
      parentPageId: typeof confluence.parentPageId === "string" ? confluence.parentPageId : undefined,
    };
  }
  return config;
}

export async function readStoreConfig(root: string): Promise<StoreConfig> {
  try {
    return parseStoreConfig(await readFile(path.join(root, MARKER), "utf8"));
  } catch {
    return defaultConfig();
  }
}

export async function writeStoreConfig(root: string, config: StoreConfig): Promise<void> {
  const payload: Record<string, unknown> = {
    schemaVersion: SCHEMA_VERSION,
    defaultFormat: config.defaultFormat,
  };
  if (config.capture === "enriched") payload.capture = "enriched";
  if (config.suggestedTags.length > 0) payload.suggestedTags = config.suggestedTags;
  if (config.confluence.enabled) payload.confluence = { ...config.confluence, enabled: true };
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, MARKER), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function markerExists(dir: string): Promise<boolean> {
  try {
    const info = await stat(path.join(dir, MARKER));
    return info.isFile();
  } catch {
    return false;
  }
}

export async function findProjectStore(start: string): Promise<string | undefined> {
  let current = path.resolve(start);
  for (;;) {
    if (await markerExists(path.join(current, "decisions"))) return path.join(current, "decisions");
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export async function locateStore(options: {
  dir?: string;
  env?: string;
  cwd?: string;
  home?: string;
}): Promise<LocatedStore> {
  const home = options.home ?? os.homedir();
  if (options.dir) {
    const root = path.resolve(options.dir);
    return { root, reason: "dir", config: await readStoreConfig(root) };
  }
  if (options.env) {
    const root = path.resolve(options.env);
    return { root, reason: "env", config: await readStoreConfig(root) };
  }
  const project = await findProjectStore(options.cwd ?? process.cwd());
  if (project) return { root: project, reason: "project", config: await readStoreConfig(project) };
  const root = personalStorePath(home);
  return { root, reason: "personal", config: await readStoreConfig(root) };
}

export async function initStore(root: string, config: Partial<StoreConfig> = {}): Promise<void> {
  const next = { ...defaultConfig(), ...config, confluence: { ...defaultConfig().confluence, ...config.confluence } };
  await writeStoreConfig(root, next);
}

async function walk(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.isFile() && (entry.name.endsWith(".md") || entry.name.endsWith(".json"))) files.push(full);
  }
  return files;
}

export async function loadStore(root: string): Promise<StoredRecord[]> {
  const files = await walk(root);
  const loaded: StoredRecord[] = [];
  for (const filePath of files) {
    loaded.push(await readStored(filePath));
  }
  return loaded;
}

export async function readStored(filePath: string): Promise<StoredRecord> {
  const format = filePath.endsWith(".json") ? "json" : "md";
  const text = await readFile(filePath, "utf8");
  const info = await stat(filePath);
  return { record: parseRecord(text, format), filePath, format, mtimeMs: info.mtimeMs };
}

export function resolveId(records: StoredRecord[], idOrPrefix: string): StoredRecord {
  const exact = records.find((item) => item.record.id === idOrPrefix);
  if (exact) return exact;
  const matches = records.filter((item) => item.record.id.startsWith(idOrPrefix));
  if (matches.length === 1) return matches[0] as StoredRecord;
  if (matches.length === 0) throw new Error(`No record matches "${idOrPrefix}".`);
  throw new Error(`"${idOrPrefix}" matches more than one record.`);
}

async function atomicWrite(filePath: string, text: string): Promise<void> {
  const temp = `${filePath}.${process.pid}.tmp`;
  await writeFile(temp, text, "utf8");
  await rename(temp, filePath);
}

export async function saveStored(item: StoredRecord, expectedMtime?: number): Promise<StoredRecord> {
  if (expectedMtime !== undefined) {
    try {
      const info = await stat(item.filePath);
      if (info.mtimeMs !== expectedMtime) {
        throw new Error(`Refusing to overwrite ${item.filePath}. It changed on disk.`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await mkdir(path.dirname(item.filePath), { recursive: true });
  await atomicWrite(item.filePath, writeRecord(item.record, item.format));
  const info = await stat(item.filePath);
  return { ...item, mtimeMs: info.mtimeMs };
}

function fileName(createdAt: string, decision: string, id: string, format: "md" | "json"): string {
  const date = createdAt.slice(0, 10);
  const ext = format === "json" ? ".json" : ".md";
  return `${date}-${slugify(decision)}-${id}${ext}`;
}

export async function createRecord(root: string, config: StoreConfig, input: CreateInput): Promise<StoredRecord> {
  const createdAt = input.createdAt ?? nowUtc();
  const format = input.format ?? config.defaultFormat;
  const enriched = input.enriched ?? (config.capture === "enriched" && input.body === undefined);
  const body = input.body !== undefined ? input.body : enriched ? enrichedBody() : "";
  const record: DecisionRecord = {
    schemaVersion: SCHEMA_VERSION,
    id: input.id ?? randomUUID(),
    decision: input.decision,
    status: input.status ?? "decided",
    createdAt,
    extras: input.extras ?? [],
    body,
  };
  if (input.recordedBy) record.recordedBy = input.recordedBy;
  if (input.decidedAt) record.decidedAt = input.decidedAt;
  if (input.deciders?.length) record.deciders = input.deciders;
  if (input.participants?.length) record.participants = input.participants;
  if (input.tags?.length) record.tags = input.tags;
  if (input.sources?.length) record.sources = input.sources;
  if (input.supersedes?.length) record.supersedes = input.supersedes;
  if (input.supersededBy?.length) record.supersededBy = input.supersededBy;
  if (input.related?.length) record.related = input.related;
  const filePath = path.join(root, fileName(createdAt, input.decision, record.id, format));
  return saveStored({ record, filePath, format, mtimeMs: 0 });
}

export async function updateRecord(
  item: StoredRecord,
  next: DecisionRecord,
  expectedMtime?: number,
): Promise<{ stored: StoredRecord; warned: boolean }> {
  const warned = decisionTextChanged(item.record, next);
  next.updatedAt = nowUtc();
  const stored = await saveStored({ ...item, record: next }, expectedMtime);
  return { stored, warned };
}

export async function transition(
  root: string,
  item: StoredRecord,
  status: Status,
  extra: Partial<DecisionRecord> = {},
): Promise<StoredRecord> {
  assertTransition(item.record.status, status);
  const next: DecisionRecord = { ...item.record, ...extra, status, extras: item.record.extras };
  if (status === "decided") next.decidedAt = extra.decidedAt ?? todayUtc();
  if (status === "proposed") delete next.decidedAt;
  const { stored } = await updateRecord(item, next, item.mtimeMs);
  void root;
  return stored;
}

export async function supersede(
  root: string,
  config: StoreConfig,
  item: StoredRecord,
  decision: string,
  options: Omit<CreateInput, "decision" | "supersedes" | "status"> = {},
): Promise<{ previous: StoredRecord; next: StoredRecord }> {
  assertTransition(item.record.status, "superseded");
  const created = await createRecord(root, config, {
    ...options,
    decision,
    status: "decided",
    supersedes: [item.record.id],
  });
  const previousRecord: DecisionRecord = {
    ...item.record,
    status: "superseded",
    supersededBy: [...(item.record.supersededBy ?? []), created.record.id],
  };
  const { stored } = await updateRecord(item, previousRecord, item.mtimeMs);
  return { previous: stored, next: created };
}

export interface SearchQuery {
  text?: string;
  status?: Status;
  tags?: string[];
  decider?: string;
  since?: string;
  until?: string;
}

export function searchRecords(records: StoredRecord[], query: SearchQuery): StoredRecord[] {
  const needle = query.text?.trim().toLowerCase();
  const filtered = records.filter((item) => {
    const record = item.record;
    if (query.status && record.status !== query.status) return false;
    if (query.tags && query.tags.length > 0) {
      const tags = new Set(record.tags ?? []);
      if (!query.tags.every((tag) => tags.has(tag))) return false;
    }
    if (query.decider) {
      const names = (record.deciders ?? []).join("\n").toLowerCase();
      if (!names.includes(query.decider.toLowerCase())) return false;
    }
    const day = record.createdAt.slice(0, 10);
    if (query.since && day < query.since) return false;
    if (query.until && day > query.until) return false;
    if (!needle) return true;
    const sentence = record.decision.toLowerCase();
    const rest = searchableText(record).toLowerCase().replace(sentence, "");
    return sentence.includes(needle) || rest.includes(needle);
  });
  const score = (item: StoredRecord) => {
    if (!needle) return 0;
    return item.record.decision.toLowerCase().includes(needle) ? 0 : 1;
  };
  return filtered.sort((a, b) => {
    const rank = score(a) - score(b);
    if (rank !== 0) return rank;
    return b.record.createdAt.localeCompare(a.record.createdAt);
  });
}

export function checkRecords(records: StoredRecord[]): Array<Issue & { file: string }> {
  const issues: Array<Issue & { file: string }> = [];
  const seen = new Map<string, string>();
  for (const item of records) {
    const previous = seen.get(item.record.id);
    if (previous) {
      issues.push({
        level: "error",
        file: item.filePath,
        message: `Duplicate id ${item.record.id} also appears in ${previous}.`,
      });
    }
    seen.set(item.record.id, item.filePath);
    try {
      for (const issue of validateRecord(item.record)) {
        issues.push({ ...issue, file: item.filePath });
      }
    } catch (error) {
      issues.push({ level: "error", file: item.filePath, message: (error as Error).message });
    }
  }
  for (const issue of linkWarnings(records.map((item) => item.record))) {
    issues.push({ ...issue, file: "" });
  }
  return issues;
}

export async function removeFile(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
}
