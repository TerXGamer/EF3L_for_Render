const state = {
  csrf: "",
  admin: "",
  view: "overview",
  overview: null,
  accounts: { items: [], total: 0, offset: 0, limit: 20, search: "" },
  audit: { items: [], total: 0, offset: 0, limit: 25 },
  account: null,
  detailTab: "summary",
  items: { type: "tasks", items: [], total: 0, offset: 0, limit: 20, search: "", status: "" },
  timeline: { year: new Date().getFullYear(), month: new Date().getMonth() + 1 },
  databaseAccounts: [],
  databaseSearch: "",
};

const titles = {
  overview: ["لوحة الإدارة", "نظرة عامة"],
  accounts: ["إدارة المستخدمين", "الحسابات"],
  "account-detail": ["تفاصيل المستخدم", "الحساب"],
  database: ["البنية والتخزين", "قاعدة البيانات"],
  audit: ["الحماية والمتابعة", "سجل الإدارة"],
};

const el = Object.fromEntries(
  [
    "loginScreen", "loginForm", "loginUsername", "loginPassword", "loginStatus", "appShell",
    "sidebar", "menuButton", "adminName", "logoutButton", "pageEyebrow", "pageTitle",
    "connectionState", "refreshButton", "overviewMetrics", "storagePercent", "storageBar",
    "storageLabels", "recentAccounts", "recentAudit", "accountSearch", "accountsCount",
    "accountsTable", "accountsPrev", "accountsNext", "accountsPage", "accountBack",
    "accountUsername", "accountDisplayName", "accountEmail", "protectedBadge",
    "accountDetailContent", "databaseDisplayName", "sourceAppLink", "databaseFacts",
    "tablesTable", "databaseAccountCount", "databaseAccountSearch", "databaseUsersList",
    "auditList", "auditCount", "auditPrev", "auditNext", "auditPage",
    "passwordDialog", "passwordForm", "newAccountPassword", "confirmPasswordReset",
    "toggleAccountPassword", "generateAccountPassword", "copyAccountPassword",
    "passwordRevealNote", "toast",
  ].map((id) => [id, document.getElementById(id)]),
);

init();

async function init() {
  bindEvents();
  refreshIcons();
  try {
    const session = await api("/api/session");
    if (session.authenticated) {
      enterDashboard(session);
      await loadOverview();
    }
  } catch {
    showLogin();
  }
  setInterval(() => {
    if (!document.hidden && state.csrf && ["overview", "database"].includes(state.view)) {
      loadOverview(true).catch(() => {});
    }
  }, 15_000);
}

function bindEvents() {
  el.loginForm.addEventListener("submit", handleLogin);
  el.logoutButton.addEventListener("click", logout);
  el.menuButton.addEventListener("click", () => el.sidebar.classList.toggle("open"));
  el.refreshButton.addEventListener("click", refreshCurrentView);
  el.accountBack.addEventListener("click", () => switchView("accounts"));
  document.querySelectorAll(".nav-button").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });
  document.querySelectorAll("[data-view-link]").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.viewLink));
  });
  document.querySelectorAll("[data-detail-tab]").forEach((button) => {
    button.addEventListener("click", () => showDetailTab(button.dataset.detailTab));
  });
  let searchTimer;
  el.accountSearch.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.accounts.search = el.accountSearch.value.trim();
      state.accounts.offset = 0;
      loadAccounts();
    }, 280);
  });
  el.accountsPrev.addEventListener("click", () => pageAccounts(-1));
  el.accountsNext.addEventListener("click", () => pageAccounts(1));
  el.auditPrev.addEventListener("click", () => pageAudit(-1));
  el.auditNext.addEventListener("click", () => pageAudit(1));
  el.accountsTable.addEventListener("click", (event) => {
    const button = event.target.closest("[data-open-account]");
    if (button) openAccount(button.dataset.openAccount);
  });
  el.databaseUsersList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-open-account]");
    if (button) openAccount(button.dataset.openAccount);
  });
  el.databaseAccountSearch.addEventListener("input", () => {
    state.databaseSearch = el.databaseAccountSearch.value.trim().toLocaleLowerCase();
    renderDatabaseUsers();
  });
  el.accountDetailContent.addEventListener("submit", handleDetailSubmit);
  el.accountDetailContent.addEventListener("click", handleDetailClick);
  el.accountDetailContent.addEventListener("input", handleItemFilter);
  el.accountDetailContent.addEventListener("change", handleItemFilter);
  el.passwordForm.addEventListener("submit", handlePasswordDialog);
  el.toggleAccountPassword.addEventListener("click", togglePasswordVisibility);
  el.generateAccountPassword.addEventListener("click", generateAccountPassword);
  el.copyAccountPassword.addEventListener("click", copyAccountPassword);
}

