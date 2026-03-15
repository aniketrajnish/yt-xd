import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createThumbnailService } from "./thumbnail-service.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.join(__dirname, "assets");
const wasmPath = path.join(
  __dirname,
  "node_modules",
  "@resvg",
  "resvg-wasm",
  "index_bg.wasm",
);

const service = await createThumbnailService({
  templatesText: await fs.readFile(path.join(assetsDir, "templates.json"), "utf8"),
  fontBuffer: new Uint8Array(
    await fs.readFile(path.join(assetsDir, "fonts", "englebert-latin-400-normal.woff")),
  ),
  loadBinaryAsset: async (assetPath) =>
    new Uint8Array(await fs.readFile(path.join(assetsDir, assetPath))),
  loadWasm: async () => new Uint8Array(await fs.readFile(wasmPath)),
});

const result = await service.renderThumbnail({
  courseName: "Modern Physics",
  lessonTitle: "Pair Production : Conceptual Numerical Problems in Pair Production",
});

await fs.writeFile(path.join(__dirname, "smoke-render.png"), result.buffer);
console.log("Wrote smoke-render.png");
