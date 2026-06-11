import { access } from "node:fs/promises";

const requiredFiles = ["index.html", "styles.css", "app.js", "server.mjs"];

await Promise.all(requiredFiles.map((file) => access(file)));

console.log("Render build check complete");