async function handleLogin(event) {
  event.preventDefault();
  el.loginStatus.textContent = "جارٍ التحقق...";
  try {
    const session = await api("/api/auth/login", {
      method: "POST",
      body: {
        username: el.loginUsername.value,
        password: el.loginPassword.value,
      },
      auth: false,
    });
    el.loginPassword.value = "";
    enterDashboard(session);
    await loadOverview();
  } catch (error) {
    el.loginStatus.textContent = error.message;
  }
}

function enterDashboard(session) {
  state.csrf = session.csrfToken;
  state.admin = session.username;
  el.adminName.textContent = session.username;
  el.loginScreen.hidden = true;
  el.appShell.hidden = false;
  el.loginStatus.textContent = "";
}

function showLogin() {
  state.csrf = "";
  el.appShell.hidden = true;
  el.loginScreen.hidden = false;
  setTimeout(() => el.loginUsername.focus(), 0);
}

async function logout() {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch {}
  showLogin();
}

async function switchView(view) {
  state.view = view;
  document.querySelectorAll(".view").forEach((section) => {
    section.classList.toggle("active", section.id === `view-${view}`);
  });
  document.querySelectorAll(".nav-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  const [eyebrow, title] = titles[view] || titles.overview;
  el.pageEyebrow.textContent = eyebrow;
  el.pageTitle.textContent = title;
  el.sidebar.classList.remove("open");
  if (view === "overview" || view === "database") await loadOverview();
  if (view === "database") await loadDatabaseUsers();
  if (view === "accounts") await loadAccounts();
  if (view === "audit") await loadAudit();
}

async function refreshCurrentView() {
  el.refreshButton.disabled = true;
  try {
    if (state.view === "overview" || state.view === "database") await loadOverview();
    if (state.view === "database") await loadDatabaseUsers();
    if (state.view === "accounts") await loadAccounts();
    if (state.view === "audit") await loadAudit();
    if (state.view === "account-detail" && state.account) {
      const tab = state.detailTab;
      await openAccount(state.account.account.username);
      showDetailTab(tab);
    }
    toast("تم تحديث البيانات");
  } finally {
    el.refreshButton.disabled = false;
  }
}

async function loadOverview(silent = false) {
  try {
    const overview = await api("/api/overview");
    state.overview = overview;
    renderOverview();
    renderDatabase();
    el.connectionState.textContent = "متصل";
    el.connectionState.style.color = "";
  } catch (error) {
    el.connectionState.textContent = "تعذر الاتصال";
    el.connectionState.style.color = "var(--red)";
    if (!silent) toast(error.message);
  }
}

function renderOverview() {
  const data = state.overview;
  if (!data) return;
  const metrics = [
    ["users", "الحسابات", formatNumber(data.counts.accounts)],
    ["archive", "المهام المحفوظة", formatNumber(data.counts.taskSettings)],
    ["check-circle-2", "سجلات التنفيذ", formatNumber(data.counts.taskRecords)],
    ["activity", "الجلسات النشطة", formatNumber(data.counts.sessions)],
  ];
  el.overviewMetrics.innerHTML = metrics
    .map(
      ([icon, label, value]) => `
        <article class="metric-card">
          <span class="metric-icon"><i data-lucide="${icon}"></i></span>
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}</strong>
        </article>`,
    )
    .join("");
  const percent = Math.min(100, Math.max(0, data.storage.usedPercent));
  el.storagePercent.textContent = `${percent.toFixed(percent < 1 ? 2 : 1)}% مستخدم`;
  el.storageBar.style.width = `${percent}%`;
  el.storageLabels.innerHTML = `
    <span>المستخدم: <strong>${formatBytes(data.storage.databaseBytes)}</strong></span>
    <span>المتبقي التقديري: <strong>${formatBytes(data.storage.remainingBytes)}</strong></span>
    <span>السعة: <strong>${formatBytes(data.storage.capacityBytes)}</strong></span>
    <span>بيانات المستخدمين النصية: <strong>${formatBytes(data.storage.usersDataBytes)}</strong></span>`;
  el.recentAccounts.innerHTML = data.recentAccounts.length
    ? data.recentAccounts.map(accountCompactRow).join("")
    : empty("لا توجد حسابات");
  el.recentAudit.innerHTML = data.recentAudit.length
    ? data.recentAudit.map(auditCompactRow).join("")
    : empty("لا توجد إجراءات إدارية بعد");
  refreshIcons();
}

async function loadAccounts() {
  const query = new URLSearchParams({
    limit: state.accounts.limit,
    offset: state.accounts.offset,
    search: state.accounts.search,
  });
  const result = await api(`/api/accounts?${query}`);
  Object.assign(state.accounts, result);
  renderAccounts();
}

function renderAccounts() {
  const data = state.accounts;
  el.accountsCount.textContent = `${formatNumber(data.total)} حساب`;
  el.accountsTable.innerHTML = data.items.length
    ? data.items
        .map(
          (account) => `
          <tr>
            <td class="identity">
              <strong>${escapeHtml(account.name || account.username)}</strong>
              <span>${escapeHtml(account.username)} · ${escapeHtml(account.email || "بلا بريد")}</span>
            </td>
            <td>${formatNumber(account.taskSettingsCount)}</td>
            <td>${formatNumber(account.taskRecordsCount)}</td>
            <td>${formatNumber(account.sessionsCount)}</td>
            <td>${formatBytes(account.storageBytes)}</td>
            <td>${formatDate(account.updatedAt)}</td>
            <td><button class="ghost table-action" data-open-account="${escapeAttr(account.username)}" type="button"><i data-lucide="eye"></i><span>فتح</span></button></td>
          </tr>`,
        )
        .join("")
    : `<tr><td colspan="7">${empty("لا توجد نتائج")}</td></tr>`;
  const page = Math.floor(data.offset / data.limit) + 1;
  const pages = Math.max(1, Math.ceil(data.total / data.limit));
  el.accountsPage.textContent = `${page} من ${pages}`;
  el.accountsPrev.disabled = data.offset === 0;
  el.accountsNext.disabled = data.offset + data.limit >= data.total;
  refreshIcons();
}

function pageAccounts(direction) {
  state.accounts.offset = Math.max(0, state.accounts.offset + direction * state.accounts.limit);
  loadAccounts();
}

async function openAccount(username) {
  state.account = await api(`/api/accounts/${encodeURIComponent(username)}`);
  state.detailTab = "summary";
  state.items.offset = 0;
  state.timeline.year = state.account.activity?.years?.[0] || new Date().getFullYear();
  state.timeline.month = new Date().getMonth() + 1;
  el.accountUsername.textContent = `@${state.account.account.username}`;
  el.accountDisplayName.textContent = state.account.account.name || state.account.account.username;
  el.accountEmail.textContent = state.account.account.email || "لا يوجد بريد";
  el.protectedBadge.hidden = !state.account.account.protected;
  await switchView("account-detail");
  showDetailTab("summary");
}

function showDetailTab(tab) {
  state.detailTab = tab;
  document.querySelectorAll("[data-detail-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.detailTab === tab);
  });
  if (tab === "summary") renderAccountSummary();
  if (tab === "timeline") {
    state.items.type = "records";
    state.items.offset = 0;
    state.items.search = "";
    state.items.status = "";
    loadTimelineItems();
  }
  if (tab === "tasks" || tab === "records") {
    state.items.type = tab;
    state.items.offset = 0;
    state.items.search = "";
    state.items.status = "";
    loadAccountItems();
  }
  if (tab === "raw") renderRawSection("account");
}

