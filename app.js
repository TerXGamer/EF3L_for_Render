import {
  addDays,
  calculateStats,
  compactAccountData,
  forEachDate,
  hydrateAccountData,
  isTaskDueOn as coreIsTaskDueOn,
  latestDueDateOnOrBefore,
  mapTimeIntoWindow,
  maxDate,
  parseLocalDate as parseDate,
  rangeDates,
  timeToMinutes,
  todayISO,
  wouldCreateDependencyCycle,
} from "./core.mjs";

const STORE_KEY = "ifal.task.manager.v1";
const CLOUD_SYNC_DELAY = 250;
const CLOUD_SYNC_MIN_GAP = 250;
const CLOUD_PULL_INTERVAL = 1_000;
const SCHEDULE_LOOKBACK_DAYS = 400;
const CLOUD_API_BASE = String(globalThis.IFAL_API_BASE || "").replace(/\/$/, "");
const CLOUD_ACCOUNT_ENDPOINT = String(globalThis.IFAL_ACCOUNT_ENDPOINT || `${CLOUD_API_BASE}/api/account`);
const CLOUD_ADMIN_ENDPOINT = String(globalThis.IFAL_ADMIN_ENDPOINT || `${CLOUD_API_BASE}/api/admin`);
const THEME_PRESETS = {
  light: ["#dcefe5", "#087f5b", "#d9480f"],
  calm: ["#e7ead7", "#3b7a57", "#b7791f"],
  ocean: ["#d8ebf0", "#087f8c", "#d55232"],
  rose: ["#f1dce4", "#a23b62", "#397d58"],
  dark: ["#171c1a", "#35a979", "#75a1ff"],
  graphite: ["#1b1d20", "#4e9f92", "#e67b58"],
  night: ["#1a1d16", "#6a8e4d", "#d0a354"],
};
const THEME_LABELS = {
  light: "فاتح",
  calm: "هادئ",
  ocean: "بحري",
  rose: "وردي",
  dark: "داكن",
  graphite: "فحمي",
  night: "ليلي",
};
const CUSTOM_THEME_PROPERTIES = [
  "--bg", "--surface", "--surface-soft", "--field", "--line", "--line-strong",
  "--text", "--muted", "--teal", "--teal-dark", "--coral", "--amber", "--green",
  "--red", "--blue", "--sidebar-bg", "--sidebar-text", "--sidebar-muted",
  "--nav-hover", "--nav-active", "--toast-bg", "--toast-text", "--shadow",
];

const titles = {
  main: "مهام اليوم",
  settings: "إعدادات المهام",
  required: "المهام المنتهية الواجبة",
  optional: "المهام غير الواجبة",
  never: "المهام غير المنفذة",
  completed: "مهام تم تنفيذها",
  stats: "الإحصائيات",
  statsAudit: "الإحصائيات المدققة",
  dataExport: "جميع المهام والبيانات",
  site: "\u0625\u0639\u062f\u0627\u062f\u0627\u062a \u0627\u0644\u0645\u0648\u0642\u0639",
  account: "حسابي",
  lists: "عام القوائم",
  settingsHub: "الإعدادات",
  deleted: "المهام المحذوفة",
  reset: "إعادة الضبط",
  admin: "لوحة الإدارة",
  adminReveal: "إدارة الحساب",
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
  statsAudit: "settingsHub",
  dataExport: "settingsHub",
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

const monthNames = [
  "يناير",
  "فبراير",
  "مارس",
  "أبريل",
  "مايو",
  "يونيو",
  "يوليو",
  "أغسطس",
  "سبتمبر",
  "أكتوبر",
  "نوفمبر",
  "ديسمبر",
];

let state = loadState();
let currentView = "main";
let selectedImportance = 6;
let selectedNever = new Set();
let toastTimer = null;
let cloudSaveTimer = null;
let cloudSyncPromise = null;
let cloudPullPromise = null;
let lastCloudUpdatedAt = "";
let localRevision = 0;
let isApplyingRemote = false;
let pendingCloudSync = false;
let loginMode = "login";
let statsSettingsOpen = false;
let auditTaskPickerOpen = false;
let auditStatsMode = "";
let selectedAuditTaskId = "";
let neverSortMode = "newest";
let completedSortMode = "newest";
let selectedDataMonths = new Set();
let isAdmin = false;
let adminUsers = [];
let adminUsersLoaded = false;
let adminUsersLoading = false;
let adminSearchTerm = "";
let adminRevealTarget = "";
let adminRevealData = null;
let adminRevealLoading = false;
let themeCustomizerOpen = false;

const el = {
  mobileUserBadge: document.getElementById("mobileUserBadge"),
  userBadge: document.getElementById("userBadge"),
  syncIndicator: document.getElementById("syncIndicator"),
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
  themeChoices: document.getElementById("themeChoices"),
  themePresetButton: document.getElementById("themePresetButton"),
  themeCustomButton: document.getElementById("themeCustomButton"),
  themeCustomizer: document.getElementById("themeCustomizer"),
  themeCustomizationTitle: document.getElementById("themeCustomizationTitle"),
  themeColorBackground: document.getElementById("themeColorBackground"),
  themeColorPrimary: document.getElementById("themeColorPrimary"),
  themeColorAccent: document.getElementById("themeColorAccent"),
  themeCustomSave: document.getElementById("themeCustomSave"),
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
  neverSortNewest: document.getElementById("neverSortNewest"),
  neverSortOldest: document.getElementById("neverSortOldest"),
  completedSortNewest: document.getElementById("completedSortNewest"),
  completedSortOldest: document.getElementById("completedSortOldest"),
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
  auditTaskPicker: document.getElementById("auditTaskPicker"),
  auditTaskSelect: document.getElementById("auditTaskSelect"),
  auditSingleSummary: document.getElementById("auditSingleSummary"),
  auditSingleStats: document.getElementById("auditSingleStats"),
  auditDailyMeta: document.getElementById("auditDailyMeta"),
  auditWeeklyMeta: document.getElementById("auditWeeklyMeta"),
  auditMonthlyMeta: document.getElementById("auditMonthlyMeta"),
  auditDailyStats: document.getElementById("auditDailyStats"),
  auditWeeklyStats: document.getElementById("auditWeeklyStats"),
  auditMonthlyStats: document.getElementById("auditMonthlyStats"),
  auditMonthLogCount: document.getElementById("auditMonthLogCount"),
  auditMonthLog: document.getElementById("auditMonthLog"),
  auditAllSummary: document.getElementById("auditAllSummary"),
  dataYearLabel: document.getElementById("dataYearLabel"),
  dataMonthButtons: document.getElementById("dataMonthButtons"),
  dataExportSummary: document.getElementById("dataExportSummary"),
  dataSelectAllMonths: document.getElementById("dataSelectAllMonths"),
  dataClearMonths: document.getElementById("dataClearMonths"),
  dataDownload: document.getElementById("dataDownload"),
  accountSyncState: document.getElementById("accountSyncState"),
  accountDetails: document.getElementById("accountDetails"),
  storageExplanation: document.getElementById("storageExplanation"),
  changePasswordForm: document.getElementById("changePasswordForm"),
  currentPassword: document.getElementById("currentPassword"),
  newPassword: document.getElementById("newPassword"),
  confirmPassword: document.getElementById("confirmPassword"),
  resetRuntimeData: document.getElementById("resetRuntimeData"),
  adminUserList: document.getElementById("adminUserList"),
  adminUserCount: document.getElementById("adminUserCount"),
  adminSearch: document.getElementById("adminSearch"),
  adminRefresh: document.getElementById("adminRefresh"),
  adminRevealTitle: document.getElementById("adminRevealTitle"),
  adminRevealProfile: document.getElementById("adminRevealProfile"),
  adminRevealTasks: document.getElementById("adminRevealTasks"),
  adminRevealBack: document.getElementById("adminRevealBack"),
  adminControlPanel: document.getElementById("adminControlPanel"),
  adminManageProfileForm: document.getElementById("adminManageProfileForm"),
  adminManageName: document.getElementById("adminManageName"),
  adminManageEmail: document.getElementById("adminManageEmail"),
  adminManagePasswordForm: document.getElementById("adminManagePasswordForm"),
  adminManagePassword: document.getElementById("adminManagePassword"),
  adminSignoutUser: document.getElementById("adminSignoutUser"),
  adminDeleteUser: document.getElementById("adminDeleteUser"),
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
    resumeCloudSession();
  }
  setInterval(() => {
    refreshSchedule();
    render();
  }, 60 * 1000);
  setInterval(() => {
    void runAutomaticSync();
  }, CLOUD_PULL_INTERVAL);
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
  const availableThemes = Object.keys(THEME_PRESETS);
  const requestedTheme = state.settings.theme || "light";
  const theme = availableThemes.includes(requestedTheme) ? requestedTheme : "light";
  const customization = state.settings.themeCustomizations?.[theme];
  const customActive = customization?.mode === "custom";
  state.settings.theme = theme;
  document.documentElement.dataset.theme = theme;
  clearCustomThemeColors();
  if (customActive) {
    applyCustomThemeColors(customization.colors);
  } else {
    document.documentElement.style.colorScheme = ["dark", "graphite", "night"].includes(theme)
      ? "dark"
      : "light";
  }
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) themeMeta.content = (customActive ? customization.colors : THEME_PRESETS[theme])[1];
  if (el.themeMode) el.themeMode.value = theme;
  el.themeChoices?.querySelectorAll("[data-theme-value]").forEach((button) => {
    const active = button.dataset.themeValue === theme;
    const buttonTheme = button.dataset.themeValue;
    const buttonCustomization = state.settings.themeCustomizations?.[buttonTheme];
    const colors = buttonCustomization?.mode === "custom"
      ? buttonCustomization.colors
      : THEME_PRESETS[buttonTheme];
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
    button.querySelectorAll(".theme-swatches i").forEach((swatch, index) => {
      swatch.style.background = colors[index];
    });
  });
  syncThemeCustomizationControls(theme, customActive);
}

