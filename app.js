const STORE_KEY = "ifal.task.manager.v1";
const CLOUD_SYNC_DELAY = 5 * 60 * 1000;
const CLOUD_SYNC_MIN_GAP = 5 * 60 * 1000;
const CLOUD_API_BASE = String(globalThis.IFAL_API_BASE || "").replace(/\/$/, "");
const CLOUD_ACCOUNT_ENDPOINT = String(globalThis.IFAL_ACCOUNT_ENDPOINT || `${CLOUD_API_BASE}/api/account`);
const CLOUD_ADMIN_ENDPOINT = String(globalThis.IFAL_ADMIN_ENDPOINT || `${CLOUD_API_BASE}/api/admin`);

const titles = {
  main: "المهام الرئيسية",
  settings: "إعدادات المهام",
  required: "المهام المنتهية الواجبة",
  optional: "المهام المنتهية ليست مهمة",
  never: "المهام التي لم تنفذ أبدًا",
  completed: "مهام تم تنفيذها",
  stats: "الإحصائيات",
  site: "\u0625\u0639\u062f\u0627\u062f\u0627\u062a \u0627\u0644\u0645\u0648\u0642\u0639",
  account: "حسابي",
  lists: "عام القوائم",
  settingsHub: "الإعدادات",
  deleted: "المهام المحذوفة",
  reset: "إعادة الضبط",
  admin: "الادمن",
  adminReveal: "كشف",
};

const navParents = {
  main: "main",
  lists: "lists",
  required: "lists",
  optional: "lists",
  never: "lists",
  deleted: "lists",
  completed: "lists",
  settingsHub: "settingsHub",
  settings: "settingsHub",
  stats: "settingsHub",
  site: "settingsHub",
  account: "settingsHub",
  reset: "settingsHub",
  admin: "settingsHub",
  adminReveal: "settingsHub",
};

const viewRedirects = {
  lists: "required",
  settingsHub: "settings",
};

const importanceLabels = {
  2: "منخفض",
  4: "متوسط",
  6: "عالي",
  8: "عالي جدًا",
  10: "قمة",
};

let state = loadState();
let currentView = "main";
let selectedImportance = 6;
let selectedNever = new Set();
let toastTimer = null;
let cloudSaveTimer = null;
let isApplyingRemote = false;
let pendingCloudSync = false;
let loginMode = "login";
let passwordVisible = false;
let statsSettingsOpen = false;
let isAdmin = false;
let adminUsers = [];
let adminRevealTarget = "";
let adminRevealData = null;
let adminRevealLoading = false;

const el = {
  mobileUserBadge: document.getElementById("mobileUserBadge"),
  userBadge: document.getElementById("userBadge"),
  todayLabel: document.getElementById("todayLabel"),
  viewTitle: document.getElementById("viewTitle"),
  loginDialog: document.getElementById("loginDialog"),
  loginForm: document.getElementById("loginForm"),
  loginModeTitle: document.getElementById("loginModeTitle"),
  loginModeLogin: document.getElementById("loginModeLogin"),
  loginModeCreate: document.getElementById("loginModeCreate"),
  loginSubmit: document.getElementById("loginSubmit"),
  loginUsername: document.getElementById("loginUsername"),
  loginPassword: document.getElementById("loginPassword"),
  loginName: document.getElementById("loginName"),
  loginEmail: document.getElementById("loginEmail"),
  logoutButton: document.getElementById("logoutButton"),
  syncNow: document.getElementById("syncNow"),
  themeMode: document.getElementById("themeMode"),
  toast: document.getElementById("toast"),
  mainSummary: document.getElementById("mainSummary"),
  activeTasks: document.getElementById("activeTasks"),
  upcomingTasks: document.getElementById("upcomingTasks"),
  activeCount: document.getElementById("activeCount"),
  upcomingCount: document.getElementById("upcomingCount"),
  taskForm: document.getElementById("taskForm"),
  taskId: document.getElementById("taskId"),
  taskTitle: document.getElementById("taskTitle"),
  taskDescription: document.getElementById("taskDescription"),
  taskStartDate: document.getElementById("taskStartDate"),
  taskRecurrence: document.getElementById("taskRecurrence"),
  taskInterval: document.getElementById("taskInterval"),
  intervalHint: document.getElementById("intervalHint"),
  taskDependency: document.getElementById("taskDependency"),
  dependencyHint: document.getElementById("dependencyHint"),
  taskTime: document.getElementById("taskTime"),
  taskEndTime: document.getElementById("taskEndTime"),
  taskRequiredOverdue: document.getElementById("taskRequiredOverdue"),
  taskActive: document.getElementById("taskActive"),
  importanceButtons: document.getElementById("importanceButtons"),
  resetTaskForm: document.getElementById("resetTaskForm"),
  windowEnabled: document.getElementById("windowEnabled"),
  windowStart: document.getElementById("windowStart"),
  windowEnd: document.getElementById("windowEnd"),
  saveWindow: document.getElementById("saveWindow"),
  windowStatus: document.getElementById("windowStatus"),
  saveSettingsSnapshot: document.getElementById("saveSettingsSnapshot"),
  exportSettings: document.getElementById("exportSettings"),
  importSettings: document.getElementById("importSettings"),
  settingsHistory: document.getElementById("settingsHistory"),
  settingsCount: document.getElementById("settingsCount"),
  settingsTasks: document.getElementById("settingsTasks"),
  taskSettingsCount: document.getElementById("taskSettingsCount"),
  requiredTasks: document.getElementById("requiredTasks"),
  optionalTasks: document.getElementById("optionalTasks"),
  neverTasks: document.getElementById("neverTasks"),
  deletedTasks: document.getElementById("deletedTasks"),
  completedTasks: document.getElementById("completedTasks"),
  selectFirstTen: document.getElementById("selectFirstTen"),
  deleteSelectedNever: document.getElementById("deleteSelectedNever"),
  deleteAllNever: document.getElementById("deleteAllNever"),
  statsSummary: document.getElementById("statsSummary"),
  dailyStats: document.getElementById("dailyStats"),
  weeklyStats: document.getElementById("weeklyStats"),
  monthlyStats: document.getElementById("monthlyStats"),
  importanceStats: document.getElementById("importanceStats"),
  dailyCompare: document.getElementById("dailyCompare"),
  weeklyCompare: document.getElementById("weeklyCompare"),
  monthlyCompare: document.getElementById("monthlyCompare"),
  statsSettingsToggle: document.getElementById("statsSettingsToggle"),
  statsSourceList: document.getElementById("statsSourceList"),
  statsSourceCount: document.getElementById("statsSourceCount"),
  accountSyncState: document.getElementById("accountSyncState"),
  accountDetails: document.getElementById("accountDetails"),
  storageExplanation: document.getElementById("storageExplanation"),
  manualCloudSync: document.getElementById("manualCloudSync"),
  showPassword: document.getElementById("showPassword"),
  resetRuntimeData: document.getElementById("resetRuntimeData"),
  adminUserList: document.getElementById("adminUserList"),
  adminUserCount: document.getElementById("adminUserCount"),
  adminRevealTitle: document.getElementById("adminRevealTitle"),
  adminRevealProfile: document.getElementById("adminRevealProfile"),
  adminRevealTasks: document.getElementById("adminRevealTasks"),
  adminRevealBack: document.getElementById("adminRevealBack"),
};

init();
disableOfflineSystem();

function init() {
  ensureDefaults();
  applyTheme();
  bindEvents();
  fillDefaultFormValues();
  refreshSchedule();
  render();
  if (!state.user) {
    showLogin();
  } else {
    hideLogin();
    checkAdminAccess();
  }
  setInterval(() => {
    refreshSchedule();
    render();
  }, 60 * 1000);
}

function disableOfflineSystem() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.getRegistrations?.().then((registrations) => {
      registrations.forEach((registration) => registration.unregister());
    }).catch(() => {});
  }
  if ("caches" in globalThis) {
    caches.keys().then((keys) => keys.forEach((key) => caches.delete(key))).catch(() => {});
  }
}

function applyTheme() {
  const theme = state.settings.theme || "light";
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme === "dark" || theme === "night" ? "dark" : "light";
  if (el.themeMode) el.themeMode.value = theme;
}

function bindEvents() {
  const on = (target, eventName, handler) => {
    if (target) target.addEventListener(eventName, handler);
  };

  document.querySelectorAll(".nav-button").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });
  document.querySelectorAll(".subnav-button").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });

  on(el.loginModeLogin, "click", () => setLoginMode("login"));
  on(el.loginModeCreate, "click", () => setLoginMode("create"));

  on(el.loginForm, "submit", async (event) => {
    event.preventDefault();
    await handleLoginSubmit();
  });

  on(el.logoutButton, "click", () => {
    state.user = null;
    state.sync = { ...state.sync, mode: "local", lastError: "" };
    isAdmin = false;
    adminUsers = [];
    adminRevealTarget = "";
    adminRevealData = null;
    updateAdminNav();
    saveState();
    render();
    showLogin();
  });

  on(el.syncNow, "click", async () => {
    refreshSchedule();
    await syncToCloud(true);
    render();
    toast(state.sync.mode === "cloud" ? "تم التحديث والمزامنة" : "تم التحديث محليًا");
  });

  on(el.themeMode, "change", () => {
    state.settings.theme = el.themeMode.value;
    applyTheme();
    saveState();
  });

  on(el.taskForm, "submit", saveTaskFromForm);
  on(el.resetTaskForm, "click", clearTaskForm);
  on(el.taskRecurrence, "change", syncIntervalState);

  on(el.importanceButtons, "click", (event) => {
    const button = event.target.closest("button[data-importance]");
    if (!button) return;
    selectedImportance = Number(button.dataset.importance);
    renderImportanceButtons();
  });

  on(el.saveWindow, "click", saveDisplayWindow);
  on(el.saveSettingsSnapshot, "click", saveSettingsSnapshot);
  on(el.exportSettings, "click", exportSettingsFile);
  on(el.importSettings, "change", (event) => importSettingsFile(event.target.files[0]));

  on(el.selectFirstTen, "click", selectFirstTenNever);
  on(el.deleteSelectedNever, "click", deleteSelectedNever);
  on(el.deleteAllNever, "click", deleteAllNever);

  on(el.statsSettingsToggle, "click", () => {
    statsSettingsOpen = !statsSettingsOpen;
    renderStats();
  });
  on(el.manualCloudSync, "click", async () => {
    await syncToCloud(true);
    render();
  });
  on(el.showPassword, "click", () => {
    passwordVisible = !passwordVisible;
    renderAccount();
  });
  on(el.resetRuntimeData, "click", resetRuntimeData);
  on(el.adminRevealBack, "click", () => switchView("admin"));
  window.addEventListener("online", () => {
    if (pendingCloudSync) scheduleCloudSave(CLOUD_SYNC_DELAY);
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && pendingCloudSync) scheduleCloudSave(CLOUD_SYNC_DELAY);
  });

  document.addEventListener("click", handleActionClick);
  document.addEventListener("change", handleSelectionChange);
}