function renderAccountSummary() {
  const { account, counts, sessions, activity, storageBreakdown } = state.account;
  el.accountDetailContent.innerHTML = `
    <div class="detail-grid">
      ${fact("الحجم التقريبي", formatBytes(account.storageBytes))}
      ${fact("المهام المحفوظة", formatNumber(counts.taskSettingsCount))}
      ${fact("سجلات التنفيذ", formatNumber(counts.taskRecordsCount))}
      ${fact("المكتملة", formatNumber(counts.completedCount))}
      ${fact("الجلسات", formatNumber(sessions.length))}
      ${fact("آخر تحديث", formatDate(account.updatedAt))}
      ${fact("حجم المهام", formatBytes(storageBreakdown?.tasks))}
      ${fact("حجم سجل التنفيذ", formatBytes(storageBreakdown?.records))}
      ${fact("الإعدادات", formatBytes(storageBreakdown?.settings))}
    </div>
    <div class="day-overview">
      ${dayActivityCard("مهام اليوم", activity?.today)}
      ${dayActivityCard("مهام أمس", activity?.yesterday)}
    </div>
    <div class="control-layout">
      <form class="control-section" id="profileForm">
        <h3>بيانات الحساب</h3>
        <label class="field"><span>اسم المستخدم</span><input name="username" maxlength="50" value="${escapeAttr(account.username)}" ${account.protected ? "disabled" : ""} required /></label>
        <label class="field"><span>الاسم</span><input name="name" maxlength="80" value="${escapeAttr(account.name || "")}" required /></label>
        <label class="field"><span>البريد</span><input name="email" type="email" maxlength="120" value="${escapeAttr(account.email || "")}" required /></label>
        <button class="primary" type="submit">حفظ البيانات</button>
      </form>
      <section class="control-section">
        <h3>الأمان والتحكم</h3>
        <div class="control-actions">
          <button class="ghost" data-action="reset-password" type="button"><i data-lucide="key"></i><span>تغيير كلمة المرور</span></button>
          <button class="ghost" data-action="revoke-sessions" type="button"><i data-lucide="log-out"></i><span>إغلاق الجلسات</span></button>
          <button class="ghost" data-action="export-account" type="button"><i data-lucide="download"></i><span>تصدير JSON</span></button>
          <button class="danger" data-action="delete-account" type="button" ${account.protected ? "disabled" : ""}><i data-lucide="trash-2"></i><span>حذف الحساب</span></button>
        </div>
        <p>${account.protected ? "الحساب محمي من الحذف." : "الحذف يزيل الحساب وجلساته وبياناته نهائيًا."}</p>
      </section>
    </div>`;
  refreshIcons();
}

