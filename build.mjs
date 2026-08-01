import { access, readFile, writeFile } from "node:fs/promises";
import { brotliCompressSync } from "node:zlib";
import { icons } from "lucide";

const requiredFiles = ["index.html", "styles.css", "app.js", "core.mjs", "server.mjs", "logo.png"];

await Promise.all(requiredFiles.map((file) => access(file)));

const js = await readFile("app.js");
const compressed = brotliCompressSync(js);
await writeFile("app.js.br.b64", compressed.toString("base64"));

const selectedIcons = {
  "arrow-left-right": icons.ArrowLeftRight,
  "badge-alert": icons.BadgeAlert,
  "chart-no-axes-column-increasing": icons.ChartNoAxesColumnIncreasing,
  "circle-check": icons.CircleCheck,
  "circle-x": icons.CircleX,
  "key-round": icons.KeyRound,
  "layout-dashboard": icons.LayoutDashboard,
  "list-checks": icons.ListChecks,
  "lock-keyhole": icons.LockKeyhole,
  "log-out": icons.LogOut,
  pencil: icons.Pencil,
  plus: icons.Plus,
  "refresh-cw": icons.RefreshCw,
  "rotate-ccw": icons.RotateCcw,
  search: icons.Search,
  "settings-2": icons.Settings2,
  "shield-check": icons.ShieldCheck,
  "trash-2": icons.Trash2,
  "user-round": icons.UserRound,
  "ellipsis-vertical": icons.EllipsisVertical,
  x: icons.X,
};

const iconRuntime = `(() => {
  const icons = ${JSON.stringify(selectedIcons)};
  const namespace = "http://www.w3.org/2000/svg";
  function createIcons(options = {}) {
    const shared = options.attrs || {};
    document.querySelectorAll("i[data-lucide]").forEach((placeholder) => {
      const name = placeholder.getAttribute("data-lucide");
      const nodes = icons[name];
      if (!nodes) return;
      const svg = document.createElementNS(namespace, "svg");
      const attributes = {
        width: "24",
        height: "24",
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        "stroke-width": "2",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
        ...shared,
      };
      Object.entries(attributes).forEach(([key, value]) => svg.setAttribute(key, value));
      svg.setAttribute("data-lucide", name);
      if (placeholder.getAttribute("aria-hidden")) svg.setAttribute("aria-hidden", "true");
      nodes.forEach(([tag, attrs]) => {
        const child = document.createElementNS(namespace, tag);
        Object.entries(attrs).forEach(([key, value]) => child.setAttribute(key, value));
        svg.appendChild(child);
      });
      placeholder.replaceWith(svg);
    });
  }
  globalThis.lucide = { createIcons };
})();`;

await writeFile("lucide.js", iconRuntime);

console.log("Render build complete");
