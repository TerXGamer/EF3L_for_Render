const DAY_MS = 86_400_000;
const VALID_STATUSES = new Set([
  "main",
  "requiredOverdue",
  "optionalOverdue",
  "never",
  "completed",
]);
const INSTANCE_PROFILE_FIELDS = [
  "title",
  "description",
  "time",
  "endTime",
  "requiredOverdue",
  "importance",
];

export function hydrateAccountData(value) {
  const data =
    value && typeof value === "object" && !Array.isArray(value) ? structuredClone(value) : {};
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const taskById = new Map(tasks.map((task) => [String(task?.id || ""), task]));
  const profiles = Array.isArray(data.instanceProfiles) ? data.instanceProfiles : [];
  const source =
    data.instances && typeof data.instances === "object" && !Array.isArray(data.instances)
      ? data.instances
      : {};

  data.instances = Object.fromEntries(
    Object.entries(source).map(([key, value]) => {
      const item = value && typeof value === "object" ? value : {};
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
    }),
  );
  delete data.instanceProfiles;
  return data;
}

export function compactAccountData(value) {
  const data = hydrateAccountData(value);
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const taskById = new Map(tasks.map((task) => [String(task?.id || ""), task]));
  const profileIndexes = new Map();
  const profiles = [];

  data.instances = Object.fromEntries(
    Object.entries(data.instances || {}).map(([key, value]) => {
      const item = { ...(value || {}), id: value?.id || key };
      const task = taskById.get(String(item.taskId || ""));
      const profile = INSTANCE_PROFILE_FIELDS.map((field) => item[field] ?? null);
      const differsFromTask =
        !task || INSTANCE_PROFILE_FIELDS.some((field) => (item[field] ?? null) !== (task[field] ?? null));
      INSTANCE_PROFILE_FIELDS.forEach((field) => delete item[field]);
      if (differsFromTask) {
        const profileKey = JSON.stringify(profile);
        if (!profileIndexes.has(profileKey)) {
          profileIndexes.set(profileKey, profiles.length);
          profiles.push(profile);
        }
        item.profile = profileIndexes.get(profileKey);
      }
      if (!Array.isArray(item.history) || !item.history.length) delete item.history;
      return [key, removeUndefined(item)];
    }),
  );

  if (profiles.length) data.instanceProfiles = profiles;
  else delete data.instanceProfiles;
  delete data.imports;
  delete data.sync;

  if (data.settings && typeof data.settings === "object") {
    const customizations = data.settings.themeCustomizations;
    if (customizations && typeof customizations === "object") {
      data.settings.themeCustomizations = Object.fromEntries(
        Object.entries(customizations).filter(([, entry]) => entry?.mode === "custom"),
      );
    }
    for (const key of ["statsExcludedInstanceIds", "hiddenListInstanceIds", "snapshots"]) {
      if (Array.isArray(data.settings[key]) && !data.settings[key].length) delete data.settings[key];
    }
  }

  return removeUndefined(data);
}

function removeUndefined(value) {
  return Object.fromEntries(
    Object.entries(value || {}).filter(([, item]) => item !== undefined),
  );
}

function dateParts(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

function isoFromUtcDate(date) {
  return date.toISOString().slice(0, 10);
}

function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function todayISO(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function parseLocalDate(value) {
  const parts = dateParts(value);
  if (!parts) return new Date(Number.NaN);
  return new Date(parts.year, parts.month - 1, parts.day);
}

export function addDays(value, amount) {
  const parts = dateParts(value);
  if (!parts) return "";
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  date.setUTCDate(date.getUTCDate() + Number(amount || 0));
  return isoFromUtcDate(date);
}

export function daysBetween(start, end) {
  const first = dateParts(start);
  const second = dateParts(end);
  if (!first || !second) return Number.NaN;
  const firstTime = Date.UTC(first.year, first.month - 1, first.day);
  const secondTime = Date.UTC(second.year, second.month - 1, second.day);
  return Math.round((secondTime - firstTime) / DAY_MS);
}

export function forEachDate(start, end, callback) {
  if (!dateParts(start) || !dateParts(end) || start > end) return;
  let current = start;
  while (current <= end) {
    callback(current);
    current = addDays(current, 1);
  }
}

export function rangeDates(start, end) {
  const dates = [];
  forEachDate(start, end, (date) => dates.push(date));
  return dates;
}

export function maxDate(a, b) {
  return a > b ? a : b;
}

export function timeToMinutes(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ""));
  if (!match) return 0;
  const hours = Math.min(23, Math.max(0, Number(match[1])));
  const minutes = Math.min(59, Math.max(0, Number(match[2])));
  return hours * 60 + minutes;
}