function initialState() {
  return {
    version: 1,
    user: null,
    tasks: [],
    instances: {},
    settings: {
      theme: "light",
      displayWindow: {
        enabled: false,
        start: "00:00",
        end: "23:59",
      },
      snapshots: [],
      statsExcludedInstanceIds: [],
    },
    imports: [],
    sync: {
      lastSyncAt: null,
      lastError: "",
      mode: "local",
    },
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return initialState();
    return normalizeState(JSON.parse(raw));
  } catch {
    return initialState();
  }
}

function normalizeState(input) {
  const base = initialState();
  const next = { ...base, ...(input || {}) };
  next.tasks = Array.isArray(next.tasks) ? next.tasks.map(normalizeTask).filter(Boolean) : [];
  next.instances = normalizeInstances(next.instances);
  next.settings = {
    ...base.settings,
    ...(next.settings || {}),
    displayWindow: {
      ...base.settings.displayWindow,
      ...((next.settings || {}).displayWindow || {}),
    },
    snapshots: Array.isArray((next.settings || {}).snapshots) ? next.settings.snapshots : [],
    statsExcludedInstanceIds: Array.isArray((next.settings || {}).statsExcludedInstanceIds)
      ? next.settings.statsExcludedInstanceIds
      : [],
  };
  next.imports = Array.isArray(next.imports) ? next.imports : [];
  next.sync = {
    ...base.sync,
    ...(next.sync || {}),
  };
  return next;
}

function normalizeTask(task) {
  if (!task || !task.title) return null;
  const now = new Date().toISOString();
  return {
    id: task.id || uid("task"),
    title: String(task.title || "").trim(),
    description: String(task.description || ""),
    startDate: task.startDate || todayISO(),
    recurrence: ["once", "daily", "weekly", "monthly", "custom"].includes(task.recurrence)
      ? task.recurrence
      : "daily",
    intervalDays: Math.max(1, Number(task.intervalDays || 1)),
    dependencyId: task.dependencyId || "",
    time: task.time || "08:00",
    endTime: task.endTime || "09:00",
    requiredOverdue: Boolean(task.requiredOverdue),
    importance: [2, 4, 6, 8, 10].includes(Number(task.importance)) ? Number(task.importance) : 6,
    active: task.active !== false,
    createdAt: task.createdAt || now,
    updatedAt: task.updatedAt || now,
  };
}

function normalizeInstances(instances) {
  const map = {};
  if (!instances || typeof instances !== "object") return map;
  Object.values(instances).forEach((item) => {
    if (!item || !item.id || !item.taskId || !item.date) return;
    map[item.id] = {
      ...item,
      status: item.status || "main",
      history: Array.isArray(item.history) ? item.history : [],
      updatedAt: item.updatedAt || item.createdAt || new Date().toISOString(),
    };
  });
  return map;
}

function ensureDefaults() {
  state = normalizeState(state);
  saveState();
}

function saveState(sync = true) {
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
  if (sync) scheduleCloudSave(CLOUD_SYNC_DELAY);
}

function fillDefaultFormValues() {
  el.taskStartDate.value = todayISO();
  el.taskTime.value = "08:00";
  el.taskEndTime.value = "09:00";
  el.windowStart.value = state.settings.displayWindow.start;
  el.windowEnd.value = state.settings.displayWindow.end;
  el.windowEnabled.checked = state.settings.displayWindow.enabled;
  renderImportanceButtons();
  syncIntervalState();
}

function switchView(view) {
  if ((view === "admin" || view === "adminReveal") && !isAdmin) {
    toast("هذه الصفحة للادمن فقط");
    return;
  }
  currentView = viewRedirects[view] || view;
  document.querySelectorAll(".nav-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === navParents[currentView]);
  });
  document.querySelectorAll(".view").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `view-${currentView}`);
  });
  document.querySelectorAll(".subnav-button").forEach((button) => {
    const subnavView = currentView === "adminReveal" ? "admin" : currentView;
    button.classList.toggle("active", button.dataset.view === subnavView);
  });
  render();
}

function showLogin() {
  if (!el.loginDialog.classList.contains("is-open")) {
    document.body.classList.add("auth-required");
    el.loginDialog.hidden = false;
    el.loginDialog.setAttribute("aria-hidden", "false");
    setLoginMode("login");
    el.loginUsername.value = "";
    el.loginPassword.value = "";
    el.loginName.value = "";
    el.loginEmail.value = "";
    el.loginDialog.classList.add("is-open");
  }
}

function hideLogin() {
  el.loginDialog.classList.remove("is-open");
  el.loginDialog.hidden = true;
  el.loginDialog.setAttribute("aria-hidden", "true");
  document.body.classList.remove("auth-required");
}

function setLoginMode(mode) {
  loginMode = mode;
  el.loginDialog.dataset.mode = mode;
  el.loginModeLogin.classList.toggle("active", mode === "login");
  el.loginModeCreate.classList.toggle("active", mode === "create");
  el.loginModeTitle.textContent = mode === "login" ? "تسجيل الدخول" : "إنشاء حساب جديد";
  el.loginSubmit.textContent = mode === "login" ? "دخول" : "إنشاء الحساب";
  el.loginName.required = mode === "create";
  el.loginEmail.required = mode === "create";
  el.loginPassword.autocomplete = mode === "login" ? "current-password" : "new-password";
}

async function handleLoginSubmit() {
  const username = normalizeUsername(el.loginUsername.value);
  const password = el.loginPassword.value;
  const name = el.loginName.value.trim();
  const email = el.loginEmail.value.trim();

  if (!username || !password) {
    toast("اكتب اسم المستخدم وكلمة المرور");
    return;
  }
  if (loginMode === "create" && (!name || !email)) {
    toast("اكتب الاسم والبريد الإلكتروني");
    return;
  }

  try {
    const payload =
      loginMode === "create"
        ? { action: "create", username, password, name, email, data: cloudStateSnapshot({ name, email, username }) }
        : { action: "login", username, password };
    const response = await accountRequest(payload);
    applyCloudLogin(response, password);
    hideLogin();
    toast(loginMode === "create" ? "تم إنشاء الحساب ومزامنته" : "تم تسجيل الدخول وجلب بياناتك");
  } catch (error) {
    if (!isBackendUnavailable(error)) {
      toast(error.message || "تعذر تسجيل الدخول. راجع Deploy log في Render.");
      return;
    }
    state.user = {
      name: name || username,
      email: email || "",
      username,
      password,
      loggedInAt: new Date().toISOString(),
    };
    state.sync = {
      ...state.sync,
      mode: "local",
      lastError: "الحفظ المحلي فقط: لم يتم العثور على خدمة Render الخلفية في هذا الرابط.",
    };
    saveState(false);
    hideLogin();
    render();
    toast("تم الدخول محليًا فقط");
  }
}

function applyCloudLogin(response, password) {
  const profile = response.user || {};
  isApplyingRemote = true;
  const remoteData = response.data ? normalizeState(response.data) : normalizeState(state);
  state = remoteData;
  state.user = {
    name: profile.name || remoteData.user?.name || profile.username,
    email: profile.email || remoteData.user?.email || "",
    username: profile.username || remoteData.user?.username || "",
    password,
    loggedInAt: new Date().toISOString(),
  };
  state.sync = {
    lastSyncAt: new Date().toISOString(),
    lastError: "",
    mode: "cloud",
  };
  isApplyingRemote = false;
  saveState(false);
  refreshSchedule();
  render();
  checkAdminAccess();
}

async function checkAdminAccess() {
  if (!canCloudSync()) {
    isAdmin = false;
    adminUsers = [];
    updateAdminNav();
    return;
  }

  try {
    const response = await adminRequest({ action: "check" });
    isAdmin = Boolean(response.isAdmin);
  } catch {
    isAdmin = false;
  }
  updateAdminNav();
}

function updateAdminNav() {
  document.querySelectorAll(".admin-only").forEach((button) => {
    button.hidden = !isAdmin;
  });
}

async function adminRequest(payload) {
  if (!canCloudSync()) {
    throw new Error("سجل الدخول أولًا");
  }

  const response = await fetch(CLOUD_ADMIN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: state.user.username,
      password: state.user.password,
      ...payload,
    }),
  });

  let body = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }

  if (!response.ok) {
    const message = body.details
      ? `${body.error || "تعذر الاتصال بالخادم"}: ${body.details}`
      : body.error || "تعذر الاتصال بالخادم";
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  return body;
}

async function loadAdminUsers(force = false) {
  if (!isAdmin) return;
  if (!force && adminUsers.length) return;
  const response = await adminRequest({ action: "list" });
  adminUsers = Array.isArray(response.users) ? response.users : [];
}

async function openAdminReveal(username) {
  adminRevealTarget = normalizeUsername(username);
  adminRevealData = null;
  adminRevealLoading = true;
  switchView("adminReveal");
  try {
    adminRevealData = await adminRequest({
      action: "reveal",
      targetUsername: adminRevealTarget,
    });
  } catch (error) {
    adminRevealData = null;
    toast(error.message || "تعذر جلب بيانات الكشف");
  } finally {
    adminRevealLoading = false;
    render();
  }
}