function clearCustomThemeColors() {
  CUSTOM_THEME_PROPERTIES.forEach((property) => document.documentElement.style.removeProperty(property));
}

function applyCustomThemeColors(colors) {
  const [background, primary, accent] = colors;
  const dark = colorLuminance(background) < 0.38;
  const text = dark ? "#f7f9f8" : "#17211c";
  const muted = mixColors(text, background, dark ? 0.58 : 0.52);
  const surface = mixColors(background, "#ffffff", dark ? 0.08 : 0.58);
  const sidebar = dark
    ? mixColors(background, "#000000", 0.34)
    : mixColors(primary, "#111815", 0.72);
  const values = {
    "--bg": background,
    "--surface": surface,
    "--surface-soft": mixColors(background, primary, dark ? 0.14 : 0.1),
    "--field": mixColors(surface, dark ? "#000000" : "#ffffff", 0.08),
    "--line": mixColors(background, dark ? "#ffffff" : "#000000", dark ? 0.18 : 0.14),
    "--line-strong": mixColors(background, dark ? "#ffffff" : "#000000", dark ? 0.3 : 0.24),
    "--text": text,
    "--muted": muted,
    "--teal": primary,
    "--teal-dark": mixColors(primary, dark ? "#ffffff" : "#000000", 0.2),
    "--coral": accent,
    "--amber": mixColors(accent, "#d3a12f", 0.5),
    "--green": mixColors(primary, "#2e9f55", 0.45),
    "--red": mixColors(accent, "#c83743", 0.55),
    "--blue": mixColors(primary, "#4275d6", 0.58),
    "--sidebar-bg": sidebar,
    "--sidebar-text": "#f7faf8",
    "--sidebar-muted": mixColors("#f7faf8", sidebar, 0.35),
    "--nav-hover": mixColors(sidebar, primary, 0.24),
    "--nav-active": "#ffffff",
    "--toast-bg": sidebar,
    "--toast-text": "#ffffff",
    "--shadow": dark ? "0 10px 28px rgba(0, 0, 0, 0.32)" : "0 8px 24px rgba(24, 33, 29, 0.1)",
  };
  Object.entries(values).forEach(([property, value]) => {
    document.documentElement.style.setProperty(property, value);
  });
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

function syncThemeCustomizationControls(theme, customActive) {
  if (el.themePresetButton) {
    el.themePresetButton.classList.toggle("active", !customActive && !themeCustomizerOpen);
    el.themePresetButton.setAttribute("aria-pressed", String(!customActive && !themeCustomizerOpen));
  }
  if (el.themeCustomButton) {
    el.themeCustomButton.classList.toggle("active", customActive || themeCustomizerOpen);
    el.themeCustomButton.setAttribute("aria-pressed", String(customActive || themeCustomizerOpen));
  }
  if (el.themeCustomizer) el.themeCustomizer.hidden = !themeCustomizerOpen;
  if (el.themeCustomizationTitle) {
    el.themeCustomizationTitle.textContent = `تخصيص ${THEME_LABELS[theme]}`;
  }
}

function fillThemeColorInputs(theme) {
  const customization = state.settings.themeCustomizations?.[theme];
  const colors = customization?.colors || THEME_PRESETS[theme];
  el.themeColorBackground.value = colors[0];
  el.themeColorPrimary.value = colors[1];
  el.themeColorAccent.value = colors[2];
}

function selectedThemeInputColors() {
  return [
    normalizeHexColor(el.themeColorBackground?.value, THEME_PRESETS.light[0]),
    normalizeHexColor(el.themeColorPrimary?.value, THEME_PRESETS.light[1]),
    normalizeHexColor(el.themeColorAccent?.value, THEME_PRESETS.light[2]),
  ];
}

function normalizeHexColor(value, fallback) {
  const color = String(value || "").toLowerCase();
  return /^#[0-9a-f]{6}$/.test(color) ? color : fallback;
}

function mixColors(first, second, amount) {
  const a = first.slice(1).match(/.{2}/g).map((part) => parseInt(part, 16));
  const b = second.slice(1).match(/.{2}/g).map((part) => parseInt(part, 16));
  return `#${a.map((value, index) => {
    return Math.round(value + (b[index] - value) * amount).toString(16).padStart(2, "0");
  }).join("")}`;
}

function colorLuminance(color) {
  const channels = color.slice(1).match(/.{2}/g).map((part) => {
    const value = parseInt(part, 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
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
    if (state.user?.authToken) {
      accountRequest({ action: "logout" }).catch(() => {});
    }
    clearTimeout(cloudSaveTimer);
    state.user = null;
    state.sync = { ...state.sync, mode: "local", lastError: "" };
    isAdmin = false;
    adminUsers = [];
    adminUsersLoaded = false;
    adminUsersLoading = false;
    adminSearchTerm = "";
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
  on(el.themeChoices, "click", (event) => {
    const button = event.target.closest("[data-theme-value]");
    if (!button) return;
    state.settings.theme = button.dataset.themeValue;
    themeCustomizerOpen = false;
    applyTheme();
    saveState();
  });
  on(el.themePresetButton, "click", () => {
    const theme = state.settings.theme;
    const current = state.settings.themeCustomizations?.[theme] || {};
    state.settings.themeCustomizations[theme] = { ...current, mode: "preset" };
    themeCustomizerOpen = false;
    applyTheme();
    saveState();
    toast(`تم تطبيق ألوان ${THEME_LABELS[theme]} الجاهزة`);
  });
  on(el.themeCustomButton, "click", () => {
    themeCustomizerOpen = true;
    fillThemeColorInputs(state.settings.theme);
    applyTheme();
  });
  [el.themeColorBackground, el.themeColorPrimary, el.themeColorAccent].forEach((input) => {
    on(input, "input", () => applyCustomThemeColors(selectedThemeInputColors()));
  });
  on(el.themeCustomSave, "click", () => {
    const theme = state.settings.theme;
    state.settings.themeCustomizations[theme] = {
      mode: "custom",
      colors: selectedThemeInputColors(),
    };
    themeCustomizerOpen = false;
    applyTheme();
    saveState();
    toast(`تم حفظ تخصيص ${THEME_LABELS[theme]}`);
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
  on(el.neverSortNewest, "click", () => setListSort("never", "newest"));
  on(el.neverSortOldest, "click", () => setListSort("never", "oldest"));
  on(el.completedSortNewest, "click", () => setListSort("completed", "newest"));
  on(el.completedSortOldest, "click", () => setListSort("completed", "oldest"));

  on(el.statsSettingsToggle, "click", () => {
    statsSettingsOpen = !statsSettingsOpen;
    renderStats();
  });
  on(el.changePasswordForm, "submit", async (event) => {
    event.preventDefault();
    await changeAccountPassword();
  });
  on(el.dataSelectAllMonths, "click", selectAllDataMonths);
  on(el.dataClearMonths, "click", clearDataMonths);
  on(el.dataDownload, "click", downloadDataExport);
  on(el.resetRuntimeData, "click", resetRuntimeData);
  on(el.adminRevealBack, "click", () => switchView("admin"));
  on(el.adminSearch, "input", () => {
    adminSearchTerm = normalizeSearchText(el.adminSearch.value);
    renderAdminList();
  });
  on(el.adminRefresh, "click", async () => {
    await refreshAdminUsers();
  });
  on(el.adminManageProfileForm, "submit", async (event) => {
    event.preventDefault();
    await updateManagedUserProfile();
  });
  on(el.adminManagePasswordForm, "submit", async (event) => {
    event.preventDefault();
    await resetManagedUserPassword();
  });
  on(el.adminSignoutUser, "click", signoutManagedUser);
  on(el.adminDeleteUser, "click", deleteManagedUser);
  window.addEventListener("online", () => {
    void runAutomaticSync(true);
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void runAutomaticSync(true);
  });
  window.addEventListener("pagehide", () => {
    if (pendingCloudSync) void syncToCloud(false);
  });

  document.addEventListener("click", handleActionClick);
  document.addEventListener("change", handleSelectionChange);
}

function initialState() {
  return {
    version: 2,
    user: null,
    tasks: [],
    instances: {},
    settings: {
      theme: "light",
      themeCustomizations: {},
      displayWindow: {
        enabled: false,
        start: "00:00",
        end: "23:59",
      },
      snapshots: [],
      statsExcludedInstanceIds: [],
      hiddenListInstanceIds: [],
    },
    imports: [],
    meta: {
      taskTombstones: {},
      instanceTombstones: {},
      runtimeResetAt: null,
    },
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
  const next = { ...base, ...hydrateAccountData(input) };
  next.tasks = Array.isArray(next.tasks) ? next.tasks.map(normalizeTask).filter(Boolean) : [];
  next.instances = normalizeInstances(next.instances);
  next.settings = {
    ...base.settings,
    ...(next.settings || {}),
    themeCustomizations: normalizeThemeCustomizations((next.settings || {}).themeCustomizations),
    displayWindow: {
      ...base.settings.displayWindow,
      ...((next.settings || {}).displayWindow || {}),
    },
    snapshots: Array.isArray((next.settings || {}).snapshots) ? next.settings.snapshots : [],
    statsExcludedInstanceIds: Array.isArray((next.settings || {}).statsExcludedInstanceIds)
      ? next.settings.statsExcludedInstanceIds
      : [],
    hiddenListInstanceIds: Array.isArray((next.settings || {}).hiddenListInstanceIds)
      ? next.settings.hiddenListInstanceIds
      : [],
  };
  next.imports = Array.isArray(next.imports) ? next.imports : [];
  next.meta = {
    ...base.meta,
    ...(next.meta || {}),
    taskTombstones:
      next.meta?.taskTombstones && typeof next.meta.taskTombstones === "object"
        ? next.meta.taskTombstones
        : {},
    instanceTombstones:
      next.meta?.instanceTombstones && typeof next.meta.instanceTombstones === "object"
        ? next.meta.instanceTombstones
        : {},
  };
  next.sync = {
    ...base.sync,
    ...(next.sync || {}),
  };
  return next;
}

function normalizeThemeCustomizations(customizations) {
  if (!customizations || typeof customizations !== "object") return {};
  return Object.fromEntries(Object.keys(THEME_PRESETS).flatMap((theme) => {
    const entry = customizations[theme];
    if (!entry || typeof entry !== "object") return [];
    const preset = THEME_PRESETS[theme];
    const colors = Array.isArray(entry.colors)
      ? preset.map((fallback, index) => normalizeHexColor(entry.colors[index], fallback))
      : [...preset];
    return [[theme, {
      mode: entry.mode === "custom" ? "custom" : "preset",
      colors,
    }]];
  }));
}

function normalizeTask(task) {
  if (!task || !task.title) return null;
  const now = new Date().toISOString();
  const id = normalizeId(task.id) || uid("task");
  return {
    id,
    title: String(task.title || "").trim().slice(0, 80),
    description: String(task.description || "").trim().slice(0, 260),
    startDate: /^\d{4}-\d{2}-\d{2}$/.test(task.startDate) ? task.startDate : todayISO(),
    recurrence: ["once", "daily", "weekly", "monthly", "custom"].includes(task.recurrence)
      ? task.recurrence
      : "daily",
    intervalDays: Math.min(365, Math.max(1, Number(task.intervalDays || 1))),
    dependencyId: normalizeId(task.dependencyId),
    time: normalizeTime(task.time, "00:00"),
    endTime: normalizeTime(task.endTime, "23:59"),
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
    const id = normalizeId(item?.id);
    const taskId = normalizeId(item?.taskId);
    if (!item || !id || !taskId || !/^\d{4}-\d{2}-\d{2}$/.test(item.date)) return;
    map[id] = {
      ...item,
      id,
      taskId,
      title: String(item.title || "").trim().slice(0, 80),
      description: String(item.description || "").trim().slice(0, 260),
      time: normalizeTime(item.time, "00:00"),
      endTime: normalizeTime(item.endTime, "23:59"),
      importance: [2, 4, 6, 8, 10].includes(Number(item.importance)) ? Number(item.importance) : 6,
      status: ["main", "requiredOverdue", "optionalOverdue", "never", "deleted", "completed"].includes(item.status)
        ? item.status
        : "main",
      history: Array.isArray(item.history) ? item.history : [],
      updatedAt: item.updatedAt || item.createdAt || new Date().toISOString(),
    };
  });
  return map;
}

function normalizeId(value) {
  const id = String(value || "");
  return /^[a-zA-Z0-9._:-]{1,240}$/.test(id) ? id : "";
}

function normalizeTime(value, fallback) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || "")) ? String(value) : fallback;
}

function ensureDefaults() {
  state = normalizeState(state);
  saveState(false);
}

function saveState(sync = true) {
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
  if (sync) {
    localRevision += 1;
    scheduleCloudSave(CLOUD_SYNC_DELAY);
  }
}

function fillDefaultFormValues() {
  el.taskStartDate.value = todayISO();
  el.taskTime.value = "00:00";
  el.taskEndTime.value = "23:59";
  el.windowStart.value = state.settings.displayWindow.start;
  el.windowEnd.value = state.settings.displayWindow.end;
  el.windowEnabled.checked = state.settings.displayWindow.enabled;
  renderImportanceButtons();
  syncIntervalState();
}

function switchView(view) {
  if ((view === "admin" || view === "adminReveal") && !isAdmin) {
    toast("هذه الصفحة للمدير فقط");
    return;
  }
  currentView = viewRedirects[view] || view;
  document.querySelectorAll(".nav-button").forEach((button) => {
    const active = button.dataset.view === navParents[currentView];
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  document.querySelectorAll(".view").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `view-${currentView}`);
  });
  document.querySelectorAll(".subnav-button").forEach((button) => {
    const subnavView = currentView === "adminReveal" ? "admin" : currentView === "statsAudit" ? "stats" : currentView;
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
  el.loginPassword.minLength = mode === "create" ? 8 : 1;
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
  if (loginMode === "create" && password.length < 8) {
    toast("استخدم كلمة مرور من 8 أحرف على الأقل");
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
  lastCloudUpdatedAt = profile.updatedAt || "";
  isApplyingRemote = true;
  const remoteData = response.data ? normalizeState(response.data) : normalizeState(state);
  state = remoteData;
  state.user = {
    name: profile.name || remoteData.user?.name || profile.username,
    email: profile.email || remoteData.user?.email || "",
    username: profile.username || remoteData.user?.username || "",
    authToken: response.token || remoteData.user?.authToken || state.user?.authToken || "",
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

async function resumeCloudSession() {
  if (state.user?.authToken) {
    try {
      const response = await accountRequest({ action: "session" });
      if (response.user) {
        const profile = response.user;
        lastCloudUpdatedAt = profile.updatedAt || lastCloudUpdatedAt;
        if (response.data) applyIncomingCloudState(response.data);
        state.user = {
          ...state.user,
          name: profile.name || state.user.name,
          email: profile.email || state.user.email,
          username: profile.username || state.user.username,
        };
        state.sync = { ...state.sync, mode: "cloud", lastError: "" };
        saveState(false);
      }
      await checkAdminAccess();
      render();
      return;
    } catch (error) {
      if (!isBackendUnavailable(error) && error.status === 401) {
        state.user = null;
        saveState(false);
        render();
        showLogin();
        toast("انتهت الجلسة، سجل الدخول من جديد");
        return;
      }
    }
  }

  const legacyPassword = state.user?.password;
  if (legacyPassword && state.user?.username) {
    try {
      const response = await accountRequest({
        action: "login",
        username: state.user.username,
        password: legacyPassword,
      });
      applyCloudLogin(response, legacyPassword);
      return;
    } catch {
      delete state.user.password;
      state.sync = { ...state.sync, mode: "local" };
      saveState(false);
    }
  }

  checkAdminAccess();
  render();
}

async function checkAdminAccess() {
  if (!canCloudSync()) {
    isAdmin = false;
    adminUsers = [];
    adminUsersLoaded = false;
    adminUsersLoading = false;
    updateAdminNav();
    return;
  }

  try {
    const response = await adminRequest({ action: "check" });
    isAdmin = Boolean(response.isAdmin);
  } catch {
    isAdmin = false;
  }
  if (!isAdmin) {
    adminUsers = [];
    adminUsersLoaded = false;
    adminUsersLoading = false;
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
    headers: requestHeaders(),
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
      : body.error || "تعذر الاتصال بالخادم";
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  return body;
}

async function loadAdminUsers(force = false) {
  if (!isAdmin) return;
  if (adminUsersLoading) return;
  if (!force && adminUsersLoaded) return;

  adminUsersLoading = true;
  try {
    const response = await adminRequest({ action: "list" });
    adminUsers = Array.isArray(response.users)
      ? response.users.map(normalizeAdminUser).filter((user) => user.username)
      : [];
    adminUsersLoaded = true;
  } finally {
    adminUsersLoading = false;
  }
}

function normalizeAdminUser(value) {
  const user = typeof value === "string" ? { username: value } : value || {};
  return {
    username: normalizeUsername(user.username),
    name: String(user.name || ""),
    email: String(user.email || ""),
    isAdmin: Boolean(user.isAdmin),
    taskSettingsCount: Number(user.taskSettingsCount || 0),
    completedCount: Number(user.completedCount || 0),
    createdAt: user.createdAt || null,
    updatedAt: user.updatedAt || null,
  };
}

function normalizeSearchText(value) {
  return String(value || "").trim().toLocaleLowerCase("ar-SA");
}

async function refreshAdminUsers() {
  if (!isAdmin || adminUsersLoading) return;
  if (el.adminRefresh) el.adminRefresh.disabled = true;
  try {
    await loadAdminUsers(true);
    renderAdminList();
    toast("تم تحديث الحسابات");
  } catch (error) {
    toast(error.message || "تعذر تحديث الحسابات");
  } finally {
    if (el.adminRefresh) el.adminRefresh.disabled = false;
  }
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
    toast(error.message || "تعذر جلب بيانات الحساب");
  } finally {
    adminRevealLoading = false;
    render();
  }
}

function setAdminControlsDisabled(disabled) {
  [
    el.adminManageName,
    el.adminManageEmail,
    el.adminManagePassword,
    el.adminSignoutUser,
    el.adminDeleteUser,
  ].forEach((control) => {
    if (control) control.disabled = disabled;
  });
  el.adminManageProfileForm
    ?.querySelectorAll("button")
    .forEach((button) => {
      button.disabled = disabled;
    });
  el.adminManagePasswordForm
    ?.querySelectorAll("button")
    .forEach((button) => {
      button.disabled = disabled;
    });
}

async function updateManagedUserProfile() {
  if (!adminRevealTarget || !adminRevealData) return;
  setAdminControlsDisabled(true);
  try {
    const response = await adminRequest({
      action: "update-user",
      targetUsername: adminRevealTarget,
      name: el.adminManageName?.value,
      email: el.adminManageEmail?.value,
    });
    const user = normalizeAdminUser(response.user);
    adminUsers = adminUsers.map((item) =>
      item.username === adminRevealTarget ? { ...item, ...user } : item,
    );
    adminRevealData.user = { ...adminRevealData.user, ...user };
    renderAdminReveal();
    toast("تم حفظ بيانات الحساب");
  } catch (error) {
    toast(error.message || "تعذر حفظ بيانات الحساب");
  } finally {
    setAdminControlsDisabled(false);
  }
}

async function resetManagedUserPassword() {
  if (!adminRevealTarget || !adminRevealData) return;
  const newPassword = String(el.adminManagePassword?.value || "");
  setAdminControlsDisabled(true);
  try {
    await adminRequest({
      action: "reset-password",
      targetUsername: adminRevealTarget,
      newPassword,
    });
    if (el.adminManagePasswordForm) el.adminManagePasswordForm.reset();
    toast("تم تغيير كلمة المرور وإنهاء الجلسات القديمة");
  } catch (error) {
    toast(error.message || "تعذر تغيير كلمة المرور");
  } finally {
    setAdminControlsDisabled(false);
  }
}

async function signoutManagedUser() {
  if (!adminRevealTarget || !adminRevealData) return;
  if (!confirm(`تسجيل خروج ${adminRevealTarget} من جميع أجهزته؟`)) return;
  setAdminControlsDisabled(true);
  try {
    await adminRequest({
      action: "signout-user",
      targetUsername: adminRevealTarget,
    });
    toast("تم إنهاء جلسات الحساب");
  } catch (error) {
    toast(error.message || "تعذر إنهاء جلسات الحساب");
  } finally {
    setAdminControlsDisabled(false);
  }
}

async function deleteManagedUser() {
  if (!adminRevealTarget || !adminRevealData) return;
  if (!confirm(`حذف حساب ${adminRevealTarget} وكل بياناته نهائيًا؟`)) return;
  setAdminControlsDisabled(true);
  try {
    await adminRequest({
      action: "delete-user",
      targetUsername: adminRevealTarget,
    });
    adminUsers = adminUsers.filter((user) => user.username !== adminRevealTarget);
    adminRevealTarget = "";
    adminRevealData = null;
    switchView("admin");
    toast("تم حذف الحساب");
  } catch (error) {
    toast(error.message || "تعذر حذف الحساب");
  } finally {
    setAdminControlsDisabled(false);
  }
}

async function accountRequest(payload) {
  const response = await fetch(CLOUD_ACCOUNT_ENDPOINT, {
    method: "POST",
    headers: requestHeaders(),
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
  return Boolean(
    error &&
      (error.status === 404 ||
        error.status === 405 ||
        error.status === 503 ||
        error.message === "backend-unavailable" ||
        error.name === "TypeError"),
  );
}

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function canCloudSync() {
  return Boolean(state.user?.username && state.user?.authToken);
}

function requestHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (state.user?.authToken) {
    headers.Authorization = `Bearer ${state.user.authToken}`;
  }
  return headers;
}

async function changeAccountPassword() {
  if (!canCloudSync()) {
    toast("تغيير كلمة المرور متاح بعد الاتصال بالخادم");
    return;
  }
  const currentPassword = el.currentPassword.value;
  const newPassword = el.newPassword.value;
  const confirmation = el.confirmPassword.value;
  if (!currentPassword || !newPassword) {
    toast("أكمل حقول كلمة المرور");
    return;
  }
  if (newPassword.length < 8) {
    toast("كلمة المرور الجديدة يجب أن تكون 8 أحرف على الأقل");
    return;
  }
  if (newPassword !== confirmation) {
    toast("تأكيد كلمة المرور غير مطابق");
    return;
  }
  try {
    const response = await accountRequest({
      action: "change-password",
      currentPassword,
      newPassword,
    });
    if (response.token) state.user.authToken = response.token;
    el.changePasswordForm.reset();
    saveState(false);
    toast("تم تغيير كلمة المرور وتأمين الجلسة");
  } catch (error) {
    toast(error.message || "تعذر تغيير كلمة المرور");
  }
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

async function runAutomaticSync(force = false) {
  if (!canCloudSync() || navigator.onLine === false || (!force && document.hidden)) return;
  if (pendingCloudSync) {
    scheduleCloudSave(force ? 0 : CLOUD_SYNC_DELAY);
    return;
  }
  await pullFromCloud();
}

async function pullFromCloud() {
  if (!canCloudSync() || cloudSyncPromise || cloudPullPromise) return false;
  const tokenAtStart = state.user.authToken;
  cloudPullPromise = (async () => {
    try {
      const response = await accountRequest({ action: "session" });
      if (!canCloudSync() || state.user.authToken !== tokenAtStart || pendingCloudSync) return false;
      const remoteUpdatedAt = response.user?.updatedAt || "";
      const hasRemoteChanges = !lastCloudUpdatedAt || remoteUpdatedAt !== lastCloudUpdatedAt;
      if (response.data && hasRemoteChanges) applyIncomingCloudState(response.data);
      if (response.user) {
        state.user = {
          ...state.user,
          name: response.user.name || state.user.name,
          email: response.user.email || state.user.email,
          username: response.user.username || state.user.username,
        };
      }
      lastCloudUpdatedAt = remoteUpdatedAt || lastCloudUpdatedAt;
      if (!hasRemoteChanges && state.sync.mode === "cloud") return true;
      state.sync = {
        ...state.sync,
        lastSyncAt: new Date().toISOString(),
        lastError: "",
        mode: "cloud",
      };
      saveState(false);
      refreshSchedule();
      render();
      return true;
    } catch (error) {
      if (error.status === 401) {
        state.user = null;
        saveState(false);
        render();
        showLogin();
        toast("انتهت الجلسة، سجل الدخول من جديد");
      } else {
        state.sync = {
          ...state.sync,
          mode: "local",
          lastError: "تعذر الاتصال مؤقتًا؛ سيُعاد الربط تلقائيًا.",
        };
        saveState(false);
        render();
      }
      return false;
    } finally {
      cloudPullPromise = null;
    }
  })();
  return cloudPullPromise;
}

function applyIncomingCloudState(data) {
  const incoming = normalizeState(data);
  isApplyingRemote = true;
  mergeIncomingState(incoming);
  if (THEME_PRESETS[incoming.settings?.theme]) {
    state.settings.theme = incoming.settings.theme;
  }
  state.settings.themeCustomizations = normalizeThemeCustomizations(
    incoming.settings?.themeCustomizations,
  );
  isApplyingRemote = false;
}

async function syncToCloud(manual = false) {
  if (!canCloudSync()) {
    if (manual) toast("سجل الدخول أولًا");
    return false;
  }
  if (cloudSyncPromise) {
    pendingCloudSync = true;
    await cloudSyncPromise;
    return manual ? syncToCloud(true) : true;
  }

  const revisionAtStart = localRevision;
  cloudSyncPromise = (async () => {
    try {
      const attemptedAt = new Date().toISOString();
      state.sync = { ...state.sync, lastAttemptAt: attemptedAt };
      saveState(false);
      const response = await accountRequest({
        action: "save",
        data: cloudStateSnapshot(state.user),
      });
      lastCloudUpdatedAt = response.user?.updatedAt || lastCloudUpdatedAt;
      if (response.data) mergeIncomingState(normalizeState(response.data));
      state.sync = {
        lastSyncAt: new Date().toISOString(),
        lastAttemptAt: attemptedAt,
        lastError: "",
        mode: "cloud",
      };
      pendingCloudSync = localRevision > revisionAtStart;
      saveState(false);
      if (manual) toast("تم حفظ آخر التغييرات");
      return true;
    } catch (error) {
      state.sync = {
        ...state.sync,
        mode: "local",
        lastAttemptAt: new Date().toISOString(),
        lastError: isBackendUnavailable(error)
          ? "تعذر الوصول للخادم الآن؛ تغييراتك محفوظة على هذا الجهاز وستُزامن عند عودة الاتصال."
          : error.message || "تعذرت المزامنة.",
      };
      pendingCloudSync = true;
      saveState(false);
      if (manual) toast(state.sync.lastError);
      return false;
    } finally {
      cloudSyncPromise = null;
      if (pendingCloudSync && navigator.onLine !== false) scheduleCloudSave(CLOUD_SYNC_DELAY);
    }
  })();
  return cloudSyncPromise;
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
  delete snapshot.user.authToken;
  snapshot.sync = {
    mode: "cloud",
    lastError: "",
  };
  return compactCloudState(snapshot);
}

function compactCloudState(snapshot) {
  const compact = compactAccountData(normalizeState(snapshot));
  delete compact.imports;
  compact.settings.snapshots = (compact.settings.snapshots || []).slice(0, 10);
  compact.tasks = compact.tasks.map((task) => removeEmptyFields({
    id: task.id,
    title: task.title,
    description: task.description,
    startDate: task.startDate,
    recurrence: task.recurrence,
    intervalDays: task.intervalDays === 1 ? undefined : task.intervalDays,
    dependencyId: task.dependencyId || undefined,
    time: task.time,
    endTime: task.endTime,
    requiredOverdue: task.requiredOverdue || undefined,
    importance: task.importance,
    active: task.active === false ? false : undefined,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }));
  compact.instances = Object.fromEntries(Object.entries(compact.instances).map(([id, item]) => [
    id,
    removeEmptyFields({
      ...item,
      history: Array.isArray(item.history) && item.history.length ? item.history.slice(-5) : undefined,
    }),
  ]));
  compact.meta.taskTombstones = compactTombstones(compact.meta.taskTombstones);
  compact.meta.instanceTombstones = compactTombstones(compact.meta.instanceTombstones);
  return compact;
}

function compactTombstones(tombstones) {
  const cutoff = Date.now() - 180 * 86_400_000;
  return Object.fromEntries(
    Object.entries(tombstones || {}).filter(([, value]) => {
      const timestamp = new Date(value).getTime();
      return Number.isFinite(timestamp) && timestamp >= cutoff;
    }),
  );
}

function removeEmptyFields(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== ""));
}

function refreshSchedule() {
  let changed = false;
  const today = todayISO();
  const now = new Date();
  const taskIds = new Set(state.tasks.map((task) => task.id));

  Object.keys(state.instances).forEach((id) => {
    const instance = state.instances[id];
    if (instance?.date !== today || instance.status !== "main" || instance.source !== "schedule") return;
    const task = getTask(instance.taskId);
    const eligible =
      task?.active &&
      isTaskDueOn(task, today) &&
      (!task.dependencyId || isDependencyCompleted(task.dependencyId, today));
    if (eligible) return;
    state.meta.instanceTombstones[id] = now.toISOString();
    delete state.instances[id];
    changed = true;
  });

  state.tasks.forEach((task) => {
    if (!task.active) return;
    const start = maxDate(task.startDate, addDays(today, -SCHEDULE_LOOKBACK_DAYS));
    forEachDate(start, today, (date) => {
      if (!isTaskDueOn(task, date)) return;
      if (task.dependencyId && !isDependencyCompleted(task.dependencyId, date)) return;
      const id = instanceId(task.id, date);
      if (!state.instances[id]) {
        state.instances[id] = createInstance(task, date);
        changed = true;
      } else if (taskIds.has(state.instances[id].taskId)) {
        changed = syncInstanceWithTask(state.instances[id], task) || changed;
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
      state.meta.instanceTombstones[id] = new Date().toISOString();
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
  if (["completed", "never", "deleted"].includes(instance.status)) return false;
  const fields = ["title", "description", "time", "endTime", "requiredOverdue", "importance"];
  const changed = fields.some((field) => instance[field] !== task[field]);
  if (!changed) return false;
  fields.forEach((field) => {
    instance[field] = task[field];
  });
  instance.updatedAt = new Date().toISOString();
  return true;
}

function isTaskDueOn(task, date) {
  return coreIsTaskDueOn(task, date);
}

function isDependencyCompleted(taskId, date) {
  const dependencyTask = getTask(taskId);
  const dueDate = latestDueDateOnOrBefore(dependencyTask, date);
  if (!dueDate) return false;
  const dependency = state.instances[instanceId(taskId, dueDate)];
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
  return mapTimeIntoWindow(time, state.settings.displayWindow);
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
  const dependencyId = el.taskDependency.value;
  const taskId = existingId || uid("task");
  if (wouldCreateDependencyCycle(state.tasks, taskId, dependencyId)) {
    toast("لا يمكن حفظ ربط دائري بين المهام");
    return;
  }
  const now = new Date().toISOString();
  const task = normalizeTask({
    id: taskId,
    title,
    description: el.taskDescription.value.trim(),
    startDate: el.taskStartDate.value || todayISO(),
    recurrence: el.taskRecurrence.value,
    intervalDays: Number(el.taskInterval.value || 1),
    dependencyId,
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
  el.taskTime.value = "00:00";
  el.taskEndTime.value = "23:59";
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
  const deletedAt = new Date().toISOString();
  state.meta.taskTombstones[id] = deletedAt;
  state.tasks = state.tasks.filter((item) => item.id !== id);
  state.tasks = state.tasks.map((item) =>
    item.dependencyId === id ? { ...item, dependencyId: "", updatedAt: deletedAt } : item,
  );
  Object.keys(state.instances).forEach((instanceIdValue) => {
    const instance = state.instances[instanceIdValue];
    if (instance.taskId === id && instance.status === "main") {
      state.meta.instanceTombstones[instanceIdValue] = deletedAt;
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
  state.tasks.forEach((task) => delete state.meta.taskTombstones[task.id]);
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
    state.tasks.forEach((task) => delete state.meta.taskTombstones[task.id]);
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

function mergeIncomingState(incoming) {
  state.meta.taskTombstones = mergeTimestampMaps(
    state.meta.taskTombstones,
    incoming.meta?.taskTombstones,
  );
  state.meta.instanceTombstones = mergeTimestampMaps(
    state.meta.instanceTombstones,
    incoming.meta?.instanceTombstones,
  );
  state.meta.runtimeResetAt = latestTimestamp(state.meta.runtimeResetAt, incoming.meta?.runtimeResetAt);

  const taskMap = new Map();
  [...state.tasks, ...incoming.tasks].forEach((task) => {
    const current = taskMap.get(task.id);
    if (!current || isAtLeastAsNew(task.updatedAt, current.updatedAt)) taskMap.set(task.id, task);
  });
  state.tasks = Array.from(taskMap.values())
    .filter((task) => isAfterTombstone(task.updatedAt, state.meta.taskTombstones[task.id]))
    .map(normalizeTask)
    .filter(Boolean);

  const instanceMap = new Map();
  [...Object.values(state.instances), ...Object.values(incoming.instances)].forEach((instance) => {
    const current = instanceMap.get(instance.id);
    if (!current || isAtLeastAsNew(instance.updatedAt, current.updatedAt)) {
      instanceMap.set(instance.id, instance);
    }
  });
  state.instances = Object.fromEntries(
    Array.from(instanceMap.entries()).filter(([, instance]) => {
      const deletedAt = latestTimestamp(
        state.meta.instanceTombstones[instance.id],
        state.meta.runtimeResetAt,
      );
      return isAfterTombstone(instance.updatedAt || instance.createdAt, deletedAt);
    }),
  );

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
  state.settings.snapshots = state.settings.snapshots
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 30);
  state.settings.statsExcludedInstanceIds = Array.from(
    new Set([
      ...(state.settings.statsExcludedInstanceIds || []),
      ...(incoming.settings.statsExcludedInstanceIds || []),
    ]),
  );
  state.settings.hiddenListInstanceIds = Array.from(
    new Set([
      ...(state.settings.hiddenListInstanceIds || []),
      ...(incoming.settings.hiddenListInstanceIds || []),
    ]),
  );
}

function mergeTimestampMaps(first, second) {
  const merged = { ...(first || {}) };
  Object.entries(second || {}).forEach(([id, value]) => {
    merged[id] = latestTimestamp(merged[id], value);
  });
  return merged;
}

function latestTimestamp(first, second) {
  if (!first) return second || null;
  if (!second) return first;
  return new Date(first).getTime() >= new Date(second).getTime() ? first : second;
}

function isAtLeastAsNew(candidate, current) {
  return new Date(candidate || 0).getTime() >= new Date(current || 0).getTime();
}

function isAfterTombstone(updatedAt, deletedAt) {
  if (!deletedAt) return true;
  return new Date(updatedAt || 0).getTime() > new Date(deletedAt).getTime();
}

function resetRuntimeData() {
  if (!confirm("إعادة الضبط ستحذف بيانات التنفيذ والقوائم وتبقي إعدادات المهام. هل تريد المتابعة؟")) return;
  const resetAt = new Date().toISOString();
  Object.keys(state.instances).forEach((id) => {
    state.meta.instanceTombstones[id] = resetAt;
  });
  state.meta.runtimeResetAt = resetAt;
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
    if (!ids.has(state.instances[id].taskId)) {
      state.meta.instanceTombstones[id] = new Date().toISOString();
      delete state.instances[id];
    }
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
  if (instance.status === "never" || instance.status === "completed") {
    hideListInstances([id]);
    selectedNever.delete(id);
    saveState();
    render();
    toast("تم حذفها من القائمة فقط");
    return;
  }
  state.meta.instanceTombstones[id] = new Date().toISOString();
  delete state.instances[id];
  selectedNever.delete(id);
  saveState();
  render();
  toast("تم حذف المهمة");
}

function requeueInstance(id) {
  const instance = state.instances[id];
  if (!instance) return;
  const now = new Date().toISOString();
  const retryId = `retry:${uid("run")}`;
  state.instances[retryId] = {
    ...clone(instance),
    id: retryId,
    date: todayISO(),
    status: "main",
    source: "retry",
    createdAt: now,
    updatedAt: now,
    movedAt: null,
    completedAt: null,
    completedFrom: null,
    history: [...(instance.history || []), { at: now, action: "أعيدت كمحاولة جديدة اليوم" }],
  };
  hideListInstances([id]);
  selectedNever.delete(id);
  saveState();
  refreshSchedule();
  render();
  toast("أُعيدت المهمة إلى مهام اليوم");
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
  const neverItems = visibleListInstances("never").slice(0, 10);
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
  hideListInstances(ids);
  selectedNever.clear();
  saveState();
  render();
  toast("تم حذف المهام المحددة");
}

function deleteAllNever() {
  const ids = visibleListInstances("never").map((item) => item.id);
  if (!ids.length) {
    toast("لا توجد مهام للحذف");
    return;
  }
  if (!confirm(`حذف كل مهام القائمة وعددها ${ids.length}؟`)) return;
  hideListInstances(ids);
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
  if (action === "new-task") {
    clearTaskForm();
    switchView("settings");
    el.taskTitle.focus();
  }
  if (action === "complete") completeInstance(id);
  if (action === "cancel-never") moveInstance(id, "never", "إلغاء: لم تنفذ");
  if (action === "soft-delete") moveInstance(id, "deleted", "حذف التفعيل الحالي");
  if (action === "move-required") moveInstance(id, "requiredOverdue", "نقل للمهام الواجبة");
  if (action === "move-optional") moveInstance(id, "optionalOverdue", "نقل للمهام غير المهمة");
  if (action === "move-never") moveInstance(id, "never", "نقل للمهام التي لم تنفذ");
  if (action === "move-completed") completeInstance(id);
  if (action === "restore-main") requeueInstance(id);
  if (action === "delete-instance") deleteInstance(id);
  if (action === "edit-task") fillTaskForm(id);
  if (action === "delete-task") deleteTask(id);
  if (action === "load-snapshot") loadSettingsSnapshot(id);
  if (action === "delete-snapshot") deleteSettingsSnapshot(id);
  if (action === "delete-stat-instance") excludeInstanceFromStats(id);
  if (action === "open-audit-stats") switchView("statsAudit");
  if (action === "back-to-stats") switchView("stats");
  if (action === "toggle-audit-picker") {
    auditTaskPickerOpen = !auditTaskPickerOpen;
    auditStatsMode = selectedAuditTaskId ? "task" : "";
    renderAuditStats();
  }
  if (action === "show-audit-summary") {
    auditTaskPickerOpen = false;
    auditStatsMode = "summary";
    renderAuditStats();
  }
  if (action === "toggle-data-month") {
    toggleDataMonth(Number(button.dataset.month));
  }
  if (action === "admin-reveal") openAdminReveal(button.dataset.username);
}

function handleSelectionChange(event) {
  const auditSelect = event.target.closest("#auditTaskSelect");
  if (auditSelect) {
    selectedAuditTaskId = auditSelect.value;
    auditStatsMode = selectedAuditTaskId ? "task" : "";
    renderAuditStats();
    return;
  }

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
  if (el.syncIndicator) {
    el.syncIndicator.textContent =
      state.sync.mode === "cloud"
        ? pendingCloudSync
          ? "جارٍ الحفظ التلقائي"
          : "مزامنة تلقائية"
        : "محفوظ محليًا";
    el.syncIndicator.dataset.state = state.sync.mode;
  }
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
  if (currentView === "statsAudit") renderAuditStats();
  if (currentView === "dataExport") renderDataExport();
  if (currentView === "account") renderAccount();
  if (currentView === "admin") renderAdmin();
  if (currentView === "adminReveal") renderAdminReveal();
  refreshIcons();
}

function refreshIcons() {
  globalThis.lucide?.createIcons({
    attrs: {
      "stroke-width": 1.8,
      "aria-hidden": "true",
    },
  });
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
  if (!state.tasks.length) {
    el.activeTasks.innerHTML = `
      <div class="empty">
        <span class="empty-icon" aria-hidden="true">+</span>
        <p>لم تُضف أي مهمة بعد</p>
        <button class="primary-button" data-action="new-task" type="button">
          <i data-lucide="plus" aria-hidden="true"></i>
          <span>إضافة أول مهمة</span>
        </button>
      </div>
    `;
  } else {
    renderTaskList(el.activeTasks, active, "main");
  }
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
  renderSortButtons("never");
  renderTaskList(el.neverTasks, visibleListInstances("never"), "never");
}

function renderDeleted() {
  renderTaskList(el.deletedTasks, getInstancesByStatus("deleted"), "deleted");
}

function renderCompleted() {
  renderSortButtons("completed");
  renderTaskList(el.completedTasks, visibleListInstances("completed"), "completed");
}

function renderDataExport() {
  const year = new Date().getFullYear();
  if (el.dataYearLabel) el.dataYearLabel.textContent = `${year}`;
  if (el.dataMonthButtons) {
    el.dataMonthButtons.innerHTML = monthNames
      .map((name, index) => {
        const month = index + 1;
        const active = selectedDataMonths.has(month) ? "active" : "";
        return `<button class="ghost-button ${active}" data-action="toggle-data-month" data-month="${month}" type="button">${month} - ${name}</button>`;
      })
      .join("");
  }
  if (el.dataExportSummary) {
    const count = selectedDataMonths.size;
    el.dataExportSummary.textContent = count ? `تم اختيار ${count} شهر` : "اختر شهرًا أو السنة كاملة";
  }
}

function toggleDataMonth(month) {
  if (!month || month < 1 || month > 12) return;
  if (selectedDataMonths.has(month)) {
    selectedDataMonths.delete(month);
  } else if (selectedDataMonths.size < 12) {
    selectedDataMonths.add(month);
  }
  renderDataExport();
}

function selectAllDataMonths() {
  selectedDataMonths = new Set(Array.from({ length: 12 }, (_, index) => index + 1));
  renderDataExport();
}

function clearDataMonths() {
  selectedDataMonths.clear();
  renderDataExport();
}

function downloadDataExport() {
  refreshSchedule();
  const year = new Date().getFullYear();
  const months = Array.from(selectedDataMonths).sort((a, b) => a - b);
  if (!months.length) {
    toast("اختر شهرًا واحدًا على الأقل");
    return;
  }
  const monthSet = new Set(months.map((month) => `${year}-${String(month).padStart(2, "0")}`));
  const items = Object.values(state.instances)
    .filter((item) => item?.date && monthSet.has(item.date.slice(0, 7)))
    .sort((a, b) => sortInstancesByDate(a, b, "newest"));
  const text = buildDataExportText(year, months, items);
  downloadText(`ifal-tasks-${year}-${months.join("-")}.txt`, text);
  toast("تم تجهيز ملف البيانات");
}

function buildDataExportText(year, months, items) {
  const lines = [
    "جميع المهام والبيانات",
    `السنة: ${year}`,
    `الأشهر: ${months.map((month) => `${month} ${monthNames[month - 1]}`).join(", ")}`,
    `وقت التصدير: ${formatDateTime(new Date().toISOString())}`,
    `عدد السجلات: ${items.length}`,
    "",
  ];
  let lastDate = "";
  items.forEach((item) => {
    const task = getTask(item.taskId);
    if (item.date !== lastDate) {
      lastDate = item.date;
      lines.push(`===== ${formatDate(item.date)} =====`);
    }
    lines.push(`المهمة: ${item.title || task?.title || "بدون اسم"}`);
    lines.push(`الحالة: ${statusText(item.status)}`);
    lines.push(`التاريخ: ${item.date}`);
    lines.push(`الوقت: ${item.time || task?.time || ""} - ${item.endTime || task?.endTime || ""}`);
    lines.push(`الأهمية: ${item.importance || task?.importance || ""}`);
    lines.push(`التكرار: ${task ? recurrenceLabel(task) : "غير محدد"}`);
    lines.push(`الوصف: ${item.description || task?.description || ""}`);
    lines.push(`تم التنفيذ في: ${item.completedAt ? formatDateTime(item.completedAt) : "لا يوجد"}`);
    lines.push(`آخر تحديث: ${item.updatedAt ? formatDateTime(item.updatedAt) : "غير محدد"}`);
    lines.push(`معرف المهمة: ${item.taskId}`);
    lines.push(`معرف السجل: ${item.id}`);
    if (Array.isArray(item.history) && item.history.length) {
      lines.push("السجل:");
      item.history.forEach((entry) => lines.push(`- ${entry.at ? formatDateTime(entry.at) : ""}: ${entry.action || ""}`));
    }
    lines.push("");
  });
  if (!items.length) lines.push("لا توجد مهام في الأشهر المحددة.");
  return lines.join("\n");
}

function setListSort(type, mode) {
  if (type === "never") neverSortMode = mode;
  if (type === "completed") completedSortMode = mode;
  render();
}

function renderSortButtons(type) {
  const mode = type === "never" ? neverSortMode : completedSortMode;
  const newest = type === "never" ? el.neverSortNewest : el.completedSortNewest;
  const oldest = type === "never" ? el.neverSortOldest : el.completedSortOldest;
  if (newest) newest.classList.toggle("active", mode === "newest");
  if (oldest) oldest.classList.toggle("active", mode === "oldest");
}

function visibleListInstances(status) {
  const hidden = new Set(state.settings.hiddenListInstanceIds || []);
  const mode = status === "completed" ? completedSortMode : neverSortMode;
  return getInstancesByStatus(status)
    .filter((item) => !hidden.has(item.id))
    .sort((a, b) => sortInstancesByDate(a, b, mode));
}

function sortInstancesByDate(a, b, mode) {
  const timeA = a.completedAt || a.movedAt || a.updatedAt || `${a.date}T00:00:00`;
  const timeB = b.completedAt || b.movedAt || b.updatedAt || `${b.date}T00:00:00`;
  return mode === "oldest" ? timeA.localeCompare(timeB) : timeB.localeCompare(timeA);
}

function hideListInstances(ids) {
  const hidden = new Set(state.settings.hiddenListInstanceIds || []);
  ids.forEach((id) => hidden.add(id));
  state.settings.hiddenListInstanceIds = Array.from(hidden);
}

function renderAccount() {
  const user = state.user;
  if (!user) {
    el.accountSyncState.textContent = "غير مسجل";
    el.accountDetails.innerHTML = emptyState("سجل الدخول لعرض معلومات الحساب");
    el.storageExplanation.textContent =
      "بدون تسجيل دخول، يتم حفظ البيانات داخل هذا المتصفح فقط ولا تنتقل إلى جهاز آخر.";
    if (el.changePasswordForm) el.changePasswordForm.hidden = true;
    return;
  }

  el.accountSyncState.textContent = state.sync.mode === "cloud" ? "مزامنة تلقائية" : "محفوظ محليًا";
  if (el.changePasswordForm) el.changePasswordForm.hidden = !canCloudSync();
  el.accountDetails.innerHTML = `
    ${accountRow("الاسم", user.name || "غير محدد")}
    ${accountRow("اسم المستخدم", user.username || "غير محدد")}
    ${accountRow("البريد", user.email || "غير محدد")}
    ${accountRow("آخر دخول", user.loggedInAt ? formatDateTime(user.loggedInAt) : "غير محدد")}
    ${accountRow("آخر مزامنة", state.sync.lastSyncAt ? formatDateTime(state.sync.lastSyncAt) : "لم تتم بعد")}
  `;
  el.storageExplanation.textContent =
    state.sync.mode === "cloud"
      ? "تُحفظ تغييراتك تلقائيًا خلال أجزاء من الثانية، وتُجلب تحديثات أجهزتك الأخرى كل ثانية عبر PostgreSQL على Render."
      : state.sync.lastError || "البيانات محفوظة داخل هذا الجهاز فقط. بعد رفع الموقع على Render ستعمل المزامنة بين الأجهزة.";
}

function accountRow(label, value) {
  return `<div class="account-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function renderAdmin() {
  if (!isAdmin) {
    if (el.adminUserList) el.adminUserList.innerHTML = emptyState("هذه الصفحة للمدير فقط");
    if (el.adminUserCount) el.adminUserCount.textContent = "";
    return;
  }

  if (!adminUsersLoaded) {
    if (el.adminUserList) el.adminUserList.innerHTML = emptyState("جاري تحميل الحسابات...");
    if (!adminUsersLoading) {
      loadAdminUsers()
        .then(renderAdminList)
        .catch((error) => {
          if (el.adminUserList) {
            el.adminUserList.innerHTML = emptyState(error.message || "تعذر تحميل الحسابات");
          }
          if (el.adminUserCount) el.adminUserCount.textContent = "";
        });
    }
    return;
  }

  renderAdminList();
}

function renderAdminList() {
  if (!el.adminUserList) return;
  const filteredUsers = adminSearchTerm
    ? adminUsers.filter((user) =>
        [user.username, user.name, user.email]
          .map(normalizeSearchText)
          .some((value) => value.includes(adminSearchTerm)),
      )
    : adminUsers;

  if (el.adminUserCount) {
    el.adminUserCount.textContent = adminSearchTerm
      ? `${filteredUsers.length} من ${adminUsers.length}`
      : `${adminUsers.length} حساب`;
  }

  if (!filteredUsers.length) {
    el.adminUserList.innerHTML = emptyState(
      adminSearchTerm ? "لا توجد نتائج مطابقة" : "لا توجد حسابات مسجلة بعد",
    );
    return;
  }

  el.adminUserList.innerHTML = filteredUsers
    .map(
      (user) => `
        <div class="admin-user-row">
          <div class="admin-user-identity">
            <span class="admin-user-avatar" aria-hidden="true">${escapeHtml((user.name || user.username).slice(0, 1).toUpperCase())}</span>
            <div>
              <strong>${escapeHtml(user.name || user.username)}</strong>
              <span>@${escapeHtml(user.username)}${user.isAdmin ? ' <b class="pill">مدير</b>' : ""}</span>
              <small>${escapeHtml(user.email || "بلا بريد")} • ${user.taskSettingsCount} إعداد مهمة</small>
            </div>
          </div>
          <button class="ghost-button admin-reveal-button" data-action="admin-reveal" data-username="${escapeHtml(user.username)}" type="button">إدارة</button>
        </div>
      `,
    )
    .join("");
}

function renderAdminReveal() {
  if (!isAdmin) {
    if (el.adminRevealProfile) el.adminRevealProfile.innerHTML = emptyState("هذه الصفحة للمدير فقط");
    if (el.adminRevealTasks) el.adminRevealTasks.innerHTML = "";
    if (el.adminControlPanel) el.adminControlPanel.hidden = true;
    return;
  }

  if (el.adminRevealTitle) {
    el.adminRevealTitle.textContent = adminRevealTarget
      ? `إدارة: ${adminRevealTarget}`
      : "إدارة الحساب";
  }

  if (adminRevealLoading) {
    if (el.adminRevealProfile) el.adminRevealProfile.innerHTML = emptyState("جاري جلب بيانات الحساب...");
    if (el.adminRevealTasks) el.adminRevealTasks.innerHTML = "";
    if (el.adminControlPanel) el.adminControlPanel.hidden = true;
    return;
  }

  if (!adminRevealData) {
    if (el.adminRevealProfile) el.adminRevealProfile.innerHTML = emptyState("لا توجد بيانات للعرض");
    if (el.adminRevealTasks) el.adminRevealTasks.innerHTML = "";
    if (el.adminControlPanel) el.adminControlPanel.hidden = true;
    return;
  }

  const user = adminRevealData.user || {};
  const month = adminRevealData.month || {};
  const tasks = Array.isArray(adminRevealData.tasks) ? adminRevealData.tasks : [];
  const selfAccount = normalizeUsername(state.user?.username) === adminRevealTarget;
  const protectedAdmin = Boolean(user.isAdmin) || adminUsers.some(
    (item) => item.username === adminRevealTarget && item.isAdmin,
  );

  if (el.adminRevealProfile) {
    el.adminRevealProfile.innerHTML = `
      ${accountRow("اسم المستخدم", user.username || adminRevealTarget)}
      ${accountRow("الاسم", user.name || "غير محدد")}
      ${accountRow("البريد", user.email || "غير محدد")}
      ${accountRow("آخر دخول", user.lastLogin ? formatDateTime(user.lastLogin) : "غير محدد")}
      ${accountRow("تاريخ التسجيل", user.createdAt ? formatDateTime(user.createdAt) : "غير محدد")}
      ${accountRow("آخر تحديث", user.updatedAt ? formatDateTime(user.updatedAt) : "غير محدد")}
      ${accountRow("سجل الشهر", month.label || "الشهر الحالي")}
    `;
  }

  if (el.adminControlPanel) el.adminControlPanel.hidden = false;
  if (el.adminManageName && document.activeElement !== el.adminManageName) {
    el.adminManageName.value = user.name || "";
  }
  if (el.adminManageEmail && document.activeElement !== el.adminManageEmail) {
    el.adminManageEmail.value = user.email || "";
  }
  if (el.adminManagePasswordForm) el.adminManagePasswordForm.hidden = selfAccount;
  if (el.adminSignoutUser) el.adminSignoutUser.hidden = selfAccount;
  if (el.adminDeleteUser) el.adminDeleteUser.hidden = selfAccount || protectedAdmin;

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
        ${actionButton("ghost-button", "edit-task", task.id, "pencil", "تعديل")}
        ${actionButton("danger-button", "delete-task", task.id, "trash-2", "حذف")}
      </div>
    </article>
  `;
}

function instanceActions(instance, type) {
  const commonMain = [
    ["primary-button", "complete", "circle-check", "تم"],
    ["ghost-button", "cancel-never", "circle-x", "لم تنفذ"],
    ["ghost-button danger", "soft-delete", "trash-2", "حذف"],
    ["ghost-button", "edit-task", "settings-2", "الإعداد", instance.taskId],
  ];
  const actionsByType = {
    main: commonMain,
    upcoming: commonMain,
    required: [
      ["primary-button", "complete", "circle-check", "تم"],
      ["ghost-button", "restore-main", "rotate-ccw", "إعادة لليوم"],
      ["ghost-button", "move-optional", "arrow-left-right", "غير واجبة"],
      ["danger-button", "delete-instance", "trash-2", "حذف"],
    ],
    optional: [
      ["primary-button", "complete", "circle-check", "تم"],
      ["ghost-button", "restore-main", "rotate-ccw", "إعادة لليوم"],
      ["ghost-button", "move-required", "badge-alert", "نقل للواجبة"],
      ["danger-button", "delete-instance", "trash-2", "حذف"],
    ],
    never: [
      ["primary-button", "complete", "circle-check", "تم لاحقًا"],
      ["ghost-button", "restore-main", "rotate-ccw", "إعادة لليوم"],
      ["ghost-button", "move-required", "badge-alert", "نقل للواجبة"],
      ["danger-button", "delete-instance", "trash-2", "حذف"],
    ],
    deleted: [
      ["ghost-button", "restore-main", "rotate-ccw", "إعادة لليوم"],
      ["ghost-button", "move-required", "badge-alert", "نقل للواجبة"],
      ["ghost-button", "move-optional", "arrow-left-right", "غير واجبة"],
      ["ghost-button", "move-never", "circle-x", "غير منفذة"],
      ["ghost-button", "move-completed", "circle-check", "منفذة"],
      ["danger-button", "delete-instance", "trash-2", "حذف نهائي"],
    ],
    completed: [
      ["ghost-button", "restore-main", "rotate-ccw", "تنفيذ مجددًا"],
      ["danger-button", "delete-instance", "trash-2", "إخفاء"],
    ],
  };
  return (actionsByType[type] || [])
    .map(([className, action, iconName, label, targetId]) =>
      actionButton(className, action, targetId || instance.id, iconName, label),
    )
    .join("");
}

function actionButton(className, action, id, iconName, label) {
  return `<button class="${className}" data-action="${action}" data-id="${id}" type="button">
    <i data-lucide="${iconName}" aria-hidden="true"></i>
    <span>${label}</span>
  </button>`;
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
  const monthStart = startOfMonth(today);
  const yesterday = addDays(today, -1);
  const todayStats = statsForDates([today]);
  const yesterdayStats = yesterday >= monthStart ? statsForDates([yesterday]) : emptyStats();
  const weekDates = rangeDates(maxDate(startOfWeek(today), monthStart), today);
  const previousWeekStart = addDays(startOfWeek(today), -7);
  const previousWeekEnd = addDays(previousWeekStart, 6);
  const previousWeekDates = previousWeekEnd >= monthStart ? rangeDates(maxDate(previousWeekStart, monthStart), previousWeekEnd) : [];
  const monthDates = rangeDates(monthStart, today);
  const previousMonthStart = startOfPreviousMonth(today);
  const previousMonthDates = rangeDates(previousMonthStart, endOfMonth(previousMonthStart));
  const monthStats = statsForDates(monthDates);
  const weekStats = statsForDates(weekDates);

  el.statsSummary.innerHTML = [
    metric(`${todayStats.rate}%`, "إنجاز اليوم"),
    metric(`${weekStats.rate}%`, "إنجاز الأسبوع"),
    metric(`${monthStats.rate}%`, "إنجاز الشهر"),
    metric(currentMonthStatInstances().filter((item) => item.status === "completed").length, "كل المنفذ"),
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

function statsForDates(dates, filter = null) {
  const dateSet = new Set(dates);
  const items = statEligibleInstances().filter((item) => dateSet.has(item.date) && (!filter || filter(item)));
  return calculateStats(items);
}

function emptyStats() {
  return { total: 0, completed: 0, pending: 0, missed: 0, decided: 0, rate: 0, items: [] };
}

function renderAuditStats() {
  renderAuditTaskOptions();
  if (el.auditTaskPicker) {
    el.auditTaskPicker.classList.toggle("hidden", !auditTaskPickerOpen);
  }

  if (!state.tasks.length) {
    renderAuditEmpty("لا توجد مهام للاختيار");
    return;
  }

  if (auditStatsMode === "summary") {
    renderAuditAllSummary();
    return;
  }

  const option = selectedAuditTaskId ? auditTaskOptions().find((item) => item.value === selectedAuditTaskId) : null;
  if (!option) {
    if (selectedAuditTaskId) selectedAuditTaskId = "";
    renderAuditEmpty("اختر مهمة لعرض إحصائياتها المدققة");
    return;
  }

  renderAuditTaskStats(option);
}

function renderAuditTaskOptions() {
  if (!el.auditTaskSelect) return;
  const options = auditTaskOptions();
  if (selectedAuditTaskId && !options.some((item) => item.value === selectedAuditTaskId)) {
    selectedAuditTaskId = "";
    auditStatsMode = "";
  }
  el.auditTaskSelect.innerHTML = [`<option value="">اختر مهمة</option>`]
    .concat(options.map((item) => `<option value="${escapeHtml(item.value)}">${escapeHtml(item.title)}</option>`))
    .join("");
  el.auditTaskSelect.value = selectedAuditTaskId;
  el.auditTaskSelect.disabled = options.length === 0;
}

function auditTaskOptions() {
  const options = state.tasks
    .slice()
    .sort(sortTasks)
    .map((task) => ({
      value: `task:${task.id}`,
      title: task.title,
      taskId: task.id,
      titleKey: auditTaskKey(task.title),
    }));
  const seen = new Set(options.map((item) => item.value));
  currentMonthStatInstances().forEach((item) => {
    if (getTask(item.taskId)) return;
    const value = `orphan:${item.taskId || auditTaskKey(item.title)}`;
    if (seen.has(value)) return;
    seen.add(value);
    options.push({
      value,
      title: `${item.title || "مهمة بدون اسم"} (سجل قديم)`,
      orphanTaskId: item.taskId,
      titleKey: auditTaskKey(item.title),
    });
  });
  return options;
}

function renderAuditEmpty(message) {
  if (el.auditSingleSummary) el.auditSingleSummary.innerHTML = "";
  if (el.auditSingleStats) el.auditSingleStats.classList.add("hidden");
  if (el.auditAllSummary) {
    el.auditAllSummary.classList.remove("hidden");
    el.auditAllSummary.innerHTML = emptyState(message);
  }
}

function renderAuditTaskStats(option) {
  const today = todayISO();
  const monthStart = startOfMonth(today);
  const taskFilter = (item) => auditOptionMatches(option, item);
  const weekDates = rangeDates(maxDate(startOfWeek(today), monthStart), today);
  const monthDates = rangeDates(monthStart, today);
  const todayStats = statsForDates([today], taskFilter);
  const weekStats = statsForDates(weekDates, taskFilter);
  const monthStats = statsForDates(monthDates, taskFilter);
  const monthItems = monthStats.items.slice().sort(sortInstances);

  if (el.auditAllSummary) el.auditAllSummary.classList.add("hidden");
  if (el.auditSingleStats) el.auditSingleStats.classList.remove("hidden");
  if (el.auditSingleSummary) {
    el.auditSingleSummary.innerHTML = [
      metric(`${todayStats.rate}%`, "إنجاز اليوم"),
      metric(`${weekStats.rate}%`, "إنجاز الأسبوع"),
      metric(`${monthStats.rate}%`, "إنجاز الشهر"),
      metric(monthStats.total, "سجل الشهر"),
    ].join("");
  }

  if (el.auditDailyMeta) el.auditDailyMeta.textContent = `${todayStats.total} سجل`;
  if (el.auditWeeklyMeta) el.auditWeeklyMeta.textContent = `${weekStats.total} سجل`;
  if (el.auditMonthlyMeta) el.auditMonthlyMeta.textContent = `${monthStats.total} سجل`;
  if (el.auditDailyStats) el.auditDailyStats.innerHTML = statBlock(todayStats);
  if (el.auditWeeklyStats) el.auditWeeklyStats.innerHTML = statBlock(weekStats);
  if (el.auditMonthlyStats) el.auditMonthlyStats.innerHTML = statBlock(monthStats);
  if (el.auditMonthLogCount) el.auditMonthLogCount.textContent = `${monthItems.length} سجل`;
  if (el.auditMonthLog) {
    el.auditMonthLog.innerHTML = monthItems.length
      ? monthItems.map(auditMonthLogItem).join("")
      : emptyState("لا توجد سجلات لهذه المهمة خلال الشهر الحالي");
  }
}

function auditOptionMatches(option, item) {
  if (!option || !item) return false;
  if (option.taskId) {
    if (item.taskId === option.taskId) return true;
    return !getTask(item.taskId) && auditTaskKey(item.title) === option.titleKey;
  }
  if (option.orphanTaskId) return item.taskId === option.orphanTaskId;
  return !getTask(item.taskId) && auditTaskKey(item.title) === option.titleKey;
}

function auditMonthLogItem(item) {
  const completed = item.status === "completed";
  return `
    <div class="history-item audit-log-item">
      <div>
        <strong>${formatDate(item.date)}</strong>
        <small>${statusText(item.status)}</small>
      </div>
      <span class="pill ${completed ? "green" : "amber"}">${completed ? "تم التنفيذ" : "لم يتم التنفيذ"}</span>
    </div>
  `;
}

function renderAuditAllSummary() {
  if (el.auditSingleSummary) el.auditSingleSummary.innerHTML = "";
  if (el.auditSingleStats) el.auditSingleStats.classList.add("hidden");
  if (!el.auditAllSummary) return;

  const summaries = auditMonthlyTaskSummaries();
  el.auditAllSummary.classList.remove("hidden");
  el.auditAllSummary.innerHTML = summaries.length
    ? `
      <div class="section-head">
        <h3>ملخص الكل</h3>
        <span>${summaries.length} مهمة</span>
      </div>
      <div class="audit-summary-list">
        ${summaries.map(auditSummaryItem).join("")}
      </div>
    `
    : emptyState("لا توجد مهام لها سجلات في الشهر الحالي");
}

function auditMonthlyTaskSummaries() {
  const today = todayISO();
  const monthStart = startOfMonth(today);
  const groups = new Map();
  statEligibleInstances().forEach((item) => {
    if (!item.date || item.date < monthStart || item.date > today) return;
    const task = getTask(item.taskId);
    const title = task?.title || item.title || "مهمة بدون اسم";
    const key = task ? `task:${task.id}` : `orphan:${item.taskId || auditTaskKey(title)}`;
    if (!key) return;
    if (!groups.has(key)) {
      groups.set(key, { title, items: [] });
    }
    const group = groups.get(key);
    if (task?.title) group.title = task.title;
    group.items.push(item);
  });

  return Array.from(groups.values())
    .map(({ title, items }) => {
      const stats = calculateStats(items);
      const { total, completed, pending, missed } = stats;
      const completedRate = stats.rate;
      const missedRate = stats.decided ? Math.max(0, 100 - completedRate) : 0;
      return {
        title,
        total,
        completed,
        pending,
        missed,
        completedRate,
        missedRate,
      };
    })
    .filter((item) => item.total > 0)
    .sort((a, b) => a.title.localeCompare(b.title, "ar"));
}

function auditTaskKey(title) {
  return String(title || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("ar-SA");
}

function auditSummaryItem(item) {
  return `
    <article class="audit-summary-item">
      <strong>${escapeHtml(item.title)}</strong>
      <div class="audit-ratio-list">
        <div class="audit-ratio-row">
          <span>تم التنفيذ</span>
          <b>${item.completedRate}%</b>
          <em>${item.completed} مرة</em>
        </div>
        <div class="audit-ratio-row">
          <span>لم يتم التنفيذ</span>
          <b>${item.missedRate}%</b>
          <em>${item.missed} مرة</em>
        </div>
        ${
          item.pending
            ? `<div class="audit-ratio-row"><span>قيد الانتظار</span><b>—</b><em>${item.pending} مرة</em></div>`
            : ""
        }
      </div>
    </article>
  `;
}

function statBlock(stats) {
  return `
    ${statLine("تم تنفيذها", stats.completed, stats.total, "green")}
    ${statLine("لم تنفذ", stats.missed, stats.total, stats.missed ? "amber" : "green")}
    ${statLine("قيد الانتظار", stats.pending, stats.total, "blue")}
    ${statLine("النسبة", stats.rate, 100, stats.rate >= 70 ? "green" : stats.rate >= 40 ? "amber" : "red", "%")}
  `;
}

function importanceStatsBlock() {
  return [2, 4, 6, 8, 10]
    .map((importance) => {
      const items = currentMonthStatInstances().filter((item) => Number(item.importance) === importance);
      const { rate } = calculateStats(items);
      return statLine(`${importance} ${importanceLabels[importance]}`, rate, 100, rate >= 70 ? "green" : rate >= 40 ? "amber" : "red", "%");
    })
    .join("");
}

function renderStatsSettings() {
  const items = currentMonthStatInstances().sort(sortInstances);
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

function currentMonthStatInstances() {
  const today = todayISO();
  const start = startOfMonth(today);
  return statEligibleInstances().filter((item) => item.date && item.date >= start && item.date <= today);
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
    return (
      task.id !== currentTaskId &&
      task.active &&
      !wouldCreateDependencyCycle(state.tasks, currentTaskId, task.id)
    );
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
  return `<div class="metric"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`;
}

function emptyState(text) {
  return `<div class="empty"><span class="empty-icon" aria-hidden="true">✓</span><p>${escapeHtml(text)}</p></div>`;
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

function toast(message) {
  el.toast.textContent = message;
  el.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove("show"), 2600);
}

function uid(prefix) {
  const random = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `${prefix}-${random}`;
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

function minutesNow(date = new Date()) {
  return date.getHours() * 60 + date.getMinutes();
}

function formatDate(date) {
  const parsed = parseDate(date);
  if (Number.isNaN(parsed.getTime())) return "تاريخ غير صالح";
  return new Intl.DateTimeFormat("ar-SA-u-ca-gregory", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(parsed);
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
  if (Number.isNaN(date.getTime())) return "غير محدد";
  return new Intl.DateTimeFormat("ar-SA-u-ca-gregory", {
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
