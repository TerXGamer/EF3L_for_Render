import { access, writeFile } from "node:fs/promises";
import { icons } from "lucide";

await Promise.all(
  ["server.mjs", "core.mjs", "public/index.html", "public/app.js", "public/styles.css"].map((file) =>
    access(file),
  ),
);

const selectedIcons = {
  activity: icons.Activity,
  archive: icons.Archive,
  "arrow-right": icons.ArrowRight,
  "bar-chart-3": icons.ChartNoAxesColumn,
  "check-circle-2": icons.CircleCheck,
  database: icons.Database,
  download: icons.Download,
  eye: icons.Eye,
  file: icons.FileText,
  gauge: icons.Gauge,
  key: icons.KeyRound,
  "layout-dashboard": icons.LayoutDashboard,
  "log-out": icons.LogOut,
  menu: icons.Menu,
  refresh: icons.RefreshCw,
  search: icons.Search,
  server: icons.Server,
  settings: icons.Settings2,
  shield: icons.ShieldCheck,
  "trash-2": icons.Trash2,
  user: icons.UserRound,
  users: icons.UsersRound,
  x: icons.X,
};

const runtime = `(() => {
  const icons = ${JSON.stringify(selectedIcons)};
  const ns = "http://www.w3.org/2000/svg";
  function createIcons() {
    document.querySelectorAll("i[data-lucide]").forEach((holder) => {
      const nodes = icons[holder.dataset.lucide];
      if (!nodes) return;
      const svg = document.createElementNS(ns, "svg");
      Object.entries({
        width: "20", height: "20", viewBox: "0 0 24 24", fill: "none",
        stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round",
        "stroke-linejoin": "round", "aria-hidden": "true"
      }).forEach(([key, value]) => svg.setAttribute(key, value));
      nodes.forEach(([tag, attrs]) => {
        const node = document.createElementNS(ns, tag);
        Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
        svg.appendChild(node);
      });
      holder.replaceWith(svg);
    });
  }
  globalThis.lucide = { createIcons };
})();`;

await writeFile("public/lucide.js", runtime);
console.log("EF3L Control build complete");

