import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { toData } from "./core.js";
import path from "node:path";
import { stat } from "node:fs/promises";
import { createRecord, initStore, loadStore, locateStore, resolveId, searchRecords, type LocatedStore } from "./store.js";

async function openReadyStore(): Promise<LocatedStore> {
  const located = await locateStore({ env: process.env.DECISION_DIR, cwd: process.cwd() });
  try {
    await stat(path.join(located.root, ".decision.json"));
  } catch {
    await initStore(located.root, located.config);
  }
  return located;
}

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

export async function startMcp(): Promise<void> {
  const server = new McpServer({ name: "decision", version: "0.1.0" });
  server.registerTool(
    "list",
    {
      description: "List decision records in the active store.",
      inputSchema: {
        status: z.string().optional(),
        tag: z.string().optional(),
      },
    },
    async ({ status, tag }) => {
      const located = await openReadyStore();
      const records = searchRecords(await loadStore(located.root), {
        status: status as never,
        tags: tag ? [tag] : [],
      });
      return text(records.map((item) => toData(item.record)));
    },
  );
  server.registerTool(
    "show",
    {
      description: "Show one decision record by id or unique prefix.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const located = await openReadyStore();
      const item = resolveId(await loadStore(located.root), id);
      return text(toData(item.record));
    },
  );
  server.registerTool(
    "search",
    {
      description: "Search decision records with case-insensitive text.",
      inputSchema: { query: z.string() },
    },
    async ({ query }) => {
      const located = await openReadyStore();
      const records = searchRecords(await loadStore(located.root), { text: query });
      return text(records.map((item) => toData(item.record)));
    },
  );
  server.registerTool(
    "create_proposal",
    {
      description: "Create a proposed decision. This cannot mark it decided or publish it.",
      inputSchema: {
        decision: z.string(),
        client: z.string().optional(),
      },
    },
    async ({ decision, client }) => {
      const located = await openReadyStore();
      const stored = await createRecord(located.root, located.config, {
        decision,
        status: "proposed",
        recordedBy: `mcp:${client || "unknown"}`,
      });
      return text(toData(stored.record));
    },
  );
  await server.connect(new StdioServerTransport());
}
