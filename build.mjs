import { access, readFile, writeFile } from "node:fs/promises";
import { brotliCompressSync } from "node:zlib";

const requiredFiles = ["index.html", "styles.css", "app.js", "server.mjs"];

await Promise.all(requiredFiles.map((file) => access(file)));

const js = await readFile("app.js");
const compressed = brotliCompressSync(js);
await writeFile("app.js.br.b64", compressed.toString("base64"));

console.log("Render build complete");