export function minutesToTime(value) {
  const total = Math.max(0, Math.min(1439, Math.round(Number(value) || 0)));
  const hour = Math.floor(total / 60);
  const minute = total % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function mapTimeIntoWindow(time, window) {
  if (!window?.enabled) return time;
  const start = timeToMinutes(window.start);
  const end = timeToMinutes(window.end);
  if (end <= start) return time;
  const ratio = timeToMinutes(time) / 1439;
  return minutesToTime(start + ratio * (end - start));
}

export function isTaskDueOn(task, date) {
  if (!task?.startDate || !date || date < task.startDate) return false;
  const diff = daysBetween(task.startDate, date);
  if (!Number.isFinite(diff) || diff < 0) return false;
  if (task.recurrence === "once") return diff === 0;
  if (task.recurrence === "daily") return true;
  if (task.recurrence === "weekly") return diff % 7 === 0;
  if (task.recurrence === "custom") {
    return diff % Math.max(1, Number(task.intervalDays) || 1) === 0;
  }
  if (task.recurrence === "monthly") {
    const anchor = dateParts(task.startDate);
    const current = dateParts(date);
    if (!anchor || !current) return false;
    return current.day === Math.min(anchor.day, lastDayOfMonth(current.year, current.month));
  }
  return false;
}

export function latestDueDateOnOrBefore(task, date) {
  if (!task?.startDate || !date || date < task.startDate) return null;
  if (task.recurrence === "once") return task.startDate;
  if (task.recurrence === "daily") return date;

  const diff = daysBetween(task.startDate, date);
  if (!Number.isFinite(diff) || diff < 0) return null;
  if (task.recurrence === "weekly" || task.recurrence === "custom") {
    const interval = task.recurrence === "weekly" ? 7 : Math.max(1, Number(task.intervalDays) || 1);
    return addDays(date, -(diff % interval));
  }

  if (task.recurrence === "monthly") {
    const anchor = dateParts(task.startDate);
    const target = dateParts(date);
    if (!anchor || !target) return null;
    let year = target.year;
    let month = target.month;
    let candidate = `${year}-${String(month).padStart(2, "0")}-${String(
      Math.min(anchor.day, lastDayOfMonth(year, month)),
    ).padStart(2, "0")}`;
    if (candidate > date) {
      month -= 1;
      if (month === 0) {
        month = 12;
        year -= 1;
      }
      candidate = `${year}-${String(month).padStart(2, "0")}-${String(
        Math.min(anchor.day, lastDayOfMonth(year, month)),
      ).padStart(2, "0")}`;
    }
    return candidate >= task.startDate ? candidate : null;
  }

  return null;
}

export function wouldCreateDependencyCycle(tasks, taskId, dependencyId) {
  if (!taskId || !dependencyId) return false;
  if (taskId === dependencyId) return true;
  const dependencyByTask = new Map((tasks || []).map((task) => [task.id, task.dependencyId || ""]));
  dependencyByTask.set(taskId, dependencyId);
  const visited = new Set();
  let current = dependencyId;
  while (current) {
    if (current === taskId || visited.has(current)) return true;
    visited.add(current);
    current = dependencyByTask.get(current) || "";
  }
  return false;
}

export function calculateStats(items) {
  const eligible = (items || []).filter((item) => item && VALID_STATUSES.has(item.status));
  const completed = eligible.filter((item) => item.status === "completed").length;
  const pending = eligible.filter((item) => item.status === "main").length;
  const missed = Math.max(0, eligible.length - completed - pending);
  const decided = completed + missed;
  const rate = decided ? Math.round((completed / decided) * 100) : 0;
  return {
    total: eligible.length,
    completed,
    pending,
    missed,
    decided,
    rate,
    items: eligible,
  };
}

export function findDuplicateInstanceIds(instances) {
  const groups = new Map();
  (instances || []).forEach((instance) => {
    if (!instance?.id || !instance.taskId || !instance.date || !instance.status) return;
    const key = `${instance.taskId}:${instance.date}:${instance.status}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(instance);
  });

  const duplicates = [];
  groups.forEach((items) => {
    if (items.length < 2) return;
    const canonicalId = `${items[0].taskId}:${items[0].date}`;
    const keep = items.find((item) => item.id === canonicalId) || items.slice().sort((a, b) =>
      String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")),
    )[0];
    items.forEach((item) => {
      if (item.id !== keep.id) duplicates.push(item.id);
    });
  });
  return duplicates;
}

export function resolveNotDoneStatus(requiredOverdue, forceNever = false) {
  return forceNever || !requiredOverdue ? "never" : "requiredOverdue";
}
