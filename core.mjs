export function normalizeUsername(value) {
  return String(value || "").trim().toLocaleLowerCase("en-US").slice(0, 50);
}

export function pagination(inputLimit, inputOffset) {
  const limit = Math.min(100, Math.max(1, Number.parseInt(inputLimit, 10) || 20));
  const offset = Math.max(0, Number.parseInt(inputOffset, 10) || 0);
  return { limit, offset };
}

export function safeAccountData(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? structuredClone(value) : {};
}

export function summarizeData(value) {
  const data = safeAccountData(value);
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const instances =
    data.instances && typeof data.instances === "object" && !Array.isArray(data.instances)
      ? Object.values(data.instances)
      : [];
  return {
    taskSettingsCount: tasks.length,
    taskRecordsCount: instances.length,
    completedCount: instances.filter((item) => item?.status === "completed").length,
    deletedCount: instances.filter((item) => item?.status === "deleted").length,
    updatedAt: new Date().toISOString(),
  };
}

export function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value;
  let unit = "B";
  for (const next of units) {
    size /= 1024;
    unit = next;
    if (size < 1024) break;
  }
  return `${size >= 100 ? size.toFixed(0) : size >= 10 ? size.toFixed(1) : size.toFixed(2)} ${unit}`;
}

export function accountDataSection(dataInput, section) {
  const data = safeAccountData(dataInput);
  const allowed = new Set(["user", "settings", "meta", "sync", "summary"]);
  if (allowed.has(section)) return data[section] ?? null;
  const { tasks: _tasks, instances: _instances, ...rest } = data;
  return rest;
}

