import { parse as parseYaml } from "yaml";

export const SCHEMA_VERSION = "0.1";

export const STATUSES = ["proposed", "decided", "rejected", "superseded", "revoked"] as const;
export type Status = (typeof STATUSES)[number];

export const KNOWN_KEYS = [
  "schemaVersion",
  "id",
  "decision",
  "status",
  "createdAt",
  "updatedAt",
  "decidedAt",
  "deciders",
  "participants",
  "recordedBy",
  "tags",
  "sources",
  "supersedes",
  "supersededBy",
  "related",
] as const;

export type KnownKey = (typeof KNOWN_KEYS)[number];

export const SECTIONS = ["Context", "Rationale", "Alternatives", "Consequences"] as const;

const LIST_KEYS = new Set<KnownKey>([
  "deciders",
  "participants",
  "tags",
  "sources",
  "supersedes",
  "supersededBy",
  "related",
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|\+00:00)$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const MOVES: Record<Status, readonly Status[]> = {
  proposed: ["decided", "rejected"],
  decided: ["superseded", "revoked"],
  rejected: [],
  superseded: [],
  revoked: [],
};

export interface DecisionRecord {
  schemaVersion: string;
  id: string;
  decision: string;
  status: Status;
  createdAt: string;
  updatedAt?: string;
  decidedAt?: string;
  deciders?: string[];
  participants?: string[];
  recordedBy?: string;
  tags?: string[];
  sources?: string[];
  supersedes?: string[];
  supersededBy?: string[];
  related?: string[];
  extras: Array<[string, unknown]>;
  body: string;
}

export interface Issue {
  level: "error" | "warning";
  message: string;
}

export class RecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordError";
  }
}

export function quote(value: string): string {
  return JSON.stringify(value);
}

export function nowUtc(date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function todayUtc(date = new Date()): string {
  return nowUtc(date).slice(0, 10);
}

export function slugify(decision: string): string {
  const slug = decision
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || "decision";
}

export function enrichedBody(): string {
  return `${SECTIONS.map((name) => `## ${name}\n`).join("\n")}\n`;
}

export function isStatus(value: string): value is Status {
  return (STATUSES as readonly string[]).includes(value);
}

export function assertTransition(from: Status, to: Status): void {
  if (!MOVES[from].includes(to)) {
    throw new RecordError(`Cannot move from ${from} to ${to}.`);
  }
}

export function parseRecord(text: string, format: "md" | "json"): DecisionRecord {
  if (format === "json") return parseJson(text);
  return parseMarkdown(text);
}

export function writeRecord(record: DecisionRecord, format: "md" | "json"): string {
  return format === "json" ? writeJson(record) : writeMarkdown(record);
}

export function parseMarkdown(text: string): DecisionRecord {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0] !== "---") throw new RecordError("Markdown record must start with ---.");
  let close = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === "---") {
      close = i;
      break;
    }
  }
  if (close === -1) throw new RecordError("Markdown record is missing the closing ---.");
  const front = `${lines.slice(1, close).join("\n")}\n`;
  let body = lines.slice(close + 1).join("\n");
  if (body.startsWith("\n")) body = body.slice(1);
  let parsed: unknown;
  try {
    parsed = parseYaml(front, { schema: "failsafe" });
  } catch (error) {
    throw new RecordError(`Invalid YAML front matter: ${(error as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RecordError("Front matter must be a mapping.");
  }
  return fromFields(parsed as Record<string, unknown>, body);
}

export function parseJson(text: string): DecisionRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new RecordError(`Invalid JSON: ${(error as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RecordError("JSON record must be an object.");
  }
  const fields = { ...(parsed as Record<string, unknown>) };
  const body = fields.body;
  delete fields.body;
  if (body !== undefined && typeof body !== "string") throw new RecordError("body must be a string.");
  return fromFields(fields, body ?? "");
}

function fromFields(fields: Record<string, unknown>, body: string): DecisionRecord {
  const extras: Array<[string, unknown]> = [];
  for (const key of Object.keys(fields)) {
    if (!(KNOWN_KEYS as readonly string[]).includes(key)) extras.push([key, fields[key]]);
  }
  const schemaVersion = requiredString(fields, "schemaVersion");
  const id = requiredString(fields, "id");
  const decision = requiredString(fields, "decision");
  const statusRaw = requiredString(fields, "status");
  const createdAt = requiredString(fields, "createdAt");
  if (!isStatus(statusRaw)) throw new RecordError(`Unknown status "${statusRaw}".`);
  const record: DecisionRecord = {
    schemaVersion,
    id,
    decision,
    status: statusRaw,
    createdAt,
    extras,
    body,
  };
  const updatedAt = optionalString(fields, "updatedAt");
  const decidedAt = optionalString(fields, "decidedAt");
  const recordedBy = optionalString(fields, "recordedBy");
  if (updatedAt !== undefined) record.updatedAt = updatedAt;
  if (decidedAt !== undefined) record.decidedAt = decidedAt;
  if (recordedBy !== undefined) record.recordedBy = recordedBy;
  for (const key of LIST_KEYS) {
    const value = optionalStringList(fields, key);
    if (value !== undefined) (record as unknown as Record<string, unknown>)[key] = value;
  }
  return record;
}

function requiredString(fields: Record<string, unknown>, key: string): string {
  const value = fields[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new RecordError(`${key} is required.`);
  }
  return value;
}

function optionalString(fields: Record<string, unknown>, key: string): string | undefined {
  if (!(key in fields) || fields[key] === undefined || fields[key] === null) return undefined;
  if (typeof fields[key] !== "string") throw new RecordError(`${key} must be a string.`);
  return fields[key] as string;
}

function optionalStringList(fields: Record<string, unknown>, key: string): string[] | undefined {
  if (!(key in fields) || fields[key] === undefined || fields[key] === null) return undefined;
  const value = fields[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new RecordError(`${key} must be a list of strings.`);
  }
  return value;
}

function emit(value: unknown, indent: number): string[] {
  const pad = "  ".repeat(indent);
  if (typeof value === "string") return [`${pad}${quote(value)}`];
  if (typeof value === "number" || typeof value === "boolean") return [`${pad}${quote(String(value))}`];
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}[]`];
    return value.flatMap((item) => {
      if (typeof item === "string") return [`${pad}- ${quote(item)}`];
      if (item !== null && typeof item === "object") {
        const nested = emit(item, indent + 1);
        return [`${pad}-`, ...nested];
      }
      return [`${pad}- ${quote(String(item))}`];
    });
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return [`${pad}{}`];
    return entries.flatMap(([key, inner]) => {
      if (typeof inner === "string") return [`${pad}${key}: ${quote(inner)}`];
      if (Array.isArray(inner) || (inner !== null && typeof inner === "object")) {
        return [`${pad}${key}:`, ...emit(inner, indent + 1)];
      }
      return [`${pad}${key}: ${quote(String(inner))}`];
    });
  }
  return [`${pad}${quote(String(value))}`];
}

function frontMatterLines(record: DecisionRecord): string[] {
  const lines: string[] = [];
  const push = (key: string, value: unknown) => {
    if (value === undefined) return;
    if (Array.isArray(value) && value.length === 0) return;
    if (typeof value === "string") {
      lines.push(`${key}: ${quote(value)}`);
      return;
    }
    lines.push(`${key}:`, ...emit(value, 1));
  };
  for (const key of KNOWN_KEYS) push(key, record[key]);
  for (const [key, value] of record.extras) push(key, value);
  return lines;
}

export function writeMarkdown(record: DecisionRecord): string {
  const head = ["---", ...frontMatterLines(record), "---"].join("\n");
  if (record.body.length === 0) return `${head}\n`;
  const body = record.body.endsWith("\n") ? record.body : `${record.body}\n`;
  return `${head}\n\n${body}`;
}

export function toData(record: DecisionRecord): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const key of KNOWN_KEYS) {
    const value = record[key];
    if (value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    data[key] = value;
  }
  for (const [key, value] of record.extras) data[key] = value;
  data.body = record.body;
  return data;
}

export function writeJson(record: DecisionRecord): string {
  return `${JSON.stringify(toData(record), null, 2)}\n`;
}

export function validateRecord(record: DecisionRecord): Issue[] {
  const issues: Issue[] = [];
  const error = (message: string) => issues.push({ level: "error", message });
  const warning = (message: string) => issues.push({ level: "warning", message });

  if (record.schemaVersion !== SCHEMA_VERSION) {
    error(`Unsupported schemaVersion "${record.schemaVersion}". This tool reads 0.1.`);
  }
  if (!UUID_RE.test(record.id)) error(`id must be a lowercase UUID.`);
  if (!record.decision.trim()) error("decision must not be empty.");
  if (record.decision.includes("\n")) error("decision must be a single line.");
  if (record.decision.length > 200) warning("decision is longer than 200 characters.");
  if (!isStatus(record.status)) error(`Unknown status "${record.status}".`);
  if (!INSTANT_RE.test(record.createdAt)) error("createdAt must be an RFC 3339 UTC timestamp.");
  if (record.updatedAt !== undefined && !INSTANT_RE.test(record.updatedAt)) {
    error("updatedAt must be an RFC 3339 UTC timestamp.");
  }
  if (record.decidedAt !== undefined && !DAY_RE.test(record.decidedAt)) {
    error("decidedAt must be YYYY-MM-DD.");
  }
  if (record.status === "proposed" && record.decidedAt !== undefined) {
    error("decidedAt is not allowed while status is proposed.");
  }
  if (record.status === "superseded" && (!record.supersededBy || record.supersededBy.length === 0)) {
    error("superseded records must set supersededBy.");
  }
  for (const key of ["supersedes", "supersededBy", "related"] as const) {
    for (const id of record[key] ?? []) {
      if (!UUID_RE.test(id)) error(`${key} contains an invalid UUID.`);
    }
  }
  for (const [key] of record.extras) {
    if (!key.startsWith("x-")) warning(`Unknown field "${key}". Use an x- prefix for extensions.`);
  }
  return issues;
}

export function linkWarnings(records: DecisionRecord[]): Issue[] {
  const ids = new Set(records.map((record) => record.id));
  const byId = new Map(records.map((record) => [record.id, record]));
  const issues: Issue[] = [];
  for (const record of records) {
    const refs = [...(record.supersedes ?? []), ...(record.supersededBy ?? []), ...(record.related ?? [])];
    for (const id of refs) {
      if (!ids.has(id)) {
        issues.push({
          level: "warning",
          message: `${record.id} links to ${id}, which is not in this store.`,
        });
      }
    }
    for (const successorId of record.supersededBy ?? []) {
      const successor = byId.get(successorId);
      if (successor && !(successor.supersedes ?? []).includes(record.id)) {
        issues.push({
          level: "warning",
          message: `${successor.id} is listed in supersededBy of ${record.id} but does not list it in supersedes.`,
        });
      }
    }
    for (const predecessorId of record.supersedes ?? []) {
      const predecessor = byId.get(predecessorId);
      if (predecessor && !(predecessor.supersededBy ?? []).includes(record.id)) {
        issues.push({
          level: "warning",
          message: `${record.id} supersedes ${predecessor.id}, which does not list it in supersededBy.`,
        });
      }
    }
  }
  return issues;
}

export interface Section {
  name: string | null;
  text: string;
}

export function splitSections(body: string): Section[] {
  const lines = body.split("\n");
  const sections: Section[] = [];
  let name: string | null = null;
  let buffer: string[] = [];
  const flush = () => {
    const text = buffer.join("\n").trim();
    sections.push({ name, text });
    buffer = [];
  };
  for (const line of lines) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match) {
      flush();
      const heading = match[1] ?? "";
      const known = SECTIONS.find((section) => section.toLowerCase() === heading.toLowerCase());
      name = known ?? heading;
      continue;
    }
    buffer.push(line);
  }
  flush();
  return sections.filter((section) => section.name !== null || section.text.length > 0);
}

export function searchableText(record: DecisionRecord): string {
  const parts = [
    record.decision,
    ...(record.tags ?? []),
    ...(record.deciders ?? []),
    ...(record.participants ?? []),
    ...splitSections(record.body)
      .filter((section) => section.text.length > 0)
      .map((section) => section.text),
  ];
  return parts.join("\n");
}

export function decisionTextChanged(before: DecisionRecord, after: DecisionRecord): boolean {
  return before.status === "decided" && before.decision !== after.decision;
}