function dayActivityCard(title, day) {
  const items = day?.items || [];
  return `<section class="day-card">
    <div><span>${escapeHtml(day?.date || "")}</span><h3>${title}</h3></div>
    <strong>${formatNumber(day?.completed || 0)} من ${formatNumber(day?.total || 0)} مكتملة</strong>
    <div class="day-task-list">${items.length
      ? items.map((item) => `<span>${escapeHtml(item.title || "مهمة")} · ${escapeHtml(statusLabel(item.status))}</span>`).join("")
      : "<span>لا توجد مهام</span>"}</div>
  </section>`;
}

async function loadAccountItems() {
  const username = state.account.account.username;
  const query = new URLSearchParams({
    type: state.items.type,
    limit: state.items.limit,
    offset: state.items.offset,
    search: state.items.search,
    status: state.items.status,
  });
  const result = await api(`/api/accounts/${encodeURIComponent(username)}/items?${query}`);
  Object.assign(state.items, result);
  renderAccountItems();
}

async function loadTimelineItems() {
  const username = state.account.account.username;
  const query = new URLSearchParams({
    type: "records",
    limit: state.items.limit,
    offset: state.items.offset,
    year: state.timeline.year,
    month: state.timeline.month,
  });
  const result = await api(`/api/accounts/${encodeURIComponent(username)}/items?${query}`);
  Object.assign(state.items, result);
  renderTimeline();
}

function renderTimeline() {
  const activity = state.account.activity || {};
  const years = activity.years?.length ? activity.years : [new Date().getFullYear()];
  const months = activity.byYear?.[state.timeline.year] || [];
  const grouped = state.items.items.reduce((map, item) => {
    const date = item.date || "بلا تاريخ";
    if (!map[date]) map[date] = [];
    map[date].push(item);
    return map;
  }, {});
  el.accountDetailContent.innerHTML = `
    <div class="timeline-toolbar">
      <label class="field compact-field"><span>السنة</span>
        <select id="timelineYear">${years.map((year) =>
          `<option value="${year}" ${Number(year) === Number(state.timeline.year) ? "selected" : ""}>${year}</option>`).join("")}</select>
      </label>
      <span>${formatNumber(state.items.total)} سجل في ${monthName(state.timeline.month)} ${state.timeline.year}</span>
    </div>
    <div class="month-grid">${Array.from({ length: 12 }, (_, index) => {
      const month = index + 1;
      const summary = months.find((item) => Number(item.month) === month) || { total: 0, completed: 0 };
      return `<button class="month-button ${month === Number(state.timeline.month) ? "active" : ""}" data-month="${month}" type="button">
        <strong>${monthName(month)}</strong><span>${formatNumber(summary.total)} سجل</span><small>${formatNumber(summary.completed)} مكتملة</small>
      </button>`;
    }).join("")}</div>
    <div class="timeline-days">${Object.keys(grouped).length
      ? Object.entries(grouped).map(([date, items]) => `<section class="timeline-day">
          <header><strong>${formatDayDate(date)}</strong><span>${formatNumber(items.length)} مهمة</span></header>
          <div class="item-list">${items.map((item) => itemRow(item, true)).join("")}</div>
        </section>`).join("")
      : empty("لا توجد سجلات في هذا الشهر")}</div>
    ${itemsPagination()}`;
  refreshIcons();
}

