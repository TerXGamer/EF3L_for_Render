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
  light: "ÙØ§ØªØ­",
  calm: "Ù‡Ø§Ø¯Ø¦",
  ocean: "Ø¨Ø­Ø±ÙŠ",
  rose: "ÙˆØ±Ø¯ÙŠ",
  dark: "Ø¯Ø§ÙƒÙ†",
  graphite: "ÙØ­Ù…ÙŠ",
  night: "Ù„ÙŠÙ„ÙŠ",
};
const CUSTOM_THEME_PROPERTIES = [
  "--bg", "--surface", "--surface-soft", "--field", "--line", "--line-strong",
  "--text", "--muted", "--teal", "--teal-dark", "--coral", "--amber", "--green",
  "--red", "--blue", "--sidebar-bg", "--sidebar-text", "--sidebar-muted",
  "--nav-hover", "--nav-active", "--toast-bg", "--toast-text", "--shadow",
];

const titles = {
  main: "Ù…Ù‡Ø§Ù… Ø§Ù„ÙŠÙˆÙ…",
  settings: "Ø¥Ø¹Ø¯Ø§Ø¯Ø§Øª Ø§Ù„Ù…Ù‡Ø§Ù…",
  required: "Ø§Ù„Ù…Ù‡Ø§Ù… Ø§Ù„Ù…Ù†ØªÙ‡ÙŠØ© Ø§Ù„ÙˆØ§Ø¬Ø¨Ø©",
  optional: "Ø§Ù„Ù…Ù‡Ø§Ù… ØºÙŠØ± Ø§Ù„ÙˆØ§Ø¬Ø¨Ø©",
  never: "Ø§Ù„Ù…Ù‡Ø§Ù… ØºÙŠØ± Ø§Ù„Ù…Ù†ÙØ°Ø©",
  completed: "Ù…Ù‡Ø§Ù… ØªÙ… ØªÙ†ÙÙŠØ°Ù‡Ø§",
  stats: "Ø§Ù„Ø¥Ø­ØµØ§Ø¦ÙŠØ§Øª",
  statsAudit: "Ø§Ù„Ø¥Ø­ØµØ§Ø¦ÙŠØ§Øª Ø§Ù„Ù…Ø¯Ù‚Ù‚Ø©",
  dataExport: "Ø¬Ù…ÙŠØ¹ Ø§Ù„Ù…Ù‡Ø§Ù… ÙˆØ§Ù„Ø¨ÙŠØ§Ù†Ø§Øª",
  site: "\u0625\u0639\u062f\u0627\u062f\u0627\u062a \u0627\u0644\u0645\u0648\u0642\u0639",
  account: "Ø­Ø³Ø§Ø¨ÙŠ",
  lists: "Ø¹Ø§Ù… Ø§Ù„Ù‚ÙˆØ§Ø¦Ù…",
  settingsHub: "Ø§Ù„Ø¥Ø¹Ø¯Ø§Ø¯Ø§Øª",
  deleted: "Ø§Ù„Ù…Ù‡Ø§Ù… Ø§Ù„Ù…Ø­Ø°ÙˆÙØ©",
  reset: "Ø¥Ø¹Ø§Ø¯Ø© Ø§Ù„Ø¶Ø¨Ø·",
  admin: "Ù„ÙˆØ­Ø© Ø§Ù„Ø¥Ø¯Ø§Ø±Ø©",
  adminReveal: "Ø¥Ø¯Ø§Ø±Ø© Ø§Ù„Ø­Ø³Ø§Ø¨",
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
  2: "Ù…Ù†Ø®ÙØ¶",
  4: "Ù…ØªÙˆØ³Ø·",
  6: "Ø¹Ø§Ù„ÙŠ",
  8: "Ø¹Ø§Ù„ÙŠ Ø¬Ø¯Ù‹Ø§",
  10: "Ù‚Ù…Ø©",
};