async function accountRequest(payload) {
  const response = await fetch(CLOUD_ACCOUNT_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  let body = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  if (!response.ok) {
    const message = body.details
      ? `${body.error || "تعذر الاتصال بالخادم"}: ${body.details}`
      : body.error || (response.status === 404 ? "backend-unavailable" : "تعذر الاتصال بالخادم");
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return body;
}

function isBackendUnavailable(error) {
  return error && (error.status === 404 || error.status === 405 || error.message === "backend-unavailable");
}

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function canCloudSync() {
  return Boolean(state.user?.username && state.user?.password);
}

function scheduleCloudSave(delay = CLOUD_SYNC_DELAY) {
  if (isApplyingRemote || !canCloudSync()) return;
  pendingCloudSync = true;
  if (navigator.onLine === false) return;
  const lastAttempt = state.sync?.lastAttemptAt ? new Date(state.sync.lastAttemptAt).getTime() : 0;
  const elapsed = Date.now() - lastAttempt;
  const gap = CLOUD_SYNC_MIN_GAP;
  const minDelay = elapsed < gap ? gap - elapsed : delay;
  clearTimeout(cloudSaveTimer);
  cloudSaveTimer = setTimeout(() => syncToCloud(false), Math.max(delay, minDelay));
}

async function syncToCloud(manual = false) {
  if (!canCloudSync()) {
    if (manual) toast("سجل الدخول أولًا");
    return false;
  }
  try {
    state.sync = {
      ...state.sync,
      lastAttemptAt: new Date().toISOString(),
    };
    saveState(false);
    await accountRequest({
      action: "save",
      username: state.user.username,
      password: state.user.password,
      data: cloudStateSnapshot(state.user),
    });
    state.sync = {
      lastSyncAt: new Date().toISOString(),
      lastAttemptAt: new Date().toISOString(),
      lastError: "",
      mode: "cloud",
    };
    pendingCloudSync = false;
    saveState(false);
    if (manual) toast("تمت المزامنة مع Render");
    return true;
  } catch (error) {
    state.sync = {
      ...state.sync,
      mode: "local",
      lastAttemptAt: new Date().toISOString(),
      lastError: isBackendUnavailable(error)
        ? "الحفظ المحلي فقط: خدمة Render الخلفية لا تعمل في هذا الرابط."
        : error.message || "تعذرت المزامنة.",
    };
    saveState(false);
    if (manual) toast(state.sync.lastError);
    return false;
  }
}

function cloudStateSnapshot(userOverride) {
  const snapshot = normalizeState(clone(state));
  snapshot.user = {
    name: userOverride?.name || state.user?.name || "",
    email: userOverride?.email || state.user?.email || "",
    username: userOverride?.username || state.user?.username || "",
    loggedInAt: state.user?.loggedInAt || new Date().toISOString(),
  };
  delete snapshot.user.password;
  snapshot.sync = {
    ...snapshot.sync,
    mode: "cloud",
    lastError: "",
  };
  return snapshot;
}

function refreshSchedule() {
  let changed = false;
  const today = todayISO();
  const now = new Date();
  const taskIds = new Set(state.tasks.map((task) => task.id));

  state.tasks.forEach((task) => {
    if (!task.active) return;
    const start = maxDate(task.startDate, addDays(today, -120));
    forEachDate(start, today, (date) => {
      if (!isTaskDueOn(task, date)) return;
      if (task.dependencyId && !isDependencyCompleted(task.dependencyId, date)) return;
      const id = instanceId(task.id, date);
      if (!state.instances[id]) {
        state.instances[id] = createInstance(task, date);
        changed = true;
      } else if (taskIds.has(state.instances[id].taskId)) {
        syncInstanceWithTask(state.instances[id], task);
      }
    });
  });

  Object.values(state.instances).forEach((instance) => {
    if (instance.status === "main" && isInstanceExpired(instance, now)) {
      moveInstanceStatus(instance, instance.requiredOverdue ? "requiredOverdue" : "optionalOverdue", "انتهى الوقت");
      changed = true;
    }
    if (instance.status === "optionalOverdue" && isOlderThanDays(instance.movedAt || instance.updatedAt, 3)) {
      moveInstanceStatus(instance, "never", "مر 3 أيام");
      changed = true;
    }
  });

  Object.keys(state.instances).forEach((id) => {
    const instance = state.instances[id];
    if (instance?.status === "deleted" && isOlderThanDays(instance.movedAt || instance.updatedAt, 5)) {
      delete state.instances[id];
      selectedNever.delete(id);
      changed = true;
    }
  });

  if (changed) saveState();
}

function createInstance(task, date) {
  const now = new Date().toISOString();
  return {
    id: instanceId(task.id, date),
    taskId: task.id,
    title: task.title,
    description: task.description,
    date,
    time: task.time,
    endTime: task.endTime,
    requiredOverdue: task.requiredOverdue,
    importance: task.importance,
    status: "main",
    source: "schedule",
    createdAt: now,
    updatedAt: now,
    history: [{ at: now, action: "ظهرت في القائمة الرئيسية" }],
  };
}

function syncInstanceWithTask(instance, task) {
  if (["completed", "never", "deleted"].includes(instance.status)) return;
  instance.title = task.title;
  instance.description = task.description;
  instance.time = task.time;
  instance.endTime = task.endTime;
  instance.requiredOverdue = task.requiredOverdue;
  instance.importance = task.importance;
  instance.updatedAt = new Date().toISOString();
}

function isTaskDueOn(task, date) {
  if (date < task.startDate) return false;
  const diff = daysBetween(task.startDate, date);
  if (diff < 0) return false;
  if (task.recurrence === "once") return diff === 0;
  if (task.recurrence === "daily") return true;
  if (task.recurrence === "weekly") return diff % 7 === 0;
  if (task.recurrence === "custom") return diff % Math.max(1, task.intervalDays) === 0;
  if (task.recurrence === "monthly") {
    const anchor = parseDate(task.startDate).getDate();
    const current = parseDate(date);
    const lastDay = new Date(current.getFullYear(), current.getMonth() + 1, 0).getDate();
    return current.getDate() === Math.min(anchor, lastDay);
  }
  return false;
}

function isDependencyCompleted(taskId, date) {
  const dependency = state.instances[instanceId(taskId, date)];
  return Boolean(dependency && dependency.status === "completed");
}

function isInstanceExpired(instance, now) {
  const today = todayISO(now);
  if (instance.date < today) return true;
  if (instance.date > today) return false;
  const time = getInstanceTimes(instance).displayEnd;
  return minutesNow(now) > timeToMinutes(time);
}

function isInstanceVisibleNow(instance) {
  const today = todayISO();
  if (instance.date !== today) return false;
  const minutes = minutesNow();
  const times = getInstanceTimes(instance);
  return minutes >= timeToMinutes(times.displayStart) && minutes <= timeToMinutes(times.displayEnd);
}

function isInstanceUpcoming(instance) {
  const today = todayISO();
  if (instance.date !== today) return false;
  return minutesNow() < timeToMinutes(getInstanceTimes(instance).displayStart);
}

function getInstanceTimes(instance) {
  const task = getTask(instance.taskId);
  const start = task ? task.time : instance.time;
  const end = task ? task.endTime : instance.endTime;
  if (!state.settings.displayWindow.enabled) {
    return {
      actualStart: start,
      actualEnd: end,
      displayStart: start,
      displayEnd: end,
      secondary: false,
    };
  }
  return {
    actualStart: start,
    actualEnd: end,
    displayStart: mapTimeToWindow(start),
    displayEnd: mapTimeToWindow(end),
    secondary: true,
  };
}

function mapTimeToWindow(time) {
  const window = state.settings.displayWindow;
  const start = timeToMinutes(window.start);
  const end = timeToMinutes(window.end);
  const duration = Math.max(1, end - start);
  const ratio = timeToMinutes(time) / 1440;
  return minutesToTime(Math.min(end, Math.round(start + ratio * duration)));
}

function saveTaskFromForm(event) {
  event.preventDefault();
  const title = el.taskTitle.value.trim();
  if (!title) {
    toast("اكتب اسم المهمة");
    return;
  }
  if (timeToMinutes(el.taskEndTime.value) <= timeToMinutes(el.taskTime.value)) {
    toast("وقت الانتهاء لازم يكون بعد وقت الظهور في نفس اليوم");
    return;
  }
  const existingId = el.taskId.value;
  const existing = existingId ? getTask(existingId) : null;
  const now = new Date().toISOString();
  const task = normalizeTask({
    id: existingId || uid("task"),
    title,
    description: el.taskDescription.value.trim(),
    startDate: el.taskStartDate.value || todayISO(),
    recurrence: el.taskRecurrence.value,
    intervalDays: Number(el.taskInterval.value || 1),
    dependencyId: el.taskDependency.value,
    time: el.taskTime.value,
    endTime: el.taskEndTime.value,
    requiredOverdue: el.taskRequiredOverdue.checked,
    importance: selectedImportance,
    active: el.taskActive.checked,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
  });

  if (existing) {
    state.tasks = state.tasks.map((item) => (item.id === existing.id ? task : item));
  } else {
    state.tasks.push(task);
  }
  saveState();
  clearTaskForm();
  refreshSchedule();
  render();
  toast("تم حفظ المهمة");
}

function clearTaskForm() {
  el.taskId.value = "";
  el.taskTitle.value = "";
  el.taskDescription.value = "";
  el.taskStartDate.value = todayISO();
  el.taskRecurrence.value = "daily";
  el.taskInterval.value = "3";
  el.taskDependency.value = "";
  el.taskTime.value = "08:00";
  el.taskEndTime.value = "09:00";
  el.taskRequiredOverdue.checked = false;
  el.taskActive.checked = true;
  selectedImportance = 6;
  renderImportanceButtons();
  syncIntervalState();
}

function fillTaskForm(id) {
  const task = getTask(id);
  if (!task) return;
  switchView("settings");
  el.taskId.value = task.id;
  el.taskTitle.value = task.title;
  el.taskDescription.value = task.description;
  el.taskStartDate.value = task.startDate;
  el.taskRecurrence.value = task.recurrence;
  el.taskInterval.value = task.intervalDays;
  el.taskDependency.value = task.dependencyId || "";
  el.taskTime.value = task.time;
  el.taskEndTime.value = task.endTime;
  el.taskRequiredOverdue.checked = task.requiredOverdue;
  el.taskActive.checked = task.active;
  selectedImportance = task.importance;
  renderImportanceButtons();
  syncIntervalState();
  el.taskTitle.focus();
}

function deleteTask(id) {
  const task = getTask(id);
  if (!task) return;
  if (!confirm(`حذف إعداد "${task.title}"؟`)) return;
  state.tasks = state.tasks.filter((item) => item.id !== id);
  Object.keys(state.instances).forEach((instanceIdValue) => {
    const instance = state.instances[instanceIdValue];
    if (instance.taskId === id && instance.status === "main") {
      delete state.instances[instanceIdValue];
    }
  });
  saveState();
  refreshSchedule();
  render();
  toast("تم حذف إعداد المهمة");
}

function saveDisplayWindow() {
  const enabled = el.windowEnabled.checked;
  const start = el.windowStart.value || "00:00";
  const end = el.windowEnd.value || "23:59";
  if (enabled && timeToMinutes(end) <= timeToMinutes(start)) {
    toast("حد الظهور لازم يكون داخل نفس اليوم وبوقت نهاية بعد البداية");
    return;
  }
  state.settings.displayWindow = { enabled, start, end };
  saveState();
  refreshSchedule();
  render();
  toast("تم حفظ حد الظهور");
}

function saveSettingsSnapshot() {
  const createdAt = new Date().toISOString();
  state.settings.snapshots.unshift({
    id: uid("settings"),
    name: `إعدادات ${formatDateTime(createdAt)}`,
    createdAt,
    tasks: clone(state.tasks),
    displayWindow: clone(state.settings.displayWindow),
  });
  state.settings.snapshots = state.settings.snapshots.slice(0, 30);
  saveState();
  render();
  toast("تم حفظ نسخة الإعدادات");
}

function loadSettingsSnapshot(id) {
  const snapshot = state.settings.snapshots.find((item) => item.id === id);
  if (!snapshot) return;
  state.tasks = snapshot.tasks.map(normalizeTask).filter(Boolean);
  state.settings.displayWindow = { ...initialState().settings.displayWindow, ...snapshot.displayWindow };
  keepInstancesForCurrentTasks();
  saveState();
  refreshSchedule();
  render();
  toast("تم تطبيق نسخة الإعدادات");
}

function deleteSettingsSnapshot(id) {
  state.settings.snapshots = state.settings.snapshots.filter((item) => item.id !== id);
  saveState();
  render();
  toast("تم حذف نسخة الإعدادات");
}

function exportSettingsFile() {
  const payload = {
    kind: "ifal-settings",
    exportedAt: new Date().toISOString(),
    tasks: state.tasks,
    settings: {
      displayWindow: state.settings.displayWindow,
    },
  };
  downloadText(`ifal-settings-${todayISO()}.txt`, JSON.stringify(payload, null, 2));
  toast("تم إصدار ملف الإعدادات");
}

async function importSettingsFile(file) {
  if (!file) return;
  try {
    const payload = parsePayload(await file.text());
    const data = payload.kind === "ifal-settings" ? payload : payload.data || payload;
    if (!Array.isArray(data.tasks)) throw new Error("missing tasks");
    state.tasks = data.tasks.map(normalizeTask).filter(Boolean);
    if (data.settings && data.settings.displayWindow) {
      state.settings.displayWindow = {
        ...initialState().settings.displayWindow,
        ...data.settings.displayWindow,
      };
    }
    state.settings.snapshots.unshift({
      id: uid("settings"),
      name: `إدخال ${file.name}`,
      createdAt: new Date().toISOString(),
      tasks: clone(state.tasks),
      displayWindow: clone(state.settings.displayWindow),
    });
    keepInstancesForCurrentTasks();
    saveState();
    refreshSchedule();
    render();
    toast("تم إدخال الإعدادات");
  } catch {
    toast("لم أستطع قراءة ملف الإعدادات");
  } finally {
    el.importSettings.value = "";
  }
}

function exportDataFile() {
  refreshSchedule();
  const payload = {
    kind: "ifal-data",
    exportedAt: new Date().toISOString(),
    data: state,
  };
  downloadText(`ifal-data-${todayISO()}.txt`, JSON.stringify(payload, null, 2));
  toast("تم إصدار ملف البيانات");
}

function mergeIncomingState(incoming) {
  const taskMap = new Map(state.tasks.map((task) => [task.id, task]));
  incoming.tasks.forEach((task) => {
    const current = taskMap.get(task.id);
    if (!current || new Date(task.updatedAt) >= new Date(current.updatedAt)) {
      taskMap.set(task.id, task);
    }
  });
  state.tasks = Array.from(taskMap.values()).map(normalizeTask).filter(Boolean);

  Object.values(incoming.instances).forEach((instance) => {
    const current = state.instances[instance.id];
    if (!current || new Date(instance.updatedAt) >= new Date(current.updatedAt)) {
      state.instances[instance.id] = instance;
    }
  });

  if (incoming.settings && incoming.settings.displayWindow) {
    state.settings.displayWindow = {
      ...state.settings.displayWindow,
      ...incoming.settings.displayWindow,
    };
  }

  const snapshotIds = new Set(state.settings.snapshots.map((item) => item.id));
  incoming.settings.snapshots.forEach((snapshot) => {
    if (!snapshotIds.has(snapshot.id)) state.settings.snapshots.push(snapshot);
  });
}

function resetRuntimeData() {
  if (!confirm("إعادة الضبط ستحذف بيانات التنفيذ والقوائم وتبقي إعدادات المهام. هل تريد المتابعة؟")) return;
  state.instances = {};
  state.imports = [];
  selectedNever.clear();
  saveState();
  refreshSchedule();
  render();
  toast("تمت إعادة الضبط");
}

function keepInstancesForCurrentTasks() {
  const ids = new Set(state.tasks.map((task) => task.id));
  Object.keys(state.instances).forEach((id) => {
    if (!ids.has(state.instances[id].taskId)) delete state.instances[id];
  });
}

function completeInstance(id) {
  const instance = state.instances[id];
  if (!instance) return;
  const previous = instance.status;
  moveInstanceStatus(instance, "completed", "تم التنفيذ");
  instance.completedAt = new Date().toISOString();
  instance.completedFrom = previous;
  saveState();
  refreshSchedule();
  render();
  toast("تم تنفيذ المهمة");
}

function moveInstance(id, status, reason) {
  const instance = state.instances[id];
  if (!instance) return;
  moveInstanceStatus(instance, status, reason);
  saveState();
  refreshSchedule();
  render();
  toast("تم نقل المهمة");
}

function moveInstanceStatus(instance, status, reason) {
  const now = new Date().toISOString();
  instance.status = status;
  instance.movedAt = now;
  instance.updatedAt = now;
  instance.history = instance.history || [];
  instance.history.push({ at: now, action: reason || status });
}

function deleteInstance(id) {
  const instance = state.instances[id];
  if (!instance) return;
  if (!confirm(`حذف "${instance.title}"؟`)) return;
  delete state.instances[id];
  selectedNever.delete(id);
  saveState();
  render();
  toast("تم حذف المهمة");
}

function excludeInstanceFromStats(id) {
  const instance = state.instances[id];
  if (!instance) return;
  if (!confirm(`حذف "${instance.title}" من الإحصائيات نهائيًا؟`)) return;
  const excluded = new Set(state.settings.statsExcludedInstanceIds || []);
  excluded.add(id);
  state.settings.statsExcludedInstanceIds = Array.from(excluded);
  saveState();
  renderStats();
  toast("تم حذفها من الإحصائيات");
}

function selectFirstTenNever() {
  const neverItems = getInstancesByStatus("never").slice(0, 10);
  neverItems.forEach((item) => selectedNever.add(item.id));
  renderNever();
  toast("تم تحديد أول 10 مهام");
}

function deleteSelectedNever() {
  const ids = Array.from(selectedNever).filter((id) => state.instances[id]?.status === "never");
  if (!ids.length) {
    toast("لا توجد مهام محددة");
    return;
  }
  if (!confirm(`حذف ${ids.length} مهمة؟`)) return;
  ids.forEach((id) => delete state.instances[id]);
  selectedNever.clear();
  saveState();
  render();
  toast("تم حذف المهام المحددة");
}

function deleteAllNever() {
  const ids = getInstancesByStatus("never").map((item) => item.id);
  if (!ids.length) {
    toast("لا توجد مهام للحذف");
    return;
  }
  if (!confirm(`حذف كل مهام القائمة وعددها ${ids.length}؟`)) return;
  ids.forEach((id) => delete state.instances[id]);
  selectedNever.clear();
  saveState();
  render();
  toast("تم حذف الكل");
}

function handleActionClick(event) {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const id = button.dataset.id;
  const action = button.dataset.action;
  if (action === "complete") completeInstance(id);
  if (action === "cancel-never") moveInstance(id, "never", "إلغاء: لم تنفذ");
  if (action === "soft-delete") moveInstance(id, "deleted", "حذف التفعيل الحالي");
  if (action === "move-required") moveInstance(id, "requiredOverdue", "نقل للمهام الواجبة");
  if (action === "move-optional") moveInstance(id, "optionalOverdue", "نقل للمهام غير المهمة");
  if (action === "move-never") moveInstance(id, "never", "نقل للمهام التي لم تنفذ");
  if (action === "move-completed") completeInstance(id);
  if (action === "restore-main") moveInstance(id, "main", "رجوع للقائمة الرئيسية");
  if (action === "delete-instance") deleteInstance(id);
  if (action === "edit-task") fillTaskForm(id);
  if (action === "delete-task") deleteTask(id);
  if (action === "load-snapshot") loadSettingsSnapshot(id);
  if (action === "delete-snapshot") deleteSettingsSnapshot(id);
  if (action === "delete-stat-instance") excludeInstanceFromStats(id);
  if (action === "admin-reveal") openAdminReveal(button.dataset.username);
}

function handleSelectionChange(event) {
  const checkbox = event.target.closest("input[data-never-select]");
  if (!checkbox) return;
  if (checkbox.checked) {
    selectedNever.add(checkbox.value);
  } else {
    selectedNever.delete(checkbox.value);
  }
}

function render() {
  applyTheme();
  el.viewTitle.textContent = titles[currentView];
  el.todayLabel.textContent = `${formatDate(todayISO())} • ${formatClock(new Date())}`;
  el.userBadge.textContent = state.user ? state.user.name : "غير مسجل";
  if (el.mobileUserBadge) {
    el.mobileUserBadge.textContent = state.user ? state.user.name : "\u063a\u064a\u0631 \u0645\u0633\u062c\u0644";
  }
  renderDependencyOptions();
  renderWindowControls();
  renderImportanceButtons();
  if (currentView === "main") renderMain();
  if (currentView === "settings") renderSettings();
  if (currentView === "required") renderRequired();
  if (currentView === "optional") renderOptional();
  if (currentView === "never") renderNever();
  if (currentView === "deleted") renderDeleted();
  if (currentView === "completed") renderCompleted();
  if (currentView === "stats") renderStats();
  if (currentView === "account") renderAccount();
  if (currentView === "admin") renderAdmin();
  if (currentView === "adminReveal") renderAdminReveal();
}

function renderMain() {
  const allMain = getInstancesByStatus("main");
  const active = allMain.filter(isInstanceVisibleNow);
  const upcoming = allMain.filter(isInstanceUpcoming);
  const required = getInstancesByStatus("requiredOverdue").length;
  const completedToday = getInstancesByStatus("completed").filter((item) => item.date === todayISO()).length;

  el.mainSummary.innerHTML = [
    metric(active.length, "جاهزة الآن"),
    metric(upcoming.length, "قادمة اليوم"),
    metric(required, "واجبة لم تتم"),
    metric(completedToday, "تمت اليوم"),
  ].join("");

  el.activeCount.textContent = `${active.length} مهمة`;
  el.upcomingCount.textContent = `${upcoming.length} مهمة`;
  renderTaskList(el.activeTasks, active, "main");
  renderTaskList(el.upcomingTasks, upcoming, "upcoming");
}

function renderSettings() {
  renderTaskList(el.settingsTasks, state.tasks.slice().sort(sortTasks), "settings");
  renderSettingsHistory();
  el.taskSettingsCount.textContent = `${state.tasks.length} مهمة`;
  el.settingsCount.textContent = `${state.settings.snapshots.length} نسخة`;
}

function renderRequired() {
  renderTaskList(el.requiredTasks, getInstancesByStatus("requiredOverdue"), "required");
}

function renderOptional() {
  renderTaskList(el.optionalTasks, getInstancesByStatus("optionalOverdue"), "optional");
}

function renderNever() {
  renderTaskList(el.neverTasks, getInstancesByStatus("never"), "never");
}

function renderDeleted() {
  renderTaskList(el.deletedTasks, getInstancesByStatus("deleted"), "deleted");
}

function renderCompleted() {
  renderTaskList(el.completedTasks, getInstancesByStatus("completed"), "completed");
}

function renderAccount() {
  const user = state.user;
  if (!user) {
    el.accountSyncState.textContent = "غير مسجل";
    el.accountDetails.innerHTML = emptyState("سجل الدخول لعرض معلومات الحساب");
    el.storageExplanation.textContent =
      "بدون تسجيل دخول، يتم حفظ البيانات داخل هذا المتصفح فقط ولا تنتقل إلى جهاز آخر.";
    return;
  }

  const passwordText = passwordVisible ? user.password || "غير محفوظة" : maskPassword(user.password);
  el.accountSyncState.textContent = state.sync.mode === "cloud" ? "مزامن" : "محلي";
  el.showPassword.textContent = passwordVisible ? "إخفاء كلمة المرور" : "إظهار كلمة المرور";
  el.accountDetails.innerHTML = `
    ${accountRow("الاسم", user.name || "غير محدد")}
    ${accountRow("اسم المستخدم", user.username || "غير محدد")}
    ${accountRow("البريد", user.email || "غير محدد")}
    ${accountRow("كلمة المرور", passwordText)}
    ${accountRow("آخر دخول", user.loggedInAt ? formatDateTime(user.loggedInAt) : "غير محدد")}
    ${accountRow("آخر مزامنة", state.sync.lastSyncAt ? formatDateTime(state.sync.lastSyncAt) : "لم تتم بعد")}
  `;
  el.storageExplanation.textContent =
    state.sync.mode === "cloud"
      ? "بياناتك محفوظة في PostgreSQL على Render، لذلك تظهر على الكمبيوتر والجوال عند تسجيل الدخول بنفس اسم المستخدم وكلمة المرور."
      : state.sync.lastError || "البيانات محفوظة داخل هذا الجهاز فقط. بعد رفع الموقع على Render ستعمل المزامنة بين الأجهزة.";
}

function accountRow(label, value) {
  return `<div class="account-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

async function renderAdmin() {
  if (!isAdmin) {
    if (el.adminUserList) el.adminUserList.innerHTML = emptyState("هذه الصفحة للادمن فقط");
    if (el.adminUserCount) el.adminUserCount.textContent = "";
    return;
  }

  if (el.adminUserList) {
    el.adminUserList.innerHTML = emptyState("جاري تحميل الأسماء...");
  }

  try {
    await loadAdminUsers(true);
  } catch (error) {
    if (el.adminUserList) {
      el.adminUserList.innerHTML = emptyState(error.message || "تعذر تحميل قائمة المستخدمين");
    }
    if (el.adminUserCount) el.adminUserCount.textContent = "";
    return;
  }

  if (el.adminUserCount) {
    el.adminUserCount.textContent = `${adminUsers.length} مستخدم`;
  }

  if (!el.adminUserList) return;
  if (!adminUsers.length) {
    el.adminUserList.innerHTML = emptyState("لا يوجد مستخدمون بعد");
    return;
  }

  el.adminUserList.innerHTML = adminUsers
    .map(
      (username) => `
        <div class="admin-user-row">
          <strong>${escapeHtml(username)}</strong>
          <button class="ghost-button admin-reveal-button" data-action="admin-reveal" data-username="${escapeHtml(username)}" type="button">كشف</button>
        </div>
      `,
    )
    .join("");
}

function renderAdminReveal() {
  if (!isAdmin) {
    if (el.adminRevealProfile) el.adminRevealProfile.innerHTML = emptyState("هذه الصفحة للادمن فقط");
    if (el.adminRevealTasks) el.adminRevealTasks.innerHTML = "";
    return;
  }

  if (el.adminRevealTitle) {
    el.adminRevealTitle.textContent = adminRevealTarget ? `كشف: ${adminRevealTarget}` : "كشف";
  }

  if (adminRevealLoading) {
    if (el.adminRevealProfile) el.adminRevealProfile.innerHTML = emptyState("جاري جلب بيانات الكشف...");
    if (el.adminRevealTasks) el.adminRevealTasks.innerHTML = "";
    return;
  }

  if (!adminRevealData) {
    if (el.adminRevealProfile) el.adminRevealProfile.innerHTML = emptyState("لا توجد بيانات للعرض");
    if (el.adminRevealTasks) el.adminRevealTasks.innerHTML = "";
    return;
  }

  const user = adminRevealData.user || {};
  const month = adminRevealData.month || {};
  const tasks = Array.isArray(adminRevealData.tasks) ? adminRevealData.tasks : [];

  if (el.adminRevealProfile) {
    el.adminRevealProfile.innerHTML = `
      <div class="admin-profile-grid">
        ${accountRow("اسم المستخدم", user.username || adminRevealTarget)}
        ${accountRow("الاسم", user.name || "غير محدد")}
        ${accountRow("البريد", user.email || "غير محدد")}
        ${accountRow("آخر دخول", user.lastLogin ? formatDateTime(user.lastLogin) : "غير محدد")}
        ${accountRow("سجل الشهر", month.label || "الشهر الحالي")}
      </div>
    `;
  }

  if (!el.adminRevealTasks) return;
  if (!tasks.length) {
    el.adminRevealTasks.innerHTML = emptyState("لا توجد مهام مسجلة لهذا المستخدم");
    return;
  }

  el.adminRevealTasks.innerHTML = tasks
    .map((task) => {
      const meta = [
        `آخر دخول: ${user.lastLogin ? formatDateTime(user.lastLogin) : "غير محدد"}`,
        `أُضيفت: ${task.createdAt ? formatDateTime(task.createdAt) : "غير محدد"}`,
        `الظهور: ${formatTimeRange(task.appearanceFrom, task.appearanceTo)}`,
        `آخر ظهور: ${task.lastAppearance ? formatDate(task.lastAppearance) : "لا يوجد هذا الشهر"}`,
        `آخر إتمام: ${task.lastCompletion ? formatDateTime(task.lastCompletion) : "لا يوجد هذا الشهر"}`,
        `مرات الإتمام: ${Number(task.completionCount || 0)}`,
      ].join(" • ");

      return `
        <article class="admin-task-item">
          <h4>${escapeHtml(task.title || "مهمة بدون اسم")}${task.active === false ? ' <span class="pill">معطلة</span>' : ""}</h4>
          <p class="admin-task-meta">${escapeHtml(meta)}</p>
        </article>
      `;
    })
    .join("");
}

function formatTimeRange(from, to) {
  if (!from && !to) return "غير محدد";
  if (!from || !to) return from || to || "غير محدد";
  return `${from} → ${to}`;
}

function maskPassword(password) {
  if (!password) return "غير محفوظة";
  return "•".repeat(Math.min(12, Math.max(4, password.length)));
}

function renderTaskList(container, items, type) {
  if (!items.length) {
    container.innerHTML = emptyState("لا توجد مهام");
    return;
  }
  container.innerHTML = items
    .map((item) => (type === "settings" ? taskSettingCard(item) : taskInstanceCard(item, type)))
    .join("");
}

function taskInstanceCard(instance, type) {
  const times = getInstanceTimes(instance);
  const importance = instance.importance || 6;
  const secondary = times.secondary
    ? `<span class="pill green">الوقت الثانوي ${formatTime(times.displayStart)} - ${formatTime(times.displayEnd)}</span>`
    : "";
  const selected = selectedNever.has(instance.id) ? "checked" : "";
  const checkbox =
    type === "never"
      ? `<label class="check-row"><input data-never-select value="${instance.id}" type="checkbox" ${selected} /><span>تحديد</span></label>`
      : "";
  const completed = instance.completedAt
    ? `<span class="pill green">تم ${formatDateTime(instance.completedAt)}</span>`
    : "";
  const statusPill = statusLabel(instance.status);
  const deletedExpiry =
    type === "deleted"
      ? `<span class="pill amber">تحذف تلقائيًا بعد ${deletedDaysLeft(instance)} يوم</span>`
      : "";

  return `
    <article class="task-card" data-importance="${importance}">
      <div class="task-main">
        <div class="task-title-row">
          <h4>${escapeHtml(instance.title)}</h4>
          <span class="pill">${importance} ${importanceLabels[importance]}</span>
          ${statusPill}
        </div>
        ${instance.description ? `<p>${escapeHtml(instance.description)}</p>` : ""}
        <div class="meta-row">
          <span class="pill">اليوم ${formatDate(instance.date)}</span>
          <span class="pill">الوقت الحقيقي ${formatTime(times.actualStart)} - ${formatTime(times.actualEnd)}</span>
          ${secondary}
          ${instance.requiredOverdue ? `<span class="pill amber">ينتقل للواجبة</span>` : `<span class="pill">غير واجبة عند الانتهاء</span>`}
          ${completed}
          ${deletedExpiry}
        </div>
        ${checkbox}
      </div>
      <div class="task-actions">
        ${instanceActions(instance, type)}
      </div>
    </article>
  `;
}

function taskSettingCard(task) {
  const dependency = task.dependencyId ? getTask(task.dependencyId) : null;
  const fakeInstance = { ...task, taskId: task.id, date: todayISO(), status: "main" };
  const times = getInstanceTimes(fakeInstance);
  const secondary = times.secondary ? `<span class="pill green">ثانوي ${formatTime(times.displayStart)} - ${formatTime(times.displayEnd)}</span>` : "";
  return `
    <article class="task-card" data-importance="${task.importance}">
      <div class="task-main">
        <div class="task-title-row">
          <h4>${escapeHtml(task.title)}</h4>
          <span class="pill">${task.importance} ${importanceLabels[task.importance]}</span>
          ${task.active ? `<span class="pill green">مفعلة</span>` : `<span class="pill red">متوقفة</span>`}
        </div>
        ${task.description ? `<p>${escapeHtml(task.description)}</p>` : ""}
        <div class="meta-row">
          <span class="pill">${recurrenceLabel(task)}</span>
          <span class="pill">من ${formatDate(task.startDate)}</span>
          <span class="pill">حقيقي ${formatTime(task.time)} - ${formatTime(task.endTime)}</span>
          ${secondary}
          ${dependency ? `<span class="pill amber">بعد ${escapeHtml(dependency.title)}</span>` : ""}
          ${task.requiredOverdue ? `<span class="pill amber">ينتقل للواجبة</span>` : `<span class="pill">غير واجبة عند الانتهاء</span>`}
        </div>
      </div>
      <div class="task-actions">
        <button class="ghost-button" data-action="edit-task" data-id="${task.id}" type="button">تعديل</button>
        <button class="danger-button" data-action="delete-task" data-id="${task.id}" type="button">حذف</button>
      </div>
    </article>
  `;
}

function instanceActions(instance, type) {
  if (type === "upcoming") {
    return `
      <button class="primary-button" data-action="complete" data-id="${instance.id}" type="button">تم</button>
      <button class="ghost-button" data-action="cancel-never" data-id="${instance.id}" type="button">إلغاء لم تنفذ</button>
      <button class="ghost-button danger" data-action="soft-delete" data-id="${instance.id}" type="button">حذف</button>
      <button class="ghost-button" data-action="edit-task" data-id="${instance.taskId}" type="button">الإعداد</button>
    `;
  }
  if (type === "main") {
    return `
      <button class="primary-button" data-action="complete" data-id="${instance.id}" type="button">تم</button>
      <button class="ghost-button" data-action="cancel-never" data-id="${instance.id}" type="button">إلغاء لم تنفذ</button>
      <button class="ghost-button danger" data-action="soft-delete" data-id="${instance.id}" type="button">حذف</button>
      <button class="ghost-button" data-action="edit-task" data-id="${instance.taskId}" type="button">الإعداد</button>
    `;
  }
  if (type === "required") {
    return `
      <button class="primary-button" data-action="complete" data-id="${instance.id}" type="button">تم</button>
      <button class="ghost-button" data-action="restore-main" data-id="${instance.id}" type="button">إرجاع للرئيسية</button>
      <button class="ghost-button" data-action="move-optional" data-id="${instance.id}" type="button">ليست مهمة</button>
      <button class="danger-button" data-action="delete-instance" data-id="${instance.id}" type="button">حذف</button>
    `;
  }
  if (type === "optional") {
    return `
      <button class="ghost-button" data-action="move-required" data-id="${instance.id}" type="button">نقل للواجبة</button>
      <button class="danger-button" data-action="delete-instance" data-id="${instance.id}" type="button">حذف</button>
    `;
  }
  if (type === "never") {
    return `
      <button class="ghost-button" data-action="restore-main" data-id="${instance.id}" type="button">إرجاع للرئيسية</button>
      <button class="ghost-button" data-action="move-required" data-id="${instance.id}" type="button">إرجاع للواجبة</button>
      <button class="ghost-button" data-action="move-optional" data-id="${instance.id}" type="button">إرجاع لليست مهمة</button>
      <button class="danger-button" data-action="delete-instance" data-id="${instance.id}" type="button">حذف</button>
    `;
  }
  if (type === "deleted") {
    return `
      <button class="ghost-button" data-action="restore-main" data-id="${instance.id}" type="button">إرجاع للرئيسية</button>
      <button class="ghost-button" data-action="move-required" data-id="${instance.id}" type="button">إرجاع للواجبة</button>
      <button class="ghost-button" data-action="move-optional" data-id="${instance.id}" type="button">إرجاع لليست مهمة</button>
      <button class="ghost-button" data-action="move-never" data-id="${instance.id}" type="button">إرجاع لغير المنفذة</button>
      <button class="ghost-button" data-action="move-completed" data-id="${instance.id}" type="button">إرجاع للمنفذة</button>
      <button class="danger-button" data-action="delete-instance" data-id="${instance.id}" type="button">حذف نهائي</button>
    `;
  }
  if (type === "completed") {
    return `
      <button class="ghost-button" data-action="restore-main" data-id="${instance.id}" type="button">إرجاع للرئيسية</button>
      <button class="danger-button" data-action="delete-instance" data-id="${instance.id}" type="button">حذف</button>
    `;
  }
  return "";
}

function statusLabel(status) {
  if (status === "main") return `<span class="pill green">رئيسية</span>`;
  if (status === "requiredOverdue") return `<span class="pill amber">واجبة</span>`;
  if (status === "optionalOverdue") return `<span class="pill">ليست مهمة</span>`;
  if (status === "never") return `<span class="pill red">لم تنفذ</span>`;
  if (status === "deleted") return `<span class="pill red">محذوفة</span>`;
  if (status === "completed") return `<span class="pill green">تم التنفيذ</span>`;
  return "";
}

function statusText(status) {
  if (status === "main") return "رئيسية";
  if (status === "requiredOverdue") return "واجبة";
  if (status === "optionalOverdue") return "ليست مهمة";
  if (status === "never") return "لم تنفذ";
  if (status === "deleted") return "محذوفة";
  if (status === "completed") return "تم التنفيذ";
  return "غير محددة";
}

function renderSettingsHistory() {
  el.settingsHistory.innerHTML = state.settings.snapshots.length
    ? state.settings.snapshots
        .map(
          (item) => `
            <div class="history-item">
              <div>
                <strong>${escapeHtml(item.name)}</strong>
                <small>${formatDateTime(item.createdAt)} • ${item.tasks.length} مهمة</small>
              </div>
              <div class="button-row compact">
                <button class="ghost-button" data-action="load-snapshot" data-id="${item.id}" type="button">اختيار</button>
                <button class="danger-button" data-action="delete-snapshot" data-id="${item.id}" type="button">حذف</button>
              </div>
            </div>
          `,
        )
        .join("")
    : emptyState("لا توجد نسخ إعدادات");
}

function renderStats() {
  const today = todayISO();
  const yesterday = addDays(today, -1);
  const todayStats = statsForDates([today]);
  const yesterdayStats = statsForDates([yesterday]);
  const weekDates = rangeDates(startOfWeek(today), today);
  const previousWeekStart = addDays(startOfWeek(today), -7);
  const previousWeekDates = rangeDates(previousWeekStart, addDays(previousWeekStart, 6));
  const monthDates = rangeDates(startOfMonth(today), today);
  const previousMonthStart = startOfPreviousMonth(today);
  const previousMonthDates = rangeDates(previousMonthStart, endOfMonth(previousMonthStart));
  const monthStats = statsForDates(monthDates);
  const weekStats = statsForDates(weekDates);

  el.statsSummary.innerHTML = [
    metric(`${todayStats.rate}%`, "إنجاز اليوم"),
    metric(`${weekStats.rate}%`, "إنجاز الأسبوع"),
    metric(`${monthStats.rate}%`, "إنجاز الشهر"),
    metric(statEligibleInstances().filter((item) => item.status === "completed").length, "كل المنفذ"),
  ].join("");

  el.dailyCompare.textContent = compareText(todayStats.rate, yesterdayStats.rate);
  el.weeklyCompare.textContent = compareText(weekStats.rate, statsForDates(previousWeekDates).rate);
  el.monthlyCompare.textContent = compareText(monthStats.rate, statsForDates(previousMonthDates).rate);
  el.dailyStats.innerHTML = statBlock(todayStats);
  el.weeklyStats.innerHTML = statBlock(weekStats);
  el.monthlyStats.innerHTML = statBlock(monthStats);
  el.importanceStats.innerHTML = importanceStatsBlock();
  renderStatsSettings();
}

function statsForDates(dates) {
  const dateSet = new Set(dates);
  const items = statEligibleInstances().filter((item) => dateSet.has(item.date));
  const total = items.length;
  const completed = items.filter((item) => item.status === "completed").length;
  const missed = Math.max(0, total - completed);
  const rate = total ? Math.round((completed / total) * 100) : 0;
  return { total, completed, missed, rate };
}

function statBlock(stats) {
  return `
    ${statLine("تم تنفيذها", stats.completed, stats.total, "green")}
    ${statLine("لم تنفذ", stats.missed, stats.total, stats.missed ? "amber" : "green")}
    ${statLine("النسبة", stats.rate, 100, stats.rate >= 70 ? "green" : stats.rate >= 40 ? "amber" : "red", "%")}
  `;
}

function importanceStatsBlock() {
  return [2, 4, 6, 8, 10]
    .map((importance) => {
      const items = statEligibleInstances().filter((item) => Number(item.importance) === importance);
      const total = items.length;
      const completed = items.filter((item) => item.status === "completed").length;
      const rate = total ? Math.round((completed / total) * 100) : 0;
      return statLine(`${importance} ${importanceLabels[importance]}`, rate, 100, rate >= 70 ? "green" : rate >= 40 ? "amber" : "red", "%");
    })
    .join("");
}

function renderStatsSettings() {
  const items = statEligibleInstances().sort(sortInstances);
  el.statsSourceCount.textContent = `${items.length} سجل`;
  el.statsSettingsToggle.textContent = statsSettingsOpen ? "إغلاق" : "فتح";
  el.statsSourceList.classList.toggle("hidden", !statsSettingsOpen);
  if (!statsSettingsOpen) return;
  el.statsSourceList.innerHTML = items.length
    ? items
        .map((item) => {
          const task = getTask(item.taskId);
          return `
            <div class="history-item">
              <div>
                <strong>${escapeHtml(item.title)}</strong>
                <small>${formatDate(item.date)} • ${statusText(item.status)} • ${task ? recurrenceLabel(task) : "سجل منفصل"}</small>
              </div>
              <div class="button-row compact">
                <button class="danger-button" data-action="delete-stat-instance" data-id="${item.id}" type="button">حذف من الإحصائيات</button>
              </div>
            </div>
          `;
        })
        .join("")
    : emptyState("لا توجد سجلات تعتمد عليها الإحصائيات");
}

function statEligibleInstances() {
  const excluded = new Set(state.settings.statsExcludedInstanceIds || []);
  return Object.values(state.instances).filter((item) => item && item.status !== "deleted" && !excluded.has(item.id));
}

function statLine(label, value, total, tone, suffix = "") {
  const denominator = Math.max(1, total);
  const percent = Math.min(100, Math.round((Number(value) / denominator) * 100));
  return `
    <div class="stat-line">
      <div class="stat-text"><span>${label}</span><strong>${value}${suffix}</strong></div>
      <div class="bar ${tone}"><span style="width:${percent}%"></span></div>
    </div>
  `;
}

function renderDependencyOptions() {
  const current = el.taskId.value;
  const selected = el.taskDependency.value;
  const availableTasks = availableDependencyTasks(current);
  const options = [`<option value="">بدون ربط</option>`]
    .concat(
      availableTasks
        .sort(sortTasks)
        .map((task) => `<option value="${task.id}">${escapeHtml(task.title)}</option>`),
    )
    .join("");
  el.taskDependency.innerHTML = options;
  const selectedIsAvailable = availableTasks.some((task) => task.id === selected);
  el.taskDependency.value = selectedIsAvailable ? selected : "";
  el.taskDependency.disabled = availableTasks.length === 0;
  if (el.dependencyHint) {
    el.dependencyHint.textContent = availableTasks.length
      ? "تظهر هنا جميع المهام المتاحة للربط."
      : "لا توجد مهام متاحة للربط حالياً.";
  }
}

function availableDependencyTasks(currentTaskId) {
  return state.tasks.filter((task) => {
    // إظهار كل المهمات النشطة عدا المهمة الحالية نفسها لمنع الربط الدائري
    return task.id !== currentTaskId && task.active;
  });
}

function renderWindowControls() {
  const window = state.settings.displayWindow;
  el.windowEnabled.checked = window.enabled;
  el.windowStart.value = window.start;
  el.windowEnd.value = window.end;
  el.windowStatus.textContent = window.enabled ? `${formatTime(window.start)} - ${formatTime(window.end)}` : "الوقت الحقيقي";
}

function renderImportanceButtons() {
  el.importanceButtons.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.importance) === selectedImportance);
  });
}

function syncIntervalState() {
  const custom = el.taskRecurrence.value === "custom";
  el.taskInterval.disabled = !custom;
  if (el.intervalHint) {
    el.intervalHint.textContent = custom
      ? "هذا الرقم هو عدد الأيام بين كل ظهور للمهمة."
      : "يفتح هذا الخيار فقط عند اختيار تكرار: كل عدد أيام.";
  }
}

function getInstancesByStatus(status) {
  return Object.values(state.instances)
    .filter((item) => item.status === status)
    .sort(sortInstances);
}

function getTask(id) {
  return state.tasks.find((task) => task.id === id);
}

function sortTasks(a, b) {
  return a.time.localeCompare(b.time) || a.title.localeCompare(b.title, "ar");
}

function sortInstances(a, b) {
  const timeA = getInstanceTimes(a).displayStart;
  const timeB = getInstanceTimes(b).displayStart;
  return a.date.localeCompare(b.date) || timeA.localeCompare(timeB) || a.title.localeCompare(b.title, "ar");
}

function recurrenceLabel(task) {
  if (task.recurrence === "once") return "مرة واحدة";
  if (task.recurrence === "daily") return "كل يوم";
  if (task.recurrence === "weekly") return "كل أسبوع";
  if (task.recurrence === "monthly") return "كل شهر";
  if (task.recurrence === "custom") return `كل ${task.intervalDays} يوم`;
  return "";
}

function metric(value, label) {
  return `<div class="metric"><strong>${value}</strong><span>${label}</span></div>`;
}

function emptyState(text) {
  return `<div class="empty">${text}</div>`;
}

function parsePayload(text) {
  return JSON.parse(text.replace(/^\uFEFF/, ""));
}

function downloadText(filename, text) {
  downloadBlob(filename, text, "text/plain;charset=utf-8");
}

function downloadBlob(filename, text, type) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const typedBlob = type ? new Blob([text], { type }) : blob;
  const url = URL.createObjectURL(typedBlob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

function assetUrl(path) {
  return new URL(path, location.href).toString();
}

function toast(message) {
  el.toast.textContent = message;
  el.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove("show"), 2600);
}

function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function instanceId(taskId, date) {
  return `${taskId}:${date}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function todayISO(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDate(date) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function addDays(date, amount) {
  const next = parseDate(date);
  next.setDate(next.getDate() + amount);
  return todayISO(next);
}

function daysBetween(start, end) {
  const first = parseDate(start);
  const second = parseDate(end);
  return Math.round((second - first) / 86400000);
}

function forEachDate(start, end, callback) {
  let current = start;
  while (current <= end) {
    callback(current);
    current = addDays(current, 1);
  }
}

function rangeDates(start, end) {
  const dates = [];
  forEachDate(start, end, (date) => dates.push(date));
  return dates;
}

function maxDate(a, b) {
  return a > b ? a : b;
}

function timeToMinutes(time) {
  const [hours, minutes] = String(time || "00:00").split(":").map(Number);
  return (hours || 0) * 60 + (minutes || 0);
}

function minutesToTime(total) {
  const minutes = Math.max(0, Math.min(1439, total));
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function minutesNow(date = new Date()) {
  return date.getHours() * 60 + date.getMinutes();
}

function formatDate(date) {
  return new Intl.DateTimeFormat("ar-SA", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(parseDate(date));
}

function formatTime(time) {
  const [hours, minutes] = String(time).split(":").map(Number);
  const date = new Date();
  date.setHours(hours || 0, minutes || 0, 0, 0);
  return new Intl.DateTimeFormat("ar-SA", {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatClock(date) {
  return new Intl.DateTimeFormat("ar-SA", {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatDateTime(value) {
  const date = new Date(value);
  return new Intl.DateTimeFormat("ar-SA", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function startOfWeek(date) {
  const parsed = parseDate(date);
  const day = parsed.getDay();
  parsed.setDate(parsed.getDate() - day);
  return todayISO(parsed);
}

function startOfMonth(date) {
  const parsed = parseDate(date);
  return todayISO(new Date(parsed.getFullYear(), parsed.getMonth(), 1));
}

function endOfMonth(date) {
  const parsed = parseDate(date);
  return todayISO(new Date(parsed.getFullYear(), parsed.getMonth() + 1, 0));
}

function startOfPreviousMonth(date) {
  const parsed = parseDate(date);
  return todayISO(new Date(parsed.getFullYear(), parsed.getMonth() - 1, 1));
}

function compareText(current, previous) {
  const diff = current - previous;
  if (diff > 0) return `+${diff}%`;
  if (diff < 0) return `${diff}%`;
  return "بدون تغيير";
}

// ==========================================
// برمجية إضافة صفحة الإحصائيات المدققة تلقائياً
// ==========================================
document.addEventListener("DOMContentLoaded", () => {
  const btnNav = document.getElementById("btnDetailedStatsNav");
  const detailedView = document.getElementById("detailedStatsView");
  const btnBack = document.getElementById("btnDetailedStatsBack");
  const taskSelect = document.getElementById("detailedTaskSelect");
  const singleStatsResult = document.getElementById("singleTaskStatsResult");
  const btnShowAll = document.getElementById("btnShowAllSummary");
  const allSummaryResult = document.getElementById("allTasksSummaryResult");

  if (!btnNav || !detailedView) return;

  // فتح صفحة الإحصائيات المدققة وإخفاء الواجهات الأخرى مؤقتاً لعدم حدوث تضارب
  btnNav.addEventListener("click", () => {
    const contentChildren = document.querySelectorAll(".content > *:not(#detailedStatsView):not(.mobile-brandbar)");
    contentChildren.forEach(el => el.style.display = "none");
    
    // إزالة التحديد النشط من الأزرار الأخرى في القائمة وإضافته لزرنا المخصص
    document.querySelectorAll(".nav-button").forEach(b => b.classList.remove("active"));
    btnNav.classList.add("active");

    detailedView.style.display = "block";
    loadTasksIntoDropdown();
  });

  // العودة للوضع الطبيعي عند الضغط على زر رجوع
  btnBack.addEventListener("click", () => {
    detailedView.style.display = "none";
    btnNav.classList.remove("active");
    // محاكاة الضغط على التبويب الرئيسي لإعادة تشغيل الموقع بالشكل القياسي الآمن
    const mainNavBtn = document.querySelector('.nav-button[data-view="main"]');
    if (mainNavBtn) {
      mainNavBtn.click();
    } else {
      window.location.reload(); // حل احتياطي آمن جداً
    }
  });

  // دالة قراءة المهام من الذاكرة المحلية وتعبئة خيارات الانتقاء
  function loadTasksIntoDropdown() {
    taskSelect.innerHTML = '<option value="">-- اضغط هنا لاختيار المهمة --</option>';
    const storeData = JSON.parse(localStorage.getItem("ifal.task.manager.v1") || "{}");
    let tasks = storeData.tasks || [];
    if (Array.isArray(storeData)) tasks = storeData;

    tasks.forEach(task => {
      if (!task) return;
      const title = task.title || task.text || task.name || "مهمة غير مسمية";
      const option = document.createElement("option");
      option.value = task.id;
      option.textContent = title;
      taskSelect.appendChild(option);
    });
  }

  // عند اختيار مهمة معينة من القائمة
  taskSelect.addEventListener("change", () => {
    const taskId = taskSelect.value;
    if (!taskId) {
      singleStatsResult.style.display = "none";
      return;
    }

    const storeData = JSON.parse(localStorage.getItem("ifal.task.manager.v1") || "{}");
    let tasks = storeData.tasks || [];
    if (Array.isArray(storeData)) tasks = storeData;

    const task = tasks.find(t => String(t.id) === String(taskId));
    if (!task) return;

    // معالجة البيانات بدقة متناهية للشهر والأسبوع واليوم
    const statistics = processSingleTaskMetrics(task);
    
    document.getElementById("taskStatToday").textContent = statistics.todayPercent;
    document.getElementById("taskStatWeek").textContent = statistics.weekPercent;
    document.getElementById("taskStatMonth").textContent = statistics.monthPercent;
    
    singleStatsResult.style.display = "grid";
  });

  // عند الضغط على زر عرض ملخص الكل
  btnShowAll.addEventListener("click", () => {
    const storeData = JSON.parse(localStorage.getItem("ifal.task.manager.v1") || "{}");
    let tasks = storeData.tasks || [];
    if (Array.isArray(storeData)) tasks = storeData;

    allSummaryResult.innerHTML = "";
    let containsActiveTasks = false;

    tasks.forEach(task => {
      if (!task) return;
      const statistics = processSingleTaskMetrics(task);
      
      // استبعاد المهام الخامله تماماً (التي لم يتم تسجيل أي تنفيذ أو عدم تنفيذ لها خلال الشهر الحالي)
      if (statistics.doneMonthCount === 0 && statistics.missedMonthCount === 0) {
        return; 
      }

      containsActiveTasks = true;
      const title = task.title || task.text || task.name || "مهمة بدون اسم";
      
      const row = document.createElement("div");
      row.style.marginBottom = "18px";
      row.style.paddingBottom = "12px";
      row.style.borderBottom = "1px solid #e2e8f0";
      
      row.innerHTML = `
        <div style="font-weight: bold; font-size: 1.1rem; color: #1e293b; margin-bottom: 6px;">${title}</div>
        <div style="display: flex; gap: 20px; font-size: 0.95rem; flex-wrap: wrap;">
          <div style="color: #16a34a;">● تم التنفيذ: <span style="font-weight: bold;">${statistics.doneMonthPercent}</span> (عدد المرات: ${statistics.doneMonthCount})</div>
          <div style="color: #dc2626;">● لم يتم التنفيذ: <span style="font-weight: bold;">${statistics.missedMonthPercent}</span> (عدد المرات: ${statistics.missedMonthCount})</div>
        </div>
      `;
      allSummaryResult.appendChild(row);
    });

    if (!containsActiveTasks) {
      allSummaryResult.innerHTML = '<div style="text-align: center; color: #64748b; padding: 10px;">لا توجد أي مهام نشطة أو مفعّلة في السجلات لهذا الشهر الحالي.</div>';
    }

    allSummaryResult.style.display = "block";
    allSummaryResult.scrollIntoView({ behavior: 'smooth' });
  });

  // محرك الحسابات البرمجية لتفكيك سجلات التواريخ لكل مهمة
  function processSingleTaskMetrics(task) {
    const dateToday = new Date(); // التوقيت الفعلي الحالي في الرياض لعام 2026
    const currentYear = dateToday.getFullYear();
    const currentMonth = dateToday.getMonth(); // يبدأ من 0 حتى 11
    const todayISOStr = dateToday.toISOString().split('T')[0];

    // تجميع مصفوفة آخر 7 أيام لحساب الأسبوع الحالي
    const last7Days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      last7Days.push(d.toISOString().split('T')[0]);
    }

    // تجميع مصفوفة أيام الشهر الحالي من يوم 1 حتى يومنا الحالي
    const monthDaysList = [];
    const currentDayNo = dateToday.getDate();
    const formattedMonthNum = String(currentMonth + 1).padStart(2, '0');
    for (let i = 1; i <= currentDayNo; i++) {
      monthDaysList.push(`${currentYear}-${formattedMonthNum}-${String(i).padStart(2, '0')}`);
    }

    // استخلاص الهيكل البنيوي للتاريخ الخاص بالمهمة لتغطية كافة الإصدارات والأنماط الممكنة
    let dataLogs = task.history || task.historyDates || task.completed || task.logs || {};
    
    let isDoneToday = false;
    let isMissedToday = false;
    let doneWeekCount = 0;
    let missedWeekCount = 0;
    let doneMonthCount = 0;
    let missedMonthCount = 0;

    if (typeof dataLogs === 'object' && !Array.isArray(dataLogs)) {
      // نمط الخريطة المفتاحية (Object Mapping: Key-Value)
      if (dataLogs[todayISOStr] !== undefined) {
        if (dataLogs[todayISOStr] === true || dataLogs[todayISOStr] === 1 || dataLogs[todayISOStr] === 'completed') isDoneToday = true;
        else isMissedToday = true;
      }
      
      last7Days.forEach(day => {
        if (dataLogs[day] !== undefined) {
          if (dataLogs[day] === true || dataLogs[day] === 1 || dataLogs[day] === 'completed') doneWeekCount++;
          else missedWeekCount++;
        }
      });

      monthDaysList.forEach(day => {
        if (dataLogs[day] !== undefined) {
          if (dataLogs[day] === true || dataLogs[day] === 1 || dataLogs[day] === 'completed') doneMonthCount++;
          else missedMonthCount++;
        }
      });
    } else if (Array.isArray(dataLogs)) {
      // نمط قائمة التواريخ المباشرة (Array Pattern)
      const cleanDatesSet = new Set();
      dataLogs.forEach(entry => {
        if (typeof entry === 'string') cleanDatesSet.add(entry.split('T')[0]);
        else if (entry && entry.date) cleanDatesSet.add(entry.date.split('T')[0]);
      });

      if (cleanDatesSet.has(todayISOStr)) isDoneToday = true; else isMissedToday = true;

      last7Days.forEach(day => {
        if (cleanDatesSet.has(day)) doneWeekCount++; else missedWeekCount++;
      });

      monthDaysList.forEach(day => {
        if (cleanDatesSet.has(day)) doneMonthCount++; else missedMonthCount++;
      });
    }

    const totalWeek = doneWeekCount + missedWeekCount;
    const totalMonth = doneMonthCount + missedMonthCount;

    return {
      todayPercent: isDoneToday ? "100%" : "0%",
      weekPercent: totalWeek > 0 ? Math.round((doneWeekCount / totalWeek) * 100) + "%" : "0%",
      monthPercent: totalMonth > 0 ? Math.round((doneMonthCount / totalMonth) * 100) + "%" : "0%",
      doneMonthCount,
      missedMonthCount,
      doneMonthPercent: totalMonth > 0 ? Math.round((doneMonthCount / totalMonth) * 100) + "%" : "0%",
      missedMonthPercent: totalMonth > 0 ? Math.round((missedMonthCount / totalMonth) * 100) + "%" : "0%"
    };
  }
});

function isOlderThanDays(value, days) {
  if (!value) return false;
  const date = new Date(value);
  return Date.now() - date.getTime() >= days * 86400000;
}

function deletedDaysLeft(instance) {
  const value = instance.movedAt || instance.updatedAt || new Date().toISOString();
  const elapsed = Math.floor((Date.now() - new Date(value).getTime()) / 86400000);
  return Math.max(0, 5 - elapsed);
}