function itemsPagination() {
  return `<div class="pagination">
    <button class="ghost" data-action="items-prev" type="button" ${state.items.offset === 0 ? "disabled" : ""}>السابق</button>
    <span>${Math.floor(state.items.offset / state.items.limit) + 1} من ${Math.max(1, Math.ceil(state.items.total / state.items.limit))}</span>
    <button class="ghost" data-action="items-next" type="button" ${state.items.offset + state.items.limit >= state.items.total ? "disabled" : ""}>التالي</button>
  </div>`;
}

function monthName(month) {
  return new Intl.DateTimeFormat("ar-SA-u-ca-gregory", { month: "long", timeZone: "UTC" })
    .format(new Date(Date.UTC(2026, Number(month) - 1, 1)));
}

function formatDayDate(value) {
  const date = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("ar-SA-u-ca-gregory", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  }).format(date);
}

function renderAccountItems() {
  const records = state.items.type === "records";
  const statusControl = records
    ? `<select id="itemStatus"><option value="">كل الحالات</option>${[
        ["main", "رئيسية"], ["completed", "مكتملة"], ["requiredOverdue", "واجبة متأخرة"],
        ["optionalOverdue", "اختيارية متأخرة"], ["never", "لم تنفذ"], ["deleted", "محذوفة"],
      ].map(([value, label]) => `<option value="${value}" ${state.items.status === value ? "selected" : ""}>${label}</option>`).join("")}</select>`
    : "";
  el.accountDetailContent.innerHTML = `
    <div class="item-toolbar">
      <label class="search-field"><i data-lucide="search"></i><input id="itemSearch" value="${escapeAttr(state.items.search)}" placeholder="ابحث داخل ${records ? "السجلات" : "المهام"}" /></label>
      ${statusControl}
      <span>${formatNumber(state.items.total)} نتيجة</span>
    </div>
    <div class="item-list">
      ${state.items.items.length ? state.items.items.map((item) => itemRow(item, records)).join("") : empty("لا توجد بيانات في هذا القسم")}
    </div>
    <div class="pagination">
      <button class="ghost" data-action="items-prev" type="button" ${state.items.offset === 0 ? "disabled" : ""}>السابق</button>
      <span>${Math.floor(state.items.offset / state.items.limit) + 1} من ${Math.max(1, Math.ceil(state.items.total / state.items.limit))}</span>
      <button class="ghost" data-action="items-next" type="button" ${state.items.offset + state.items.limit >= state.items.total ? "disabled" : ""}>التالي</button>
    </div>`;
  refreshIcons();
}

function itemRow(item, records) {
  const id = String(item.id || "");
  const title = item.title || (records ? `سجل ${item.date || id}` : `مهمة ${id}`);
  const meta = records
    ? `${statusLabel(item.status)} · ${item.date || "بلا تاريخ"}`
    : `${item.recurrence || "بلا تكرار"} · ${formatDate(item.updatedAt || item.createdAt)}`;
  return `
    <details class="item-row">
      <summary><div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(meta)}</span></div><i data-lucide="file"></i></summary>
      <div class="item-body">
        <pre>${escapeHtml(JSON.stringify(item, null, 2))}</pre>
        <label class="field json-field"><span>تعديل بيانات العنصر</span><textarea data-json-editor="${escapeAttr(id)}" rows="10">${escapeHtml(JSON.stringify(item, null, 2))}</textarea></label>
        <button class="primary" data-action="save-item" data-item-id="${escapeAttr(id)}" data-item-type="${records ? "records" : "tasks"}" type="button"><i data-lucide="save"></i><span>حفظ التعديلات</span></button>
        <button class="danger" data-action="delete-item" data-item-id="${escapeAttr(id)}" data-item-type="${records ? "records" : "tasks"}" type="button"><i data-lucide="trash-2"></i><span>حذف هذا ${records ? "السجل" : "المهمة"}</span></button>
      </div>
    </details>`;
}

async function renderRawSection(section) {
  const username = state.account.account.username;
  const result = await api(`/api/accounts/${encodeURIComponent(username)}/raw?section=${encodeURIComponent(section)}`);
  el.accountDetailContent.innerHTML = `
    <div class="raw-controls">
      ${[
        ["account", "عام"], ["user", "المستخدم"], ["settings", "الإعدادات"],
        ["meta", "بيانات الحذف"], ["sync", "المزامنة"], ["summary", "الملخص"],
      ].map(([value, label]) => `<button class="${section === value ? "primary" : "ghost"}" data-raw-section="${value}" type="button">${label}</button>`).join("")}
    </div>
    <section class="data-section">
      <div class="section-heading"><h2>البيانات النصية: ${escapeHtml(result.section)}</h2><span>المهام والسجلات تظهر على دفعات في تبويباتها</span></div>
      <pre>${escapeHtml(JSON.stringify(result.value, null, 2))}</pre>
    </section>`;
}

async function handleDetailSubmit(event) {
  if (event.target.id !== "profileForm") return;
  event.preventDefault();
  const form = new FormData(event.target);
  const currentUsername = state.account.account.username;
  const result = await api(`/api/accounts/${encodeURIComponent(currentUsername)}/profile`, {
    method: "PATCH",
    body: {
      username: form.get("username") || currentUsername,
      name: form.get("name"),
      email: form.get("email"),
    },
  });
  toast("تم تحديث بيانات الحساب");
  await openAccount(result.username || currentUsername);
}

async function handleDetailClick(event) {
  const monthButton = event.target.closest("[data-month]");
  if (monthButton) {
    state.timeline.month = Number(monthButton.dataset.month);
    state.items.offset = 0;
    return loadTimelineItems();
  }
  const rawButton = event.target.closest("[data-raw-section]");
  if (rawButton) return renderRawSection(rawButton.dataset.rawSection);
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const username = state.account.account.username;
  const action = button.dataset.action;
  if (action === "reset-password") {
    el.newAccountPassword.value = "";
    el.newAccountPassword.type = "password";
    el.passwordRevealNote.textContent = "لا يمكن كشف كلمة المرور الحالية لأنها مشفرة. يمكنك تعيين كلمة جديدة وكشفها قبل الحفظ.";
    el.passwordDialog.showModal();
  }
  if (action === "revoke-sessions" && confirm(`تسجيل خروج ${username} من جميع الأجهزة؟`)) {
    await api(`/api/accounts/${encodeURIComponent(username)}/sessions`, { method: "DELETE" });
    toast("تم إغلاق جميع الجلسات");
    await openAccount(username);
  }
  if (action === "export-account") {
    window.location.assign(`/api/accounts/${encodeURIComponent(username)}/export`);
  }
  if (action === "delete-account" && confirm(`حذف حساب ${username} وكل بياناته نهائيًا؟`)) {
    await api(`/api/accounts/${encodeURIComponent(username)}`, { method: "DELETE" });
    toast("تم حذف الحساب");
    await switchView("accounts");
  }
  if (action === "items-prev" || action === "items-next") {
    state.items.offset = Math.max(
      0,
      state.items.offset + (action === "items-next" ? state.items.limit : -state.items.limit),
    );
    await (state.detailTab === "timeline" ? loadTimelineItems() : loadAccountItems());
  }
  if (action === "save-item") {
    const returnTab = state.detailTab;
    const itemId = button.dataset.itemId;
    const type = button.dataset.itemType;
    const editor = el.accountDetailContent.querySelector(`[data-json-editor="${CSS.escape(itemId)}"]`);
    let item;
    try {
      item = JSON.parse(editor?.value || "");
    } catch {
      toast("صيغة JSON غير صالحة");
      return;
    }
    await api(
      `/api/accounts/${encodeURIComponent(username)}/items/${encodeURIComponent(itemId)}?type=${type}`,
      { method: "PATCH", body: { item } },
    );
    toast("تم حفظ التعديلات");
    await openAccount(username);
    showDetailTab(returnTab === "timeline" ? "timeline" : type);
  }
  if (action === "delete-item") {
    const itemId = button.dataset.itemId;
    const type = button.dataset.itemType;
    if (!confirm(`حذف هذا ${type === "records" ? "السجل" : "المهمة"}؟`)) return;
    await api(
      `/api/accounts/${encodeURIComponent(username)}/items/${encodeURIComponent(itemId)}?type=${type}`,
      { method: "DELETE" },
    );
    toast("تم حذف العنصر وحفظ أثر الحذف");
    await (state.detailTab === "timeline" ? loadTimelineItems() : loadAccountItems());
  }
}

let itemFilterTimer;
function handleItemFilter(event) {
  if (event.target.id === "timelineYear") {
    state.timeline.year = Number(event.target.value);
    state.items.offset = 0;
    loadTimelineItems();
    return;
  }
  if (!["itemSearch", "itemStatus"].includes(event.target.id)) return;
  clearTimeout(itemFilterTimer);
  itemFilterTimer = setTimeout(() => {
    state.items.search = document.getElementById("itemSearch")?.value.trim() || "";
    state.items.status = document.getElementById("itemStatus")?.value || "";
    state.items.offset = 0;
    loadAccountItems();
  }, event.target.id === "itemSearch" ? 280 : 0);
}