const monthNames = [
  "ÙŠÙ†Ø§ÙŠØ±",
  "ÙØ¨Ø±Ø§ÙŠØ±",
  "Ù…Ø§Ø±Ø³",
  "Ø£Ø¨Ø±ÙŠÙ„",
  "Ù…Ø§ÙŠÙˆ",
  "ÙŠÙˆÙ†ÙŠÙˆ",
  "ÙŠÙˆÙ„ÙŠÙˆ",
  "Ø£ØºØ³Ø·Ø³",
  "Ø³Ø¨ØªÙ…Ø¨Ø±",
  "Ø£ÙƒØªÙˆØ¨Ø±",
  "Ù†ÙˆÙÙ…Ø¨Ø±",
  "Ø¯ÙŠØ³Ù…Ø¨Ø±",
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
    "-ßM4ÖÚ$z{-®éÜj×'’æ6Æ74Æ—7BæFB‚&†–FFVâ"“°¢–b†VÂæVF—E6–ævÆU7FG2’VÂæVF—E6–ævÆU7FG2æ6Æ74Æ—7Bç&VÖ÷fR‚&†–FFVâ"“°¢–b†VÂæVF—E6–ævÆU7VÖÖ'’’°¢VÂæVF—E6–ævÆU7VÖÖ'’æ–ææW$…DÔÂÒ°¢ÖWG&–2†G·FöF•7FG2ç&FWÒVÂ-Š]˜mŠÍŠ}‹"Š}˜M˜­˜˜R"’À¢ÖWG&–2†G·vVVµ7FG2ç&FWÒVÂ-Š]˜mŠÍŠ}‹"Š}˜MŠ=‹=Š˜‹’"’À¢ÖWG&–2†G¶ÖöçF…7FG2ç&FWÒVÂ-Š]˜mŠÍŠ}‹"Š}˜M‹M˜}‹"’À¢ÖWG&–2†ÖöçF…7FG2çF÷FÂÂ-‹=ŠÍ˜BŠ}˜M‹M˜}‹"’À¢Òæ¦ö–â‚""“°¢Ð ¢–b†VÂæVF—DF–Ç”ÖWF’VÂæVF—DF–Ç”ÖWFçFW‡D6öçFVçBÒG·FöF•7FG2çF÷FÇÒ‹=ŠÍ˜F°¢–b†VÂæVF—EvVV¶Ç”ÖWF’VÂæVF—EvVV¶Ç”ÖWFçFW‡D6öçFVçBÒG·vVVµ7FG2çF÷FÇÒ‹=ŠÍ˜F°¢–b†VÂæVF—DÖöçF†Ç”ÖWF’VÂæVF—DÖöçF†Ç”ÖWFçFW‡D6öçFVçBÒG¶ÖöçF…7FG2çF÷FÇÒ‹=ŠÍ˜F°¢–b†VÂæVF—DF–Ç•7FG2’VÂæVF—DF–Ç•7FG2æ–ææW$…DÔÂÒ7FD&Æö6²‡FöF•7FG2“°¢–b†VÂæVF—EvVV¶Ç•7FG2’VÂæVF—EvVV¶Ç•7FG2æ–ææW$…DÔÂÒ7FD&Æö6²‡vVVµ7FG2“°¢–b†VÂæVF—DÖöçF†Ç•7FG2’VÂæVF—DÖöçF†Ç•7FG2æ–ææW$…DÔÂÒ7FD&Æö6²†ÖöçF…7FG2“°¢–b†VÂæVF—DÖöçF„Æöt6÷VçB’VÂæVF—DÖöçF„Æöt6÷VçBçFW‡D6öçFVçBÒG¶ÖöçF„—FV×2æÆVæwF‡Ò‹=ŠÍ˜F°¢–b†VÂæVF—DÖöçF„Æör’°¢VÂæVF—DÖöçF„Æöræ–ææW$…DÔÂÒÖöçF„—FV×2æÆVæwF€¢òÖöçF„—FV×2æÖ†VF—DÖöçF„Æöt—FVÒ’æ¦ö–â‚""¢¢V×G•7FFR‚-˜MŠrŠ­˜ŠÍŠò‹=ŠÍ˜MŠ}Š¢˜M˜}‹˜rŠ}˜M˜]˜}˜]Š’Ší˜MŠ}˜BŠ}˜M‹M˜}‹Š}˜MŠÝŠ}˜M˜¢"“°¢Ð§Ð ¦gVæ7F–öâVF—D÷F–öäÖF6†W2†÷F–öâÂ—FVÒ’°¢–b‚÷F–öâÇÂ—FVÒ’&WGW&âfÇ6S°¢–b†÷F–öâçF6´–B’°¢–b†—FVÒçF6´–BÓÓÒ÷F–öâçF6´–B’&WGW&âG'VS°¢&WGW&âvWEF6²†—FVÒçF6´–B’bbVF—EF6´¶W’†—FVÒçF—FÆR’ÓÓÒ÷F–öâçF—FÆT¶W“°¢Ð¢–b†÷F–öâæ÷'†åF6´–B’&WGW&â—FVÒçF6´–BÓÓÒ÷F–öâæ÷'†åF6´–C°¢&WGW&âvWEF6²†—FVÒçF6´–B’bbVF—EF6´¶W’†—FVÒçF—FÆR’ÓÓÒ÷F–öâçF—FÆT¶W“°§Ð ¦gVæ7F–öâVF—DÖöçF„Æöt—FVÒ†—FVÒ’°¢6öç7B6ö×ÆWFVBÒ—FVÒç7FGW2ÓÓÒ&6ö×ÆWFVB#°¢&WGW&â ¢ÆF—b6Æ73Ò&†—7F÷'’Ö—FVÒVF—BÖÆörÖ—FVÒ#à¢ÆF—cà¢Ç7G&öæsâG¶f÷&ÖDFFR†—FVÒæFFR—ÓÂ÷7G&öæsà¢Ç6ÖÆÃâG·7FGW5FW‡B†—FVÒç7FGW2—ÓÂ÷6ÖÆÃà¢ÂöF—cà¢Ç7â6Æ73Ò'–ÆÂG¶6ö×ÆWFVBò&w&VVâ"¢&Ö&W"'Ò#âG¶6ö×ÆWFVBò-Š­˜RŠ}˜MŠ­˜m˜˜­‹"¢-˜M˜R˜­Š­˜RŠ}˜MŠ­˜m˜˜­‹'ÓÂ÷7ãà¢ÂöF—cà¢°§Ð ¦gVæ7F–öâ&VæFW$VF—DÆÅ7VÖÖ'’‚’°¢–b†VÂæVF—E6–ævÆU7VÖÖ'’’VÂæVF—E6–ævÆU7VÖÖ'’æ–ææW$…DÔÂÒ"#°¢–b†VÂæVF—E6–ævÆU7FG2’VÂæVF—E6–ævÆU7FG2æ6Æ74Æ—7BæFB‚&†–FFVâ"“°¢–b‚VÂæVF—DÆÅ7VÖÖ'’’&WGW&ã° ¢6öç7B7VÖÖ&–W2ÒVF—DÖöçF†Ç•F6µ7VÖÖ&–W2‚“°¢VÂæVF—DÆÅ7VÖÖ'’æ6Æ74Æ—7Bç&VÖ÷fR‚&†–FFVâ"“°¢VÂæVF—DÆÅ7VÖÖ'’æ–ææW$…DÔÂÒ7VÖÖ&–W2æÆVæwF€¢ò ¢ÆF—b6Æ73Ò'6V7F–öâÖ†VB#à¢Æƒ3í˜]˜MŠí‹RŠ}˜M˜=˜CÂöƒ3à¢Ç7ãâG·7VÖÖ&–W2æÆVæwF‡Ò˜]˜}˜]Š“Â÷7ãà¢ÂöF—cà¢ÆF—b6Æ73Ò&VF—B×7VÖÖ'’ÖÆ—7B#à¢G·7VÖÖ&–W2æÖ†VF—E7VÖÖ'”—FVÒ’æ¦ö–â‚""—Ð¢ÂöF—cà¢ ¢¢V×G•7FFR‚-˜MŠrŠ­˜ŠÍŠò˜]˜}Š}˜R˜M˜}Šr‹=ŠÍ˜MŠ}Š¢˜˜¢Š}˜M‹M˜}‹Š}˜MŠÝŠ}˜M˜¢"“°§Ð ¦gVæ7F–öâVF—DÖöçF†Ç•F6µ7VÖÖ&–W2‚’°¢6öç7BFöF’ÒFöF”•4ò‚“°¢6öç7BÖöçF…7F'BÒ7F'DödÖöçF‚‡FöF’“°¢6öç7Bw&÷W2ÒæWrÖ‚“°¢7FDVÆ–v–&ÆT–ç7Fæ6W2‚’æf÷$V6‚‚†—FVÒ’Óâ°¢–b‚—FVÒæFFRÇÂ—FVÒæFFRÂÖöçF…7F'BÇÂ—FVÒæFFRâFöF’’&WGW&ã°¢6öç7BF6²ÒvWEF6²†—FVÒçF6´–B“°¢6öç7BF—FÆRÒF6³òçF—FÆRÇÂ—FVÒçF—FÆRÇÂ-˜]˜}˜]Š’ŠŠý˜˜bŠ}‹=˜R#°¢6öç7B¶W’ÒF6²òF6³¢G·F6²æ–GÖ¢÷'†ã¢G¶—FVÒçF6´–BÇÂVF—EF6´¶W’‡F—FÆR—Ö°¢–b‚¶W’’&WGW&ã°¢–b‚w&÷W2æ†2†¶W’’’°¢w&÷W2ç6WB†¶W’Â²F—FÆRÂ—FV×3¢µÒÒ“°¢Ð¢6öç7Bw&÷WÒw&÷W2ævWB†¶W’“°¢–b‡F6³òçF—FÆR’w&÷WçF—FÆRÒF6²çF—FÆS°¢w&÷Wæ—FV×2çW6‚†—FVÒ“°¢Ò“° ¢&WGW&â'&’æg&öÒ†w&÷W2çfÇVW2‚’¢æÖ‚‡²F—FÆRÂ—FV×2Ò’Óâ°¢6öç7B7FG2Ò6Æ7VÆFU7FG2†—FV×2“°¢6öç7B²F÷FÂÂ6ö×ÆWFVBÂVæF–ærÂÖ—76VBÒÒ7FG3°¢6öç7B6ö×ÆWFVE&FRÒ7FG2ç&FS°¢6öç7BÖ—76VE&FRÒ7FG2æFV6–FVBòÖF‚æÖ‚ƒÂÒ6ö×ÆWFVE&FR’¢°¢&WGW&â°¢F—FÆRÀ¢F÷FÂÀ¢6ö×ÆWFVBÀ¢VæF–ærÀ¢Ö—76VBÀ¢6ö×ÆWFVE&FRÀ¢Ö—76VE&FRÀ¢Ó°¢Ò¢æf–ÇFW"‚†—FVÒ’Óâ—FVÒçF÷FÂâ¢ç6÷'B‚†Â"’ÓâçF—FÆRæÆö6ÆT6ö×&R†"çF—FÆRÂ&""’“°§Ð ¦gVæ7F–öâVF—EF6´¶W’‡F—FÆR’°¢&WGW&â7G&–ær‡F—FÆRÇÂ""’çG&–Ò‚’ç&WÆ6R‚õÇ2²örÂ""’çFôÆö6ÆTÆ÷vW$66R‚&"Õ4"“°§Ð ¦gVæ7F–öâVF—E7VÖÖ'”—FVÒ†—FVÒ’°¢&WGW&â ¢Æ'F–6ÆR6Æ73Ò&VF—B×7VÖÖ'’Ö—FVÒ#à¢Ç7G&öæsâG¶W66T‡FÖÂ†—FVÒçF—FÆR—ÓÂ÷7G&öæsà¢ÆF—b6Æ73Ò&VF—B×&F–òÖÆ—7B#à¢ÆF—b6Æ73Ò&VF—B×&F–ò×&÷r#à¢Ç7ãíŠ­˜RŠ}˜MŠ­˜m˜˜­‹Â÷7ãà¢Æ#âG¶—FVÒæ6ö×ÆWFVE&FWÒSÂö#à¢ÆVÓâG¶—FVÒæ6ö×ÆWFVGÒ˜]‹Š“ÂöVÓà¢ÂöF—cà¢ÆF—b6Æ73Ò&VF—B×&F–ò×&÷r#à¢Ç7ãí˜M˜R˜­Š­˜RŠ}˜MŠ­˜m˜˜­‹Â÷7ãà¢Æ#âG¶—FVÒæÖ—76VE&FWÒSÂö#à¢ÆVÓâG¶—FVÒæÖ—76VGÒ˜]‹Š“ÂöVÓà¢ÂöF—cà¢G°¢—FVÒçVæF–æp¢òÆF—b6Æ73Ò&VF—B×&F–ò×&÷r#ãÇ7ãí˜-˜­ŠòŠ}˜MŠ}˜mŠ­‹Š}‹Â÷7ããÆ#î(	CÂö#ãÆVÓâG¶—FVÒçVæF–æwÒ˜]‹Š“ÂöVÓãÂöF—cæ ¢¢" ¢Ð¢ÂöF—cà¢Âö'F–6ÆSà¢°§Ð ¦gVæ7F–öâ7FD&Æö6²‡7FG2’°¢&WGW&â ¢G·7FDÆ–æR‚-Š­˜RŠ­˜m˜˜­‹˜}Šr"Â7FG2æ6ö×ÆWFVBÂ7FG2çF÷FÂÂ&w&VVâ"—Ð¢G·7FDÆ–æR‚-˜M˜RŠ­˜m˜‹"Â7FG2æÖ—76VBÂ7FG2çF÷FÂÂ7FG2æÖ—76VBò&Ö&W""¢&w&VVâ"—Ð¢G·7FDÆ–æR‚-˜-˜­ŠòŠ}˜MŠ}˜mŠ­‹Š}‹"Â7FG2çVæF–ærÂ7FG2çF÷FÂÂ&&ÇVR"—Ð¢G·7FDÆ–æR‚-Š}˜M˜m‹=ŠŠ’"Â7FG2ç&FRÂÂ7FG2ç&FRãÒsò&w&VVâ"¢7FG2ç&FRãÒCò&Ö&W""¢'&VB"Â"R"—Ð¢°§Ð Ð¦gVæ7F–öâ–×÷'Fæ6U7FG4&Æö6²‚’°¢&WGW&â³"ÂBÂbÂ‚ÂÐ¢æÖ‚†–×÷'Fæ6R’Óâ°¢6öç7B—FV×2Ò7W'&VçDÖöçF…7FD–ç7Fæ6W2‚’æf–ÇFW"‚†—FVÒ’ÓâçVÖ&W"†—FVÒæ–×÷'Fæ6R’ÓÓÒ–×÷'Fæ6R“°¢6öç7B²&FRÒÒ6Æ7VÆFU7FG2†—FV×2“°¢&WGW&â7FDÆ–æR†G¶–×÷'Fæ6WÒG¶–×÷'Fæ6TÆ&VÇ5¶–×÷'Fæ6U×ÖÂ&FRÂÂ&FRãÒsò&w&VVâ"¢&FRãÒCò&Ö&W""¢'&VB"Â"R"“°¢ÒÐ¢æ¦ö–â‚""“°Ð§ÐÐ Ð¦gVæ7F–öâ&VæFW%7FG56WGF–æw2‚’°¢6öç7B—FV×2Ò7W'&VçDÖöçF…7FD–ç7Fæ6W2‚’ç6÷'B‡6÷'D–ç7Fæ6W2“°¢VÂç7FG56÷W&6T6÷VçBçFW‡D6öçFVçBÒG¶—FV×2æÆVæwF‡Ò‹=ŠÍ˜F°¢VÂç7FG56WGF–æw5FövvÆRçFW‡D6öçFVçBÒ7FG56WGF–æw4÷Vâò-Š]‹­˜MŠ}˜""¢-˜Š­ŠÒ#°Ð¢VÂç7FG56÷W&6TÆ—7Bæ6Æ74Æ—7BçFövvÆR‚&†–FFVâ"Â7FG56WGF–æw4÷Vâ“°Ð¢–b‚7FG56WGF–æw4÷Vâ’&WGW&ã°Ð¢VÂç7FG56÷W&6TÆ—7Bæ–ææW$…DÔÂÒ—FV×2æÆVæwF€Ð¢ò—FV×0Ð¢æÖ‚†—FVÒ’Óâ°Ð¢6öç7BF6²ÒvWEF6²†—FVÒçF6´–B“°Ð¢&WGW&â Ð¢ÆF—b6Æ73Ò&†—7F÷'’Ö—FVÒ#àÐ¢ÆF—càÐ¢Ç7G&öæsâG¶W66T‡FÖÂ†—FVÒçF—FÆR—ÓÂ÷7G&öæsàÐ¢Ç6ÖÆÃâG¶f÷&ÖDFFR†—FVÒæFFR—Ò(
