import { cp, mkdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const from = path.join(root, "src", "web", "public");
const to = path.join(root, "dist", "src", "web", "public");
await mkdir(to, { recursive: true });
await cp(from, to, { recursive: true });