async function handlePasswordDialog(event) {
  event.preventDefault();
  if (event.submitter?.value === "cancel") {
    el.passwordDialog.close();
    return;
  }
  const password = el.newAccountPassword.value;
  if (password.length < 8) return;
  await api(`/api/accounts/${encodeURIComponent(state.account.account.username)}/password`, {
    method: "POST",
    body: { password },
  });
  el.passwordDialog.close();
  toast("تم تغيير كلمة المرور وإغلاق الجلسات");
  await openAccount(state.account.account.username);
}

function togglePasswordVisibility() {
  const reveal = el.newAccountPassword.type === "password";
  el.newAccountPassword.type = reveal ? "text" : "password";
  el.toggleAccountPassword.innerHTML = `<i data-lucide="${reveal ? "eye-off" : "eye"}"></i>`;
  el.toggleAccountPassword.title = reveal ? "إخفاء كلمة المرور" : "كشف كلمة المرور";
  el.toggleAccountPassword.setAttribute("aria-label", el.toggleAccountPassword.title);
  refreshIcons();
}

function generateAccountPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
  const values = crypto.getRandomValues(new Uint32Array(22));
  el.newAccountPassword.value = Array.from(values, (value) => alphabet[value % alphabet.length]).join("");
  el.newAccountPassword.type = "text";
  el.toggleAccountPassword.innerHTML = '<i data-lucide="eye-off"></i>';
  el.toggleAccountPassword.title = "إخفاء كلمة المرور";
  el.toggleAccountPassword.setAttribute("aria-label", "إخفاء كلمة المرور");
  el.passwordRevealNote.textContent = "تم توليد كلمة مرور قوية. انسخها قبل حفظها لأنها لن تظهر مجددًا.";
  refreshIcons();
  el.newAccountPassword.focus();
}

async function copyAccountPassword() {
  if (!el.newAccountPassword.value) return toast("ولّد أو اكتب كلمة المرور أولًا");
  await navigator.clipboard.writeText(el.newAccountPassword.value);
  toast("تم نسخ كلمة المرور");
}

function renderDatabase() {
  const data = state.overview;
  if (!data) return;
  el.databaseDisplayName.textContent = data.database.displayName;
  el.sourceAppLink.href = data.database.sourceAppUrl;
  el.databaseFacts.innerHTML = [
    ["الاسم الداخلي", data.database.actualName],
    ["المنطقة", data.database.region],
    ["الإصدار", `PostgreSQL ${data.database.version}`],
    ["انتهاء الخطة المجانية", data.database.expiresAt ? formatDate(data.database.expiresAt) : "غير محدد"],
    ["الحجم الحالي", formatBytes(data.storage.databaseBytes)],
    ["المتبقي التقديري", formatBytes(data.storage.remainingBytes)],
    ["بيانات المستخدمين", formatBytes(data.storage.usersDataBytes)],
    ["آخر قراءة", formatDate(data.generatedAt)],
  ].map(([label, value]) => fact(label, value)).join("");
  el.tablesTable.innerHTML = data.tables
    .map((table) => `<tr><td>${escapeHtml(table.name)}</td><td>${formatBytes(table.bytes)}</td><td>${formatNumber(table.rowsEstimate)}</td></tr>`)
    .join("");
}

async function loadDatabaseUsers() {
  const accounts = [];
  let offset = 0;
  let total = 0;
  do {
    const page = await api(`/api/accounts?limit=100&offset=${offset}`);
    accounts.push(...page.items);
    total = page.total;
    offset += page.items.length;
  } while (offset < total && offset < 5000);
  state.databaseAccounts = accounts;
  renderDatabaseUsers();
}

function renderDatabaseUsers() {
  const query = state.databaseSearch;
  const accounts = state.databaseAccounts.filter((account) =>
    !query || `${account.username} ${account.name} ${account.email}`.toLocaleLowerCase().includes(query),
  );
  el.databaseAccountCount.textContent = `${formatNumber(accounts.length)} حساب`;
  el.databaseUsersList.innerHTML = accounts.length
    ? accounts.map((account) => `
      <button class="database-user" data-open-account="${escapeAttr(account.username)}" type="button">
        <span class="account-avatar-small"><i data-lucide="user"></i></span>
        <span><strong>${escapeHtml(account.name || account.username)}</strong><small>@${escapeHtml(account.username)} · ${escapeHtml(account.email || "بلا بريد")}</small></span>
        <span class="database-user-stats"><b>${formatBytes(account.storageBytes)}</b><small>${formatNumber(account.taskRecordsCount)} سجل</small></span>
        <i data-lucide="chevron-left"></i>
      </button>`).join("")
    : empty("لا توجد حسابات مطابقة");
  refreshIcons();
}