"G·7FGW5FW‡B†—FVÒç7FGW2—Ò(
"G·F6²ò&V7W'&Væ6TÆ&VÂ‡F6²’¢-‹=ŠÍ˜B˜]˜m˜‹]˜B'ÓÂ÷6ÖÆÃàÐ¢ÂöF—càÐ¢ÆF—b6Æ73Ò&'WGFöâ×&÷r6ö×7B#àÐ¢Æ'WGFöâ6Æ73Ò&FævW"Ö'WGFöâ"FFÖ7F–öãÒ&FVÆWFR×7FBÖ–ç7Fæ6R"FFÖ–CÒ"G¶—FVÒæ–GÒ"G—SÒ&'WGFöâ#íŠÝ‹˜˜]˜bŠ}˜MŠ]ŠÝ‹]Š}Šm˜­Š}Š£Âö'WGFöãàÐ¢ÂöF—càÐ¢ÂöF—càÐ¢°Ð¢ÒÐ¢æ¦ö–â‚""Ð¢¢V×G•7FFR‚-˜MŠrŠ­˜ŠÍŠò‹=ŠÍ˜MŠ}Š¢Š­‹Š­˜]Šò‹˜M˜­˜}ŠrŠ}˜MŠ]ŠÝ‹]Š}Šm˜­Š}Š¢"“°Ð§ÐÐ Ð¦gVæ7F–öâ7FDVÆ–v–&ÆT–ç7Fæ6W2‚’°¢6öç7BW†6ÇVFVBÒæWr6WB‡7FFRç6WGF–æw2ç7FG4W†6ÇVFVD–ç7Fæ6T–G2ÇÂµÒ“°¢&WGW&âö&¦V7BçfÇVW2‡7FFRæ–ç7Fæ6W2’æf–ÇFW"‚†—FVÒ’Óâ—FVÒbb—FVÒç7FGW2ÓÒ&FVÆWFVB"bbW†6ÇVFVBæ†2†—FVÒæ–B’“°§Ð ¦gVæ7F–öâ7W'&VçDÖöçF…7FD–ç7Fæ6W2‚’°¢6öç7BFöF’ÒFöF”•4ò‚“°¢6öç7B7F'BÒ7F'DödÖöçF‚‡FöF’“°¢&WGW&â7FDVÆ–v–&ÆT–ç7Fæ6W2‚’æf–ÇFW"‚†—FVÒ’Óâ—FVÒæFFRbb—FVÒæFFRãÒ7F'Bbb—FVÒæFFRÃÒFöF’“°§Ð Ð¦gVæ7F–öâ7FDÆ–æR†Æ&VÂÂfÇVRÂF÷FÂÂFöæRÂ7Vff—‚Ò""’°Ð¢6öç7BFVæöÖ–æF÷"ÒÖF‚æÖ‚ƒÂF÷FÂ“°Ð¢6öç7BW&6VçBÒÖF‚æÖ–âƒÂÖF‚ç&÷VæB‚„çVÖ&W"‡fÇVR’òFVæöÖ–æF÷"’¢’“°Ð¢&WGW&â Ð¢ÆF—b6Æ73Ò'7FBÖÆ–æR#àÐ¢ÆF—b6Æ73Ò'7FB×FW‡B#ãÇ7ãâG¶Æ&VÇÓÂ÷7ããÇ7G&öæsâG·fÇVWÒG·7Vff—‡ÓÂ÷7G&öæsãÂöF—càÐ¢ÆF—b6Æ73Ò&&"G·FöæWÒ#ãÇ7â7G–ÆSÒ'v–GFƒ¢G·W&6VçGÒR#ãÂ÷7ããÂöF—càÐ¢ÂöF—càÐ¢°Ð§ÐÐ Ð¦gVæ7F–öâ&VæFW$FWVæFVæ7”÷F–öç2‚’°Ð¢6öç7B7W'&VçBÒVÂçF6´–BçfÇVS°Ð¢6öç7B6VÆV7FVBÒVÂçF6´FWVæFVæ7’çfÇVS°Ð¢6öç7Bf–Æ&ÆUF6·2Òf–Æ&ÆTFWVæFVæ7•F6·2†7W'&VçB“°Ð¢6öç7B÷F–öç2Ò¶Æ÷F–öâfÇVSÒ"#íŠŠý˜˜b‹Š‹sÂö÷F–öãæÐÐ¢æ6öæ6B€Ð¢f–Æ&ÆUF6·0Ð¢ç6÷'B‡6÷'EF6·2Ð¢æÖ‚‡F6²’ÓâÆ÷F–öâfÇVSÒ"G·F6²æ–GÒ#âG¶W66T‡FÖÂ‡F6²çF—FÆR—ÓÂö÷F–öãæ’ÀÐ¢Ð¢æ¦ö–â‚""“°Ð¢VÂçF6´FWVæFVæ7’æ–ææW$…DÔÂÒ÷F–öç3°Ð¢6öç7B6VÆV7FVD—4f–Æ&ÆRÒf–Æ&ÆUF6·2ç6öÖR‚‡F6²’ÓâF6²æ–BÓÓÒ6VÆV7FVB“°Ð¢VÂçF6´FWVæFVæ7’çfÇVRÒ6VÆV7FVD—4f–Æ&ÆRò6VÆV7FVB¢"#°Ð¢VÂçF6´FWVæFVæ7’æF—6&ÆVBÒf–Æ&ÆUF6·2æÆVæwF‚ÓÓÒ°Ð¢–b†VÂæFWVæFVæ7”†–çB’°Ð¢VÂæFWVæFVæ7”†–çBçFW‡D6öçFVçBÒf–Æ&ÆUF6·2æÆVæwF€Ð¢ò-Š­‹˜}‹˜}˜mŠrŠÍ˜]˜­‹’Š}˜M˜]˜}Š}˜RŠ}˜M˜]Š­Š}ŠÝŠ’˜M˜M‹Š‹râ Ð¢¢-˜MŠrŠ­˜ŠÍŠò˜]˜}Š}˜R˜]Š­Š}ŠÝŠ’˜M˜M‹Š‹rŠÝŠ}˜M˜­Š}˜²â#°Ð¢ÐÐ§ÐÐ Ð¦gVæ7F–öâf–Æ&ÆTFWVæFVæ7•F6·2†7W'&VçEF6´–B’°¢&WGW&â7FFRçF6·2æf–ÇFW"‚‡F6²’Óâ°¢&WGW&â€¢F6²æ–BÓÒ7W'&VçEF6´–Bb`¢F6²æ7F—fRb`¢v÷VÆD7&VFTFWVæFVæ7”7–6ÆR‡7FFRçF6·2Â7W'&VçEF6´–BÂF6²æ–B¢“°¢Ò“°§Ð Ð¦gVæ7F–öâ&VæFW%v–æF÷t6öçG&öÇ2‚’°Ð¢6öç7Bv–æF÷rÒ7FFRç6WGF–æw2æF—7Æ•v–æF÷s°Ð¢VÂçv–æF÷tVæ&ÆVBæ6†V6¶VBÒv–æF÷ræVæ&ÆVC°Ð¢VÂçv–æF÷u7F'BçfÇVRÒv–æF÷rç7F'C°Ð¢VÂçv–æF÷tVæBçfÇVRÒv–æF÷ræVæC°Ð¢VÂçv–æF÷u7FGW2çFW‡D6öçFVçBÒv–æF÷ræVæ&ÆVBòG¶f÷&ÖEF–ÖR‡v–æF÷rç7F'B—ÒÒG¶f÷&ÖEF–ÖR‡v–æF÷ræVæB—Ö¢-Š}˜M˜˜-Š¢Š}˜MŠÝ˜-˜­˜-˜¢#°Ð§ÐÐ Ð¦gVæ7F–öâ&VæFW$–×÷'Fæ6T'WGFöç2‚’°Ð¢VÂæ–×÷'Fæ6T'WGFöç2çVW'•6VÆV7F÷$ÆÂ‚&'WGFöâ"’æf÷$V6‚‚†'WGFöâ’Óâ°Ð¢'WGFöâæ6Æ74Æ—7BçFövvÆR‚&7F—fR"ÂçVÖ&W"†'WGFöâæFF6WBæ–×÷'Fæ6R’ÓÓÒ6VÆV7FVD–×÷'Fæ6R“°Ð¢Ò“°Ð§ÐÐ Ð¦gVæ7F–öâ7–æ4–çFW'fÅ7FFR‚’°Ð¢6öç7B7W7FöÒÒVÂçF6µ&V7W'&Væ6RçfÇVRÓÓÒ&7W7FöÒ#°Ð¢VÂçF6´–çFW'fÂæF—6&ÆVBÒ7W7FöÓ°Ð¢–b†VÂæ–çFW'fÄ†–çB’°Ð¢VÂæ–çFW'fÄ†–çBçFW‡D6öçFVçBÒ7W7FöÐÐ¢ò-˜}‹ŠrŠ}˜M‹˜-˜R˜}˜‚‹ŠýŠòŠ}˜MŠ=˜­Š}˜RŠ˜­˜b˜=˜B‹˜}˜‹˜M˜M˜]˜}˜]Š’â Ð¢¢-˜­˜Š­ŠÒ˜}‹ŠrŠ}˜MŠí˜­Š}‹˜˜-‹r‹˜mŠòŠ}ŠíŠ­˜­Š}‹Š­˜=‹Š}‹¢˜=˜B‹ŠýŠòŠ=˜­Š}˜Râ#°Ð¢ÐÐ§ÐÐ Ð¦gVæ7F–öâvWD–ç7Fæ6W4'•7FGW2‡7FGW2’°Ð¢&WGW&âö&¦V7BçfÇVW2‡7FFRæ–ç7Fæ6W2Ð¢æf–ÇFW"‚†—FVÒ’Óâ—FVÒç7FGW2ÓÓÒ7FGW2Ð¢ç6÷'B‡6÷'D–ç7Fæ6W2“°Ð§ÐÐ Ð¦gVæ7F–öâvWEF6²†–B’°Ð¢&WGW&â7FFRçF6·2æf–æB‚‡F6²’ÓâF6²æ–BÓÓÒ–B“°Ð§ÐÐ Ð¦gVæ7F–öâ6÷'EF6·2†Â"’°Ð¢&WGW&âçF–ÖRæÆö6ÆT6ö×&R†"çF–ÖR’ÇÂçF—FÆRæÆö6ÆT6ö×&R†"çF—FÆRÂ&""“°Ð§ÐÐ Ð¦gVæ7F–öâ6÷'D–ç7Fæ6W2†Â"’°Ð¢6öç7BF–ÖTÒvWD–ç7Fæ6UF–ÖW2†’æF—7Æ•7F'C°Ð¢6öç7BF–ÖT"ÒvWD–ç7Fæ6UF–ÖW2†"’æF—7Æ•7F'C°Ð¢&WGW&âæFFRæÆö6ÆT6ö×&R†"æFFR’ÇÂF–ÖTæÆö6ÆT6ö×&R‡F–ÖT"’ÇÂçF—FÆRæÆö6ÆT6ö×&R†"çF—FÆRÂ&""“°Ð§ÐÐ Ð¦gVæ7F–öâ&V7W'&Væ6TÆ&VÂ‡F6²’°Ð¢–b‡F6²ç&V7W'&Væ6RÓÓÒ&öæ6R"’&WGW&â-˜]‹Š’˜Š}ŠÝŠýŠ’#°Ð¢–b‡F6²ç&V7W'&Væ6RÓÓÒ&F–Ç’"’&WGW&â-˜=˜B˜­˜˜R#°Ð¢–b‡F6²ç&V7W'&Væ6RÓÓÒ'vVV¶Ç’"’&WGW&â-˜=˜BŠ=‹=Š˜‹’#°Ð¢–b‡F6²ç&V7W'&Væ6RÓÓÒ&ÖöçF†Ç’"’&WGW&â-˜=˜B‹M˜}‹#°Ð¢–b‡F6²ç&V7W'&Væ6RÓÓÒ&7W7FöÒ"’&WGW&â˜=˜BG·F6²æ–çFW'fÄF—7Ò˜­˜˜V°Ð¢&WGW&â"#°Ð§ÐÐ Ð¦gVæ7F–öâÖWG&–2‡fÇVRÂÆ&VÂ’°¢&WGW&âÆF—b6Æ73Ò&ÖWG&–2#ãÇ7G&öæsâG¶W66T‡FÖÂ‡fÇVR—ÓÂ÷7G&öæsãÇ7ãâG¶W66T‡FÖÂ†Æ&VÂ—ÓÂ÷7ããÂöF—cæ°§Ð ¦gVæ7F–öâV×G•7FFR‡FW‡B’°¢&WGW&âÆF—b6Æ73Ò&V×G’#ãÇ7â6Æ73Ò&V×G’Ö–6öâ"&–Ö†–FFVãÒ'G'VR#î)É3Â÷7ããÇâG¶W66T‡FÖÂ‡FW‡B—ÓÂ÷ãÂöF—cæ°§ÐÐ Ð¦gVæ7F–öâ'6U–ÆöB‡FW‡B’°Ð¢&WGW&â¥4ôâç'6R‡FW‡Bç&WÆ6R‚õåÇTdTdbòÂ""’“°Ð§ÐÐ Ð¦gVæ7F–öâF÷væÆöEFW‡B†f–ÆVæÖRÂFW‡B’°Ð¢F÷væÆöD&Æö"†f–ÆVæÖRÂFW‡BÂ'FW‡B÷Æ–ã¶6†'6WC×WFbÓ‚"“°Ð§ÐÐ Ð¦gVæ7F–öâF÷væÆöD&Æö"†f–ÆVæÖRÂFW‡BÂG—R’°Ð¢6öç7B&Æö"ÒæWr&Æö"…·FW‡EÒÂ²G—S¢'FW‡B÷Æ–ã¶6†'6WC×WFbÓ‚"Ò“°Ð¢6öç7BG—VD&Æö"ÒG—RòæWr&Æö"…·FW‡EÒÂ²G—RÒ’¢&Æö#°Ð¢6öç7BW&ÂÒU$Âæ7&VFTö&¦V7EU$Â‡G—VD&Æö"“°Ð¢6öç7BÆ–æ²ÒFö7VÖVçBæ7&VFTVÆVÖVçB‚&"“°Ð¢Æ–æ²æ‡&VbÒW&Ã°Ð¢Æ–æ²æF÷væÆöBÒf–ÆVæÖS°Ð¢Fö7VÖVçBæ&öG’æVæD6†–ÆB†Æ–æ²“°Ð¢Æ–æ²æ6Æ–6²‚“°Ð¢Æ–æ²ç&VÖ÷fR‚“°Ð¢6WEF–ÖV÷WB‚‚’ÓâU$Âç&Wfö¶Tö&¦V7EU$Â‡W&Â’ÂS“°Ð§ÐÐ Ð¦gVæ7F–öâFö7B†ÖW76vR’°¢VÂçFö7BçFW‡D6öçFVçBÒÖW76vS°Ð¢VÂçFö7Bæ6Æ74Æ—7BæFB‚'6†÷r"“°Ð¢6ÆV%F–ÖV÷WB‡Fö7EF–ÖW"“°Ð¢Fö7EF–ÖW"Ò6WEF–ÖV÷WB‚‚’ÓâVÂçFö7Bæ6Æ74Æ—7Bç&VÖ÷fR‚'6†÷r"’Â#c“°Ð§ÐÐ Ð¦gVæ7F–öâV–B‡&Vf—‚’°¢6öç7B&æFöÒÒvÆö&ÅF†—2æ7'—Fóòç&æFöÕUT”@¢òvÆö&ÅF†—2æ7'—Fòç&æFöÕUT”B‚¢¢G´FFRææ÷r‚’çFõ7G&–ærƒ3b—ÒÒG´ÖF‚ç&æFöÒ‚’çFõ7G&–ærƒ3b’ç6Æ–6Rƒ"Â"—Ö°¢&WGW&âG·&Vf—‡ÒÒG·&æFö×Ö°§ÐÐ Ð¦gVæ7F–öâ–ç7Fæ6T–B‡F6´–BÂFFR’°Ð¢&WGW&âG·F6´–GÓ¢G¶FFWÖ°Ð§ÐÐ Ð¦gVæ7F–öâ6ÆöæR‡fÇVR’°Ð¢&WGW&â¥4ôâç'6R„¥4ôâç7G&–æv–g’‡fÇVR’“°Ð§ÐÐ Ð¦gVæ7F–öâW66T‡FÖÂ‡fÇVR’°Ð¢&WGW&â7G&–ær‡fÇVRÐ¢ç&WÆ6TÆÂ‚"b"Â"f×²"Ð¢ç&WÆ6TÆÂ‚#Â"Â"fÇC²"Ð¢ç&WÆ6TÆÂ‚#â"Â"fwC²"Ð¢ç&WÆ6TÆÂ‚r"rÂ"gV÷C²"Ð¢ç&WÆ6TÆÂ‚"r"Â"b33“²"“°Ð§ÐÐ Ð¦gVæ7F–öâÖ–çWFW4æ÷r†FFRÒæWrFFR‚’’°¢&WGW&âFFRævWD†÷W'2‚’¢c²FFRævWDÖ–çWFW2‚“°Ð§ÐÐ Ð¦gVæ7F–öâf÷&ÖDFFR†FFR’°¢6öç7B'6VBÒ'6TFFR†FFR“°¢–b„çVÖ&W"æ—4æâ‡'6VBævWEF–ÖR‚’’’&WGW&â-Š­Š}‹˜­Šâ‹­˜­‹‹]Š}˜MŠÒ#°¢&WGW&âæWr–çFÂäFFUF–ÖTf÷&ÖB‚&"Õ4×RÖ6Öw&Vv÷'’"Â°¢vVV¶F“¢&Æöær"À¢–V#¢&çVÖW&–2"À¢ÖöçFƒ¢&Æöær"À¢F“¢&çVÖW&–2"ÀÐ¢Ò’æf÷&ÖB‡'6VB“°§ÐÐ Ð¦gVæ7F–öâf÷&ÖEF–ÖR‡F–ÖR’°Ð¢6öç7B¶†÷W'2ÂÖ–çWFW5ÒÒ7G&–ær‡F–ÖR’ç7Æ—B‚#¢"’æÖ„çVÖ&W"“°Ð¢6öç7BFFRÒæWrFFR‚“°Ð¢FFRç6WD†÷W'2††÷W'2ÇÂÂÖ–çWFW2ÇÂÂÂ“°Ð¢&WGW&âæWr–çFÂäFFUF–ÖTf÷&ÖB‚&"Õ4"Â°Ð¢†÷W#¢&çVÖW&–2"ÀÐ¢Ö–çWFS¢#"ÖF–v—B"ÀÐ¢Ò’æf÷&ÖB†FFR“°Ð§ÐÐ Ð¦gVæ7F–öâf÷&ÖD6Æö6²†FFR’°Ð¢&WGW&âæWr–çFÂäFFUF–ÖTf÷&ÖB‚&"Õ4"Â°Ð¢†÷W#¢&çVÖW&–2"ÀÐ¢Ö–çWFS¢#"ÖF–v—B"ÀÐ¢Ò’æf÷&ÖB†FFR“°Ð§ÐÐ Ð¦gVæ7F–öâf÷&ÖDFFUF–ÖR‡fÇVR’°¢6öç7BFFRÒæWrFFR‡fÇVR“°¢–b„çVÖ&W"æ—4æâ†FFRævWEF–ÖR‚’’’&WGW&â-‹­˜­‹˜]ŠÝŠýŠò#°¢&WGW&âæWr–çFÂäFFUF–ÖTf÷&ÖB‚&"Õ4×RÖ6Öw&Vv÷'’"Â°¢–V#¢&çVÖW&–2"À¢ÖöçFƒ¢'6†÷'B"ÀÐ¢F“¢&çVÖW&–2"ÀÐ¢†÷W#¢&çVÖW&–2"ÀÐ¢Ö–çWFS¢#"ÖF–v—B"ÀÐ¢Ò’æf÷&ÖB†FFR“°Ð§ÐÐ Ð¦gVæ7F–öâ7F'DöevVV²†FFR’°Ð¢6öç7B'6VBÒ'6TFFR†FFR“°Ð¢6öç7BF’Ò'6VBævWDF’‚“°Ð¢'6VBç6WDFFR‡'6VBævWDFFR‚’ÒF’“°Ð¢&WGW&âFöF”•4ò‡'6VB“°Ð§ÐÐ Ð¦gVæ7F–öâ7F'DödÖöçF‚†FFR’°Ð¢6öç7B'6VBÒ'6TFFR†FFR“°Ð¢&WGW&âFöF”•4ò†æWrFFR‡'6VBævWDgVÆÅ–V"‚’Â'6VBævWDÖöçF‚‚’Â’“°Ð§ÐÐ Ð¦gVæ7F–öâVæDödÖöçF‚†FFR’°Ð¢6öç7B'6VBÒ'6TFFR†FFR“°Ð¢&WGW&âFöF”•4ò†æWrFFR‡'6VBævWDgVÆÅ–V"‚’Â'6VBævWDÖöçF‚‚’²Â’“°Ð§ÐÐ Ð¦gVæ7F–öâ7F'Döe&Wf–÷W4ÖöçF‚†FFR’°Ð¢6öç7B'6VBÒ'6TFFR†FFR“°Ð¢&WGW&âFöF”•4ò†æWrFFR‡'6VBævWDgVÆÅ–V"‚’Â'6VBævWDÖöçF‚‚’ÒÂ’“°Ð§ÐÐ Ð¦gVæ7F–öâ6ö×&UFW‡B†7W'&VçBÂ&Wf–÷W2’°Ð¢6öç7BF–fbÒ7W'&VçBÒ&Wf–÷W3°Ð¢–b†F–fbâ’&WGW&â²G¶F–fgÒV°Ð¢–b†F–fbÂ’&WGW&âG¶F–fgÒV°Ð¢&WGW&â-ŠŠý˜˜bŠ­‹­˜­˜­‹#°Ð§ÐÐ Ð¦gVæ7F–öâ—4öÆFW%F†äF—2‡fÇVRÂF—2’°Ð¢–b‚fÇVR’&WGW&âfÇ6S°Ð¢6öç7BFFRÒæWrFFR‡fÇVR“°Ð¢&WGW&âFFRææ÷r‚’ÒFFRævWEF–ÖR‚’ãÒF—2¢ƒcC°Ð§ÐÐ Ð¦gVæ7F–öâFVÆWFVDF—4ÆVgB†–ç7Fæ6R’°Ð¢6öç7BfÇVRÒ–ç7Fæ6RæÖ÷fVDBÇÂ–ç7Fæ6RçWFFVDBÇÂæWrFFR‚’çFô•4õ7G&–ær‚“°Ð¢6öç7BVÆ6VBÒÖF‚æfÆö÷"‚„FFRææ÷r‚’ÒæWrFFR‡fÇVR’ævWEF–ÖR‚’’òƒcC“°Ð¢&WGW&âÖF‚æÖ‚ƒÂRÒVÆ6VB“°Ð§ÐÐ