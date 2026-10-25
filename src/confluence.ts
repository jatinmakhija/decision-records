import type { DecisionRecord } from "./core.js";
import { splitSections } from "./core.js";

export interface ConfluenceTarget {
  baseUrl: string;
  spaceKey: string;
  parentPageId: string;
  email: string;
  token: string;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export function credentialsFromEnv(env: NodeJS.ProcessEnv = process.env): { email?: string; token?: string } {
  return {
    email: env.CONFLUENCE_EMAIL,
    token: env.CONFLUENCE_API_TOKEN,
  };
}

export function targetFromConfig(
  config: { enabled: boolean; baseUrl?: string; spaceKey?: string; parentPageId?: string },
  env: NodeJS.ProcessEnv = process.env,
): ConfluenceTarget {
  const { email, token } = credentialsFromEnv(env);
  if (!config.enabled) throw new Error("Confluence is off for this store. Run decision confluence to turn it on.");
  if (!config.baseUrl || !config.spaceKey || !config.parentPageId) {
    throw new Error("Confluence config needs baseUrl, spaceKey, and parentPageId.");
  }
  if (!email || !token) throw new Error("Set CONFLUENCE_EMAIL and CONFLUENCE_API_TOKEN.");
  return {
    baseUrl: config.baseUrl.replace(/\/$/, ""),
    spaceKey: config.spaceKey,
    parentPageId: config.parentPageId,
    email,
    token,
  };
}

export function askShouldPublish(input: {
  publish?: boolean;
  noPublish?: boolean;
  isTTY: boolean;
  answer?: string;
}): boolean {
  if (input.publish) return true;
  if (input.noPublish) return false;
  if (!input.isTTY) return false;
  const answer = (input.answer ?? "").trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

export function pageIdFromSources(sources: string[] | undefined): string | undefined {
  for (const source of sources ?? []) {
    const match = /\/pages\/(\d+)/.exec(source);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

export function appendSource(record: DecisionRecord, url: string): DecisionRecord {
  if ((record.sources ?? []).includes(url)) return record;
  return { ...record, sources: [...(record.sources ?? []), url] };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function renderStorage(record: DecisionRecord): string {
  const meta = [
    `Status: ${record.status}`,
    record.decidedAt ? `Decided: ${record.decidedAt}` : `Recorded: ${record.createdAt}`,
    record.deciders?.length ? `Deciders: ${record.deciders.join(", ")}` : "",
    record.participants?.length ? `Participants: ${record.participants.join(", ")}` : "",
    record.recordedBy ? `Recorded by: ${record.recordedBy}` : "",
    record.tags?.length ? `Tags: ${record.tags.join(", ")}` : "",
  ].filter(Boolean);
  const parts = [`<p>${escapeHtml(meta.join(" · "))}</p>`];
  for (const section of splitSections(record.body)) {
    if (section.name) parts.push(`<h2>${escapeHtml(section.name)}</h2>`);
    if (section.text) {
      for (const paragraph of section.text.split(/\n{2,}/)) {
        const trimmed = paragraph.trim();
        if (trimmed) parts.push(`<p>${escapeHtml(trimmed).replace(/\n/g, "<br/>")}</p>`);
      }
    }
  }
  parts.push(`<p>Decision record ${escapeHtml(record.id)}</p>`);
  return parts.join("\n");
}

function authHeader(target: ConfluenceTarget): string {
  return `Basic ${Buffer.from(`${target.email}:${target.token}`).toString("base64")}`;
}

async function readError(response: Response): Promise<string> {
  const text = await response.text();
  return text.slice(0, 500) || response.statusText;
}

export async function publishPage(
  record: DecisionRecord,
  target: ConfluenceTarget,
  fetchImpl: Fetcher = fetch,
): Promise<string> {
  const headers = {
    Authorization: authHeader(target),
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  const existing = pageIdFromSources(record.sources);
  const title = record.decision.slice(0, 240);
  const body = {
    storage: { value: renderStorage(record), representation: "storage" },
  };
  if (existing) {
    const current = await fetchImpl(
      `${target.baseUrl}/wiki/rest/api/content/${existing}?expand=version`,
      { headers },
    );
    if (!current.ok) throw new Error(`Confluence read failed (${current.status}): ${await readError(current)}`);
    const json = (await current.json()) as { version?: { number?: number }; _links?: { base?: string; webui?: string } };
    const number = (json.version?.number ?? 1) + 1;
    const updated = await fetchImpl(`${target.baseUrl}/wiki/rest/api/content/${existing}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        id: existing,
        type: "page",
        title,
        version: { number },
        body,
      }),
    });
    if (!updated.ok) throw new Error(`Confluence update failed (${updated.status}): ${await readError(updated)}`);
    const saved = (await updated.json()) as { _links?: { base?: string; webui?: string } };
    return pageUrl(target, existing, saved._links) ?? pageUrl(target, existing, json._links) ?? `${target.baseUrl}/wiki/pages/${existing}`;
  }
  const created = await fetchImpl(`${target.baseUrl}/wiki/rest/api/content`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: "page",
      title,
      space: { key: target.spaceKey },
      ancestors: [{ id: target.parentPageId }],
      body,
    }),
  });
  if (!created.ok) throw new Error(`Confluence create failed (${created.status}): ${await readError(created)}`);
  const json = (await created.json()) as { id: string; _links?: { base?: string; webui?: string } };
  return pageUrl(target, json.id, json._links) ?? `${target.baseUrl}/wiki/spaces/${target.spaceKey}/pages/${json.id}`;
}

function pageUrl(
  target: ConfluenceTarget,
  id: string,
  links?: { base?: string; webui?: string },
): string | undefined {
  if (links?.webui) {
    const base = links.base ?? `${target.baseUrl}/wiki`;
    return `${base}${links.webui}`;
  }
  if (id) return `${target.baseUrl}/wiki/spaces/${target.spaceKey}/pages/${id}`;
  return undefined;
}