async function loadAudit() {
  const query = new URLSearchParams({ limit: state.audit.limit, offset: state.audit.offset });
  const result = await api(`/api/audit?${query}`);
  Object.assign(state.audit, result);
  renderAudit();
}

function renderAudit() {
  el.auditCount.textContent = `${formatNumber(state.audit.total)} إجراء`;
  el.auditList.innerHTML = state.audit.items.length
    ? state.audit.items.map(auditRow).join("")
    : empty("لا توجد إجراءات بعد");
  const page = Math.floor(state.audit.offset / state.audit.limit) + 1;
  const pages = Math.max(1, Math.ceil(state.audit.total / state.audit.limit));
  el.auditPage.textContent = `${page} من ${pages}`;
  el.auditPrev.disabled = state.audit.offset === 0;
  el.auditNext.disabled = state.audit.offset + state.audit.limit >= state.audit.total;
  refreshIcons();
}

function pageAudit(direction) {
  state.audit.offset = Math.max(0, state.audit.offset + direction * state.audit.limit);
  loadAudit();
}

function accountCompactRow(account) {
  return `<div class="compact-row"><div><strong>${escapeHtml(account.name || account.username)}</strong><span>@${escapeHtml(account.username)} · ${escapeHtml(account.email || "بلا بريد")}</span></div><time>${formatDate(account.updatedAt)}</time></div>`;
}

function auditCompactRow(item) {
  return `<div class="compact-row"><div><strong>${escapeHtml(actionLabel(item.action))}</strong><span>${escapeHtml(item.target_username || item.admin_username)}</span></div><time>${formatDate(item.created_at)}</time></div>`;
}

function auditRow(item) {
  return `<article class="audit-row"><span class="audit-icon"><i data-lucide="activity"></i></span><div><p><strong>${escapeHtml(actionLabel(item.action))}</strong> · ${escapeHtml(item.target_username || "عام")}</p><span>بواسطة ${escapeHtml(item.admin_username)} · ${escapeHtml(JSON.stringify(item.details || {}))}</span></div><time>${formatDate(item.created_at)}</time></article>`;
}

function fact(label, value) {
  return `<article class="fact"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value ?? "غير محدد"))}</strong></article>`;
}

function statusLabel(value) {
  return {
    main: "رئيسية", completed: "مكتملة", requiredOverdue: "واجبة متأخرة",
    optionalOverdue: "اختيارية متأخرة", never: "لم تنفذ", deleted: "محذوفة",
  }[value] || value || "بلا حالة";
}

function actionLabel(value) {
  return {
    login: "تسجيل دخول المدير",
    logout: "تسجيل خروج المدير",
    update_profile: "تعديل بيانات الحساب",
    reset_password: "إعادة تعيين كلمة المرور",
    revoke_sessions: "إغلاق جلسات المستخدم",
    delete_task: "حذف مهمة",
    delete_record: "حذف سجل",
    update_task: "تعديل مهمة",
    update_record: "تعديل سجل",
    delete_account: "حذف حساب",
  }[value] || value;
}

async function api(path, options = {}) {
  const headers = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (state.csrf && options.auth !== false && options.method && options.method !== "GET") {
    headers["X-CSRF-Token"] = state.csrf;
  }
  const response = await fetch(path, {
    method: options.method || "GET",
    headers,
    credentials: "same-origin",
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  let body = {};
  try {
    body = await response.json();
  } catch {}
  if (!response.ok) {
    if (response.status === 401 && options.auth !== false) showLogin();
    throw new Error(body.error || "تعذر تنفيذ الطلب");
  }
  return body;
}

function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${value} بايت`;
  const units = ["ك.ب", "م.ب", "ج.ب", "ت.ب"];
  let size = value;
  let unit = "بايت";
  for (const next of units) {
    size /= 1024;
    unit = next;
    if (size < 1024) break;
  }
  return `${size >= 100 ? size.toFixed(0) : size >= 10 ? size.toFixed(1) : size.toFixed(2)} ${unit}`;
}

function formatNumber(value) {
  return new Intl.NumberFormat("ar-SA").format(Number(value) || 0);
}

function formatDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "غير محدد";
  return new Intl.DateTimeFormat("ar-SA", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Riyadh",
  }).format(date);
}

function empty(message) {
  return `<div class="empty">${escapeHtml(message)}</div>`;
}

function toast(message) {
  el.toast.textContent = message;
  el.toast.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.toast.classList.remove("show"), 2600);
}

function refreshIcons() {
  globalThis.lucide?.createIcons();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}
