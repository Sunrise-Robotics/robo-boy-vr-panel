import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = await readFile(resolve(projectRoot, "dist/index.js"));

console.log(`sha256-${createHash("sha256").update(bundle).digest("base64")}`);
