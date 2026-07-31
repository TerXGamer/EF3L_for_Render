export function normalizeUsername(value) {
  return String(value || "").trim().toLocaleLowerCase("en-US").slice(0, 50);
}

const INSTANCE_PROFILE_FIELDS = [
  "title", "description", "time", "endTime", "requiredOverdue", "importance",
];

export function pagination(inputLimit, inputOffset) {
  const limit = Math.min(100, Math.max(1, Number.parseInt(inputLimit, 10) || 20));
  const offset = Math.max(0, Number.parseInt(inputOffset, 10) || 0);
  return { limit, offset };
}

export function safeAccountData(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? structuredClone(value) : {};
}

export function hydrateAccountData(value) {
  const data = safeAccountData(value);
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const taskById = new Map(tasks.map((task) => [String(task?.id || ""), task]));
  const profiles = Array.isArray(data.instanceProfiles) ? data.instanceProfiles : [];
  const instances =
    data.instances && typeof data.instances === "object" && !Array.isArray(data.instances)
      ? data.instances
      : {};
  data.instances = Object.fromEntries(Object.entries(instances).map(([key, raw]) => {
    const item = raw && typeof raw === "object" ? raw : {};
    const task = taskById.get(String(item.taskId || "")) || {};
    const profile = Number.isInteger(item.profile) ? profiles[item.profile] : null;
    const hydrated = { ...item, id: item.id || key };
    INSTANCE_PROFILE_FIELDS.forEach((field, index) => {
      if (hydrated[field] !== undefined) return;
      if (Array.isArray(profile) && profile[index] !== undefined && profile[index] !== null) {
        hydrated[field] = profile[index];
      } else if (task[field] !== undefined) {
        hydrated[field] = task[field];
      }
    });
    delete hydrated.profile;
    return [key, hydrated];
  }));
  delete data.instanceProfiles;
  return data;
}

export function compactAccountData(value) {
  const data = hydrateAccountData(value);
  const taskById = new Map((data.tasks || []).map((task) => [String(task?.id || ""), task]));
  const profileIndexes = new Map();
  const profiles = [];
  data.instances = Object.fromEntries(Object.entries(data.instances || {}).map(([key, raw]) => {
    const item = { ...(raw || {}), id: raw?.id || key };
    const task = taskById.get(String(item.taskId || ""));
    const profile = INSTANCE_PROFILE_FIELDS.map((field) => item[field] ?? null);
    const differs = !task || INSTANCE_PROFILE_FIELDS.some(
      (field) => (item[field] ?? null) !== (task[field] ?? null),
    );
    INSTANCE_PROFILE_FIELDS.forEach((field) => delete item[field]);
    if (differs) {
      const profileKey = JSON.stringify(profile);
      if (!profileIndexes.has(profileKey)) {
        profileIndexes.set(profileKey, profiles.length);
        profiles.push(profile);
      }
      item.profile = profileIndexes.get(profileKey);
    }
    if (!Array.isArray(item.history) || !item.history.length) delete item.history;
    return [key, item];
  }));
  if (profiles.length) data.instanceProfiles = profiles;
  else delete data.instanceProfiles;
  delete data.imports;
  delete data.sync;
  return data;
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
