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
  overview: ["Ù„ÙˆØ­Ø© Ø§Ù„Ø¥Ø¯Ø§Ø±Ø©", "Ù†Ø¸Ø±Ø© Ø¹Ø§Ù…Ø©"],
  accounts: ["Ø¥Ø¯Ø§Ø±Ø© Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù…ÙŠÙ†", "Ø§Ù„Ø­Ø³Ø§Ø¨Ø§Øª"],
  "account-detail": ["ØªÙØ§ØµÙŠÙ„ Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù…", "Ø§Ù„Ø­Ø³Ø§Ø¨"],
  database: ["Ø§Ù„Ø¨Ù†ÙŠØ© ÙˆØ§Ù„ØªØ®Ø²ÙŠÙ†", "Ù‚Ø§Ø¹Ø¯Ø© Ø§Ù„Ø¨ÙŠØ§Ù†Ø§Øª"],
  audit: ["Ø§Ù„Ø­Ù…Ø§ÙŠØ© ÙˆØ§Ù„Ù…ØªØ§Ø¨Ø¹Ø©", "Ø³Ø¬Ù„ Ø§Ù„Ø¥Ø¯Ø§Ø±Ø©"],
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
    "passwordDialog", "passwordForm", "newAccountPassword", "confirmPasswordReset", "toast",
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
}

async function handleLogin(event) {
  event.preventDefault();
  el.loginStatus.textContent = "Ø¬Ø§Ø±Ù Ø§Ù„ØªØ­Ù‚Ù‚...";
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
    toast("ØªÙ… ØªØ­Ø¯ÙŠØ« Ø§Ù„Ø¨ÙŠØ§Ù†Ø§Øª");
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
    el.connectionState.textContent = "Ù…ØªØµÙ„";
    el.connectionState.style.color = "";
  } catch (error) {
    el.connectionState.textContent = "ØªØ¹Ø°Ø± Ø§Ù„Ø§ØªØµØ§Ù„";
    el.connectionState.style.color = "var(--red)";
    if (!silent) toast(error.message);
  }
}

function renderOverview() {
  const data = state.overview;
  if (!data) return;
  const metrics = [
    ["users", "Ø§Ù„Ø­Ø³Ø§Ø¨Ø§Øª", formatNumber(data.counts.accounts)],
    ["archive", "Ø§Ù„Ù…Ù‡Ø§Ù… Ø§Ù„Ù…Ø­ÙÙˆØ¸Ø©", formatNumber(data.counts.taskSettings)],
    ["check-circle-2", "Ø³Ø¬Ù„Ø§Øª Ø§Ù„ØªÙ†ÙÙŠØ°", formatNumber(data.counts.taskRecords)],
    ["activity", "Ø§Ù„Ø¬Ù„Ø³Ø§Øª Ø§Ù„Ù†Ø´Ø·Ø©", formatNumber(data.counts.sessions)],
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
  el.storagePercent.textContent = `${percent.toFixed(percent < 1 ? 2 : 1)}% Ù…Ø³ØªØ®Ø¯Ù…`;
  el.storageBar.style.width = `${percent}%`;
  el.storageLabels.innerHTML = `
    <span>Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù…: <strong>${formatBytes(data.storage.databaseBytes)}</strong></span>
    <span>Ø§Ù„Ù…ØªØ¨Ù‚ÙŠ Ø§Ù„ØªÙ‚Ø¯ÙŠØ±ÙŠ: <strong>${formatBytes(data.storage.remainingBytes)}</strong></span>
    <span>Ø§Ù„Ø³Ø¹Ø©: <strong>${formatBytes(data.storage.capacityBytes)}</strong></span>
    <span>Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù…ÙŠÙ† Ø§Ù„Ù†ØµÙŠØ©: <strong>${formatBytes(data.storage.usersDataBytes)}</strong></span>`;
  el.recentAccounts.innerHTML = data.recentAccounts.length
    ? data.recentAccounts.map(accountCompactRow).join("")
    : empty("Ù„Ø§ ØªÙˆØ¬Ø¯ Ø­Ø³Ø§Ø¨Ø§Øª");
  el.recentAudit.innerHTML = data.recentAudit.length
    ? data.recentAudit.map(auditCompactRow).join("")
    : empty("Ù„Ø§ ØªÙˆØ¬Ø¯ Ø¥Ø¬Ø±Ø§Ø¡Ø§Øª Ø¥Ø¯Ø§Ø±ÙŠØ© Ø¨Ø¹Ø¯");
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
  el.accountsCount.textContent = `${formatNumber(data.total)} Ø­Ø³Ø§Ø¨`;
  el.accountsTable.innerHTML = data.items.length
    ? data.items
        .map(
          (account) => `
          <tr>
            <td class="identity">
              <strong>${escapeHtml(account.name || account.username)}</strong>
              <span>${escapeHtml(account.username)} Â· ${escapeHtml(account.email || "Ø¨Ù„Ø§ Ø¨Ø±ÙŠØ¯")}</span>
            </td>
            <td>${formatNumber(account.taskSettingsCount)}</td>
            <td>${formatNumber(account.taskRecordsCount)}</td>
            <td>${formatNumber(account.sessionsCount)}</td>
            <td>${formatBytes(account.storageBytes)}</td>
            <td>${formatDate(account.updatedAt)}</td>
            <td><button class="ghost table-action" data-open-account="${escapeAttr(account.username)}" type="button"><i data-lucide="eye"></i><span>ÙØªØ­</span></button></td>
          </tr>`,
        )
        .join("")
    : `<tr><td colspan="7">${empty("Ù„Ø§ ØªÙˆØ¬Ø¯ Ù†ØªØ§Ø¦Ø¬")}</td></tr>`;
  const page = Math.floor(data.offset / data.limit) + 1;
  const pages = Math.max(1, Math.ceil(data.total / data.limit));
  el.accountsPage.textContent = `${page} Ù…Ù† ${pages}`;
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
  el.accountEmail.textContent = state.account.account.email || "Ù„Ø§ ÙŠÙˆØ¬Ø¯ Ø¨Ø±ÙŠØ¯";
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
      ${fact("Ø§Ù„Ø­Ø¬Ù… Ø§Ù„ØªÙ‚Ø±ÙŠØ¨ÙŠ", formatBytes(account.storageBytes))}
      ${fact("Ø§Ù„Ù…Ù‡Ø§Ù… Ø§Ù„Ù…Ø­ÙÙˆØ¸Ø©", formatNumber(counts.taskSettingsCount))}
      ${fact("Ø³Ø¬Ù„Ø§Øª Ø§Ù„ØªÙ†ÙÙŠØ°", formatNumber(counts.taskRecordsCount))}
      ${fact("Ø§Ù„Ù…ÙƒØªÙ…Ù„Ø©", formatNumber(counts.completedCount))}
      ${fact("Ø§Ù„Ø¬Ù„Ø³Ø§Øª", formatNumber(sessions.length))}
      ${fact("Ø¢Ø®Ø± ØªØ­Ø¯ÙŠØ«", formatDate(account.updatedAt))}
      ${fact("Ø­Ø¬Ù… Ø§Ù„Ù…Ù‡Ø§Ù…", formatBytes(storageBreakdown?.tasks))}
      ${fact("Ø­Ø¬Ù… Ø³Ø¬Ù„ Ø§Ù„ØªÙ†ÙÙŠØ°", formatBytes(storageBreakdown?.records))}
      ${fact("Ø§Ù„Ø¥Ø¹Ø¯Ø§Ø¯Ø§Øª", formatBytes(storageBreakdown?.settings))}
    </div>
    <div class="day-overview">
      ${dayActivityCard("Ù…Ù‡Ø§Ù… Ø§Ù„ÙŠÙˆÙ…", activity?.today)}
      ${dayActivityCard("Ù…Ù‡Ø§Ù… Ø£Ù…Ø³", activity?.yesterday)}
    </div>
    <div class="control-layout">
      <form class="control-section" id="profileForm">
        <h3>Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ø­Ø³Ø§Ø¨</h3>
        <label class="field"><span>Ø§Ø³Ù… Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù…</span><input name="username" maxlength="50" value="${escapeAttr(account.username)}" ${account.protected ? "disabled" : ""} required /></label>
        <label class="field"><span>Ø§Ù„Ø§Ø³Ù…</span><input name="name" maxlength="80" value="${escapeAttr(account.name || "")}" required /></label>
        <label class="field"><span>Ø§Ù„Ø¨Ø±ÙŠØ¯</span><input name="email" type="email" maxlength="120" value="${escapeAttr(account.email || "")}" required /></label>
        <button class="primary" type="submit">Ø­ÙØ¸ Ø§Ù„Ø¨ÙŠØ§Ù†Ø§Øª</button>
      </form>
      <section class="control-section">
        <h3>Ø§Ù„Ø£Ù…Ø§Ù† ÙˆØ§Ù„ØªØ­ÙƒÙ…</h3>
        <div class="control-actions">
          <button class="ghost" data-action="reset-password" type="button"><i data-lucide="key"></i><span>ØªØºÙŠÙŠØ± ÙƒÙ„Ù…Ø© Ø§Ù„Ù…Ø±ÙˆØ±</span></button>
          <button class="ghost" data-action="revoke-sessions" type="button"><i data-lucide="log-out"></i><span>Ø¥ØºÙ„Ø§Ù‚ Ø§Ù„Ø¬Ù„Ø³Ø§Øª</span></button>
          <button class="ghost" data-action="export-account" type="button"><i data-lucide="download"></i><span>ØªØµØ¯ÙŠØ± JSON</span></button>
          <button class="danger" data-action="delete-account" type="button" ${account.protected ? "disabled" : ""}><i data-lucide="trash-2"></i><span>Ø­Ø°Ù Ø§Ù„Ø­Ø³Ø§Ø¨</span></button>
        </div>
        <p>${account.protected ? "Ø§Ù„Ø­Ø³Ø§Ø¨ Ù…Ø­Ù…ÙŠ Ù…Ù† Ø§Ù„ÛMµ¶‰žËkºwµçxô‰¥Ñ•µÌµ¹•áÐˆÑåÁ”ô‰‰ÕÑÑ½¸ˆ€‘íÍÑ…Ñ”¹¥Ñ•µÌ¹½™™Í•Ð€¬ÍÑ…Ñ”¹¥Ñ•µÌ¹±¥µ¥Ð€øôÍÑ…Ñ”¹¥Ñ•µÌ¹Ñ½Ñ…°€ü€‰‘¥Í…‰±•ˆ€è€ˆ‰ôûbŸfb«bŸff(ð½‰ÕÑÑ½¸ø(€€€€ð½‘¥Øù€ì(€É•™É•Í¡%½¹Ì ¤ì)ô()™Õ¹Ñ¥½¸¥Ñ•µI½Ü¡¥Ñ•´°É•½É‘Ì¤ì(€½¹ÍÐ¥€ôMÑÉ¥¹œ¡¥Ñ•´¹¥ñð€ˆˆ¤ì(€½¹ÍÐÑ¥Ñ±”€ô¥Ñ•´¹Ñ¥Ñ±”ñð€¡É•½É‘Ì€üƒbÏb³f€‘í¥Ñ•´¹‘…Ñ”ñð¥‘õ€€èƒfffb¤€‘í¥‘õ€¤ì(€½¹ÍÐµ•Ñ„€ôÉ•½É‘Ì(€€€€ü€‘íÍÑ…ÑÕÍ1…‰•°¡¥Ñ•´¹ÍÑ…ÑÕÌ¥ôƒ
Ü€‘í¥Ñ•´¹‘…Ñ”ñð€‹b£fbœƒb«bŸbÇf+b¸‰õ€(€€€€è€‘í¥Ñ•´¹É•ÕÉÉ•¹”ñð€‹b£fbœƒb«fbÇbŸbÄ‰ôƒ
Ü€‘í™½Éµ…Ñ…Ñ”¡¥Ñ•´¹ÕÁ‘…Ñ•‘Ðñð¥Ñ•´¹É•…Ñ•‘Ð¥õ€ì(€É•ÑÕÉ¸€(€€€€ñ‘•Ñ…¥±Ì±…ÍÌô‰¥Ñ•´µÉ½Üˆø(€€€€€€ñÍÕµµ…Éäøñ‘¥ØøñÍÑÉ½¹œø‘í•Í…Á•!Ñµ°¡Ñ¥Ñ±”¥ôð½ÍÑÉ½¹œøñÍÁ…¸ø‘í•Í…Á•!Ñµ°¡µ•Ñ„¥ôð½ÍÁ…¸øð½‘¥Øøñ¤‘…Ñ„µ±Õ¥‘”ô‰™¥±”ˆøð½¤øð½ÍÕµµ…Éäø(€€€€€€ñ‘¥Ø±…ÍÌô‰¥Ñ•´µ‰½‘äˆø(€€€€€€€€ñÁÉ”ø‘í•Í…Á•!Ñµ°¡)M=8¹ÍÑÉ¥¹¥™ä¡¥Ñ•´°¹Õ±°°€È¤¥ôð½ÁÉ”ø(€€€€€€€€ñ±…‰•°±…ÍÌô‰™¥•±©Í½¸µ™¥•±ˆøñÍÁ…¸ûb«bçb¿f+fƒb£f+bŸfbŸb¨ƒbŸfbçfb×bÄð½ÍÁ…¸øñÑ•áÑ…É•„‘…Ñ„µ©Í½¸µ•‘¥Ñ½Èôˆ‘í•Í…Á•ÑÑÈ¡¥¥ôˆÉ½ÝÌôˆÄÀˆø‘í•Í…Á•!Ñµ°¡)M=8¹ÍÑÉ¥¹¥™ä¡¥Ñ•´°¹Õ±°°€È¤¥ôð½Ñ•áÑ…É•„øð½±…‰•°ø(€€€€€€€€ñ‰ÕÑÑ½¸±…ÍÌô‰ÁÉ¥µ…Éäˆ‘…Ñ„µ…Ñ¥½¸ô‰Í…Ù”µ¥Ñ•´ˆ‘…Ñ„µ¥Ñ•´µ¥ôˆ‘í•Í…Á•ÑÑÈ¡¥¥ôˆ‘…Ñ„µ¥Ñ•´µÑåÁ”ôˆ‘íÉ•½É‘Ì€ü€‰É•½É‘Ìˆ€è€‰Ñ…Í­Ì‰ôˆÑåÁ”ô‰‰ÕÑÑ½¸ˆøñ¤‘…Ñ„µ±Õ¥‘”ô‰Í…Ù”ˆøð½¤øñÍÁ…¸ûb·fbàƒbŸfb«bçb¿f+fbŸb¨ð½ÍÁ…¸øð½‰ÕÑÑ½¸ø(€€€€€€€€ñ‰ÕÑÑ½¸±…ÍÌô‰‘…¹•Èˆ‘…Ñ„µ…Ñ¥½¸ô‰‘•±•Ñ”µ¥Ñ•´ˆ‘…Ñ„µ¥Ñ•´µ¥ôˆ‘í•Í…Á•ÑÑÈ¡¥¥ôˆ‘…Ñ„µ¥Ñ•´µÑåÁ”ôˆ‘íÉ•½É‘Ì€ü€‰É•½É‘Ìˆ€è€‰Ñ…Í­Ì‰ôˆÑåÁ”ô‰‰ÕÑÑ½¸ˆøñ¤‘…Ñ„µ±Õ¥‘”ô‰ÑÉ…Í ´Èˆøð½¤øñÍÁ…¸ûb·bÃfƒfbÃbœ€‘íÉ•½É‘Ì€ü€‹bŸfbÏb³fˆ€è€‹bŸffffb¤‰ôð½ÍÁ…¸øð½‰ÕÑÑ½¸ø(€€€€€€ð½‘¥Øø(€€€€ð½‘•Ñ…¥±Ìù€ì)ô()…Íå¹Œ™Õ¹Ñ¥½¸É•¹‘•ÉI…ÝM•Ñ¥½¸¡Í•Ñ¥½¸¤ì(€½¹ÍÐÕÍ•É¹…µ”€ôÍÑ…Ñ”¹…½Õ¹Ð¹…½Õ¹Ð¹ÕÍ•É¹…µ”ì(€½¹ÍÐÉ•ÍÕ±Ð€ô…Ý…¥Ð…Á¤¡€½…Á¤½…½Õ¹ÑÌ¼‘í•¹½‘•UI%½µÁ½¹•¹Ð¡ÕÍ•É¹…µ”¥ô½É…ÜýÍ•Ñ¥½¸ô‘í•¹½‘•UI%½µÁ½¹•¹Ð¡Í•Ñ¥½¸¥õ€¤ì(€•°¹…½Õ¹Ñ•Ñ…¥±½¹Ñ•¹Ð¹¥¹¹•É!Q50€ô€(€€€€ñ‘¥Ø±…ÍÌô‰É…Üµ½¹ÑÉ½±Ìˆø(€€€€€€‘íl(€€€€€€€l‰…½Õ¹Ðˆ°€‹bçbŸf‰t°l‰ÕÍ•Èˆ°€‹bŸffbÏb«b»b¿f‰t°l‰Í•ÑÑ¥¹Ìˆ°€‹bŸfb—bçb¿bŸb¿bŸb¨‰t°(€€€€€€€l‰µ•Ñ„ˆ°€‹b£f+bŸfbŸb¨ƒbŸfb·bÃf‰t°l‰Íå¹Œˆ°€‹bŸffbËbŸffb¤‰t°l‰ÍÕµµ…Éäˆ°€‹bŸfffb»bÔ‰t°(€€€€€t¹µ…À ¡mÙ…±Õ”°±…‰•±t¤€ôø€ñ‰ÕÑÑ½¸±…ÍÌôˆ‘íÍ•Ñ¥½¸€ôôôÙ…±Õ”€ü€‰ÁÉ¥µ…Éäˆ€è€‰¡½ÍÐ‰ôˆ‘…Ñ„µÉ…ÜµÍ•Ñ¥½¸ôˆ‘íÙ…±Õ•ôˆÑåÁ”ô‰‰ÕÑÑ½¸ˆø‘í±…‰•±ôð½‰ÕÑÑ½¸ù€¤¹©½¥¸ ˆˆ¥ô(€€€€ð½‘¥Øø(€€€€ñÍ•Ñ¥½¸±…ÍÌô‰‘…Ñ„µÍ•Ñ¥½¸ˆø(€€€€€€ñ‘¥Ø±…ÍÌô‰Í•Ñ¥½¸µ¡•…‘¥¹œˆøñ ÈûbŸfb£f+bŸfbŸb¨ƒbŸffb×f+b¤è€‘í•Í…Á•!Ñµ°¡É•ÍÕ±Ð¹Í•Ñ¥½¸¥ôð½ ÈøñÍÁ…¸ûbŸfffbŸfƒf#bŸfbÏb³fbŸb¨ƒb«bãfbÄƒbçff$ƒb¿fbçbŸb¨ƒff(ƒb«b£f#f+b£bŸb«fbœð½ÍÁ…¸øð½‘¥Øø(€€€€€€ñÁÉ”ø‘í•Í…Á•!Ñµ°¡)M=8¹ÍÑÉ¥¹¥™ä¡É•ÍÕ±Ð¹Ù…±Õ”°¹Õ±°°€È¤¥ôð½ÁÉ”ø(€€€€ð½Í•Ñ¥½¸ù€ì)ô()…Íå¹Œ™Õ¹Ñ¥½¸¡…¹‘±••Ñ…¥±MÕ‰µ¥Ð¡•Ù•¹Ð¤ì(€¥˜€¡•Ù•¹Ð¹Ñ…É•Ð¹¥€„ôô€‰ÁÉ½™¥±•½É´ˆ¤É•ÑÕÉ¸ì(€•Ù•¹Ð¹ÁÉ•Ù•¹Ñ•™…Õ±Ð ¤ì(€½¹ÍÐ™½É´€ô¹•Ü½Éµ…Ñ„¡•Ù•¹Ð¹Ñ…É•Ð¤ì(€½¹ÍÐÕÉÉ•¹ÑUÍ•É¹…µ”€ôÍÑ…Ñ”¹…½Õ¹Ð¹…½Õ¹Ð¹ÕÍ•É¹…µ”ì(€½¹ÍÐÉ•ÍÕ±Ð€ô…Ý…¥Ð…Á¤¡€½…Á¤½…½Õ¹ÑÌ¼‘í•¹½‘•UI%½µÁ½¹•¹Ð¡ÕÉÉ•¹ÑUÍ•É¹…µ”¥ô½ÁÉ½™¥±•€°ì(€€€µ•Ñ¡½è€‰AQ ˆ°(€€€‰½‘äèì(€€€€€ÕÍ•É¹…µ”è™½É´¹•Ð ‰ÕÍ•É¹…µ”ˆ¤ñðÕÉÉ•¹ÑUÍ•É¹…µ”°(€€€€€¹…µ”è™½É´¹•Ð ‰¹…µ”ˆ¤°(€€€€€•µ…¥°è™½É´¹•Ð ‰•µ…¥°ˆ¤°(€€€ô°(€ô¤ì(€Ñ½…ÍÐ ‹b«fƒb«b·b¿f+b¬ƒb£f+bŸfbŸb¨ƒbŸfb·bÏbŸb ˆ¤ì(€…Ý…¥Ð½Á•¹½Õ¹Ð¡É•ÍÕ±Ð¹ÕÍ•É¹…µ”ñðÕÉÉ•¹ÑUÍ•É¹…µ”¤ì)ô()…Íå¹Œ™Õ¹Ñ¥½¸¡…¹‘±••Ñ…¥±±¥¬¡•Ù•¹Ð¤ì(€½¹ÍÐµ½¹Ñ¡	ÕÑÑ½¸€ô•Ù•¹Ð¹Ñ…É•Ð¹±½Í•ÍÐ ‰m‘…Ñ„µµ½¹Ñ¡tˆ¤ì(€¥˜€¡µ½¹Ñ¡	ÕÑÑ½¸¤ì(€€€ÍÑ…Ñ”¹Ñ¥µ•±¥¹”¹µ½¹Ñ €ô9Õµ‰•È¡µ½¹Ñ¡	ÕÑÑ½¸¹‘…Ñ…Í•Ð¹µ½¹Ñ ¤ì(€€€ÍÑ…Ñ”¹¥Ñ•µÌ¹½™™Í•Ð€ô€Àì(€€€É•ÑÕÉ¸±½…‘Q¥µ•±¥¹•%Ñ•µÌ ¤ì(€ô(€½¹ÍÐÉ…Ý	ÕÑÑ½¸€ô•Ù•¹Ð¹Ñ…É•Ð¹±½Í•ÍÐ ‰m‘…Ñ„µÉ…ÜµÍ•Ñ¥½¹tˆ¤ì(€¥˜€¡É…Ý	ÕÑÑ½¸¤É•ÑÕÉ¸É•¹‘•ÉI…ÝM•Ñ¥½¸¡É…Ý	ÕÑÑ½¸¹‘…Ñ…Í•Ð¹É…ÝM•Ñ¥½¸¤ì(€½¹ÍÐ‰ÕÑÑ½¸€ô•Ù•¹Ð¹Ñ…É•Ð¹±½Í•ÍÐ ‰m‘…Ñ„µ…Ñ¥½¹tˆ¤ì(€¥˜€ …‰ÕÑÑ½¸¤É•ÑÕÉ¸ì(€½¹ÍÐÕÍ•É¹…µ”€ôÍÑ…Ñ”¹…½Õ¹Ð¹…½Õ¹Ð¹ÕÍ•É¹…µ”ì(€½¹ÍÐ…Ñ¥½¸€ô‰ÕÑÑ½¸¹‘…Ñ…Í•Ð¹…Ñ¥½¸ì(€¥˜€¡…Ñ¥½¸€ôôô€‰É•Í•ÐµÁ…ÍÍÝ½Éˆ¤ì(€€€•°¹¹•Ý½Õ¹ÑA…ÍÍÝ½É¹Ù…±Õ”€ô€ˆˆì(€€€•°¹Á…ÍÍÝ½É‘¥…±½œ¹Í¡½Ý5½‘…° ¤ì(€ô(€¥˜€¡…Ñ¥½¸€ôôô€‰É•Ù½­”µÍ•ÍÍ¥½¹Ìˆ€˜˜½¹™¥É´¡ƒb«bÏb³f+fƒb»bÇf#b°€‘íÕÍ•É¹…µ•ôƒffƒb³ff+bäƒbŸfbb³fbËb§b}€¤¤ì(€€€…Ý…¥Ð…Á¤¡€½…Á¤½…½Õ¹ÑÌ¼‘í•¹½‘•UI%½µÁ½¹•¹Ð¡ÕÍ•É¹…µ”¥ô½Í•ÍÍ¥½¹Í€°ìµ•Ñ¡½è€‰1Qˆô¤ì(€€€Ñ½…ÍÐ ‹b«fƒb—bëfbŸfƒb³ff+bäƒbŸfb³fbÏbŸb¨ˆ¤ì(€€€…Ý…¥Ð½Á•¹½Õ¹Ð¡ÕÍ•É¹…µ”¤ì(€ô(€¥˜€¡…Ñ¥½¸€ôôô€‰•áÁ½ÉÐµ…½Õ¹Ðˆ¤ì(€€€Ý¥¹‘½Ü¹±½…Ñ¥½¸¹…ÍÍ¥¸¡€½…Á¤½…½Õ¹ÑÌ¼‘í•¹½‘•UI%½µÁ½¹•¹Ð¡ÕÍ•É¹…µ”¥ô½•áÁ½ÉÑ€¤ì(€ô(€¥˜€¡…Ñ¥½¸€ôôô€‰‘•±•Ñ”µ…½Õ¹Ðˆ€˜˜½¹™¥É´¡ƒb·bÃfƒb·bÏbŸb €‘íÕÍ•É¹…µ•ôƒf#ffƒb£f+bŸfbŸb«fƒffbŸb›f+f/bŸb}€¤¤ì(€€€…Ý…¥Ð…Á¤¡€½…Á¤½…½Õ¹ÑÌ¼‘í•¹½‘•UI%½µÁ½¹•¹Ð¡ÕÍ•É¹…µ”¥õ€°ìµ•Ñ¡½è€‰1Qˆô¤ì(€€€Ñ½…ÍÐ ‹b«fƒb·bÃfƒbŸfb·bÏbŸb ˆ¤ì(€€€…Ý…¥ÐÍÝ¥Ñ¡Y¥•Ü ‰…½Õ¹ÑÌˆ¤ì(€ô(€¥˜€¡…Ñ¥½¸€ôôô€‰¥Ñ•µÌµÁÉ•Øˆñð…Ñ¥½¸€ôôô€‰¥Ñ•µÌµ¹•áÐˆ¤ì(€€€ÍÑ…Ñ”¹¥Ñ•µÌ¹½™™Í•Ð€ô5…Ñ ¹µ…à (€€€€€€À°(€€€€€ÍÑ…Ñ”¹¥Ñ•µÌ¹½™™Í•Ð€¬€¡…Ñ¥½¸€ôôô€‰¥Ñ•µÌµ¹•áÐˆ€üÍÑ…Ñ”¹¥Ñ•µÌ¹±¥µ¥Ð€è€µÍÑ…Ñ”¹¥Ñ•µÌ¹±¥µ¥Ð¤°(€€€€¤ì(€€€…Ý…¥Ð€¡ÍÑ…Ñ”¹‘•Ñ…¥±Q…ˆ€ôôô€‰Ñ¥µ•±¥¹”ˆ€ü±½…‘Q¥µ•±¥¹•%Ñ•µÌ ¤€è±½…‘½Õ¹Ñ%Ñ•µÌ ¤¤ì(€ô(€¥˜€¡…Ñ¥½¸€ôôô€‰Í…Ù”µ¥Ñ•´ˆ¤ì(€€€½¹ÍÐÉ•ÑÕÉ¹Q…ˆ€ôÍÑ…Ñ”¹‘•Ñ…¥±Q…ˆì(€€€½¹ÍÐ¥Ñ•µ%€ô‰ÕÑÑ½¸¹‘…Ñ…Í•Ð¹¥Ñ•µ%ì(€€€½¹ÍÐÑåÁ”€ô‰ÕÑÑ½¸¹‘…Ñ…Í•Ð¹¥Ñ•µQåÁ”ì(€€€½¹ÍÐ•‘¥Ñ½È€ô•°¹…½Õ¹Ñ•Ñ…¥±½¹Ñ•¹Ð¹ÅÕ•ÉåM•±•Ñ½È¡m‘…Ñ„µ©Í½¸µ•‘¥Ñ½Èôˆ‘íML¹•Í…Á”¡¥Ñ•µ%¥ô‰u€¤ì(€€€±•Ð¥Ñ•´ì(€€€ÑÉäì(€€€€€¥Ñ•´€ô)M=8¹Á…ÉÍ”¡•‘¥Ñ½Èü¹Ù…±Õ”ñð€ˆˆ¤ì(€€€ô…Ñ ì(€€€€€Ñ½…ÍÐ ‹b×f+bëb¤)M=8ƒbëf+bÄƒb×bŸfb·b¤ˆ¤ì(€€€€€É•ÑÕÉ¸ì(€€€ô(€€€…Ý…¥Ð…Á¤ (€€€€€€½…Á¤½…½Õ¹ÑÌ¼‘í•¹½‘•UI%½µÁ½¹•¹Ð¡ÕÍ•É¹…µ”¥ô½¥Ñ•µÌ¼‘í•¹½‘•UI%½µÁ½¹•¹Ð¡¥Ñ•µ%¥ôýÑåÁ”ô‘íÑåÁ•õ€°(€€€€€ìµ•Ñ¡½è€‰AQ ˆ°‰½‘äèì¥Ñ•´ôô°(€€€€¤ì(€€€Ñ½…ÍÐ ‹b«fƒb·fbàƒbŸfb«bçb¿f+fbŸb¨ˆ¤ì(€€€…Ý…¥Ð½Á•¹½Õ¹Ð¡ÕÍ•É¹…µ”¤ì(€€€Í¡½Ý•Ñ…¥±Q…ˆ¡É•ÑÕÉ¹Q…ˆ€ôôô€‰Ñ¥µ•±¥¹”ˆ€ü€‰Ñ¥µ•±¥¹”ˆ€èÑåÁ”¤ì(€ô(€¥˜€¡…Ñ¥½¸€ôôô€‰‘•±•Ñ”µ¥Ñ•´ˆ¤ì(€€€½¹ÍÐ¥Ñ•µ%€ô‰ÕÑÑ½¸¹‘…Ñ…Í•Ð¹¥Ñ•µ%ì(€€€½¹ÍÐÑåÁ”€ô‰ÕÑÑ½¸¹‘…Ñ…Í•Ð¹¥Ñ•µQåÁ”ì(€€€¥˜€ …½¹™¥É´¡ƒb·bÃfƒfbÃbœ€‘íÑåÁ”€ôôô€‰É•½É‘Ìˆ€ü€‹bŸfbÏb³fˆ€è€‹bŸffffb¤‰÷b}€¤¤É•ÑÕÉ¸ì(€€€…Ý…¥Ð…Á¤ (€€€€€€½…Á¤½…½Õ¹ÑÌ¼‘í•¹½‘•UI%½µÁ½¹•¹Ð¡ÕÍ•É¹…µ”¥ô½¥Ñ•µÌ¼‘í•¹½‘•UI%½µÁ½¹•¹Ð¡¥Ñ•µ%¥ôýÑåÁ”ô‘íÑåÁ•õ€°(€€€€€ìµ•Ñ¡½è€‰1Qˆô°(€€€€¤ì(€€€Ñ½…ÍÐ ‹b«fƒb·bÃfƒbŸfbçfb×bÄƒf#b·fbàƒbb¯bÄƒbŸfb·bÃfˆ¤ì(€€€…Ý…¥Ð€¡ÍÑ…Ñ”¹‘•Ñ…¥±Q…ˆ€ôôô€‰Ñ¥µ•±¥¹”ˆ€ü±½…‘Q¥µ•±¥¹•%Ñ•µÌ ¤€è±½…‘½Õ¹Ñ%Ñ•µÌ ¤¤ì(€ô)ô()±•Ð¥Ñ•µ¥±Ñ•ÉQ¥µ•Èì)™Õ¹Ñ¥½¸¡…¹‘±•%Ñ•µ¥±Ñ•È¡•Ù•¹Ð¤ì(€¥˜€¡•Ù•¹Ð¹Ñ…É•Ð¹¥€ôôô€‰Ñ¥µ•±¥¹•e•…Èˆ¤ì(€€€ÍÑ…Ñ”¹Ñ¥µ•±¥¹”¹å•…È€ô9Õµ‰•È¡•Ù•¹Ð¹Ñ…É•Ð¹Ù…±Õ”¤ì(€€€ÍÑ…Ñ”¹¥Ñ•µÌ¹½™™Í•Ð€ô€Àì(€€€±½…‘Q¥µ•±¥¹•%Ñ•µÌ ¤ì(€€€É•ÑÕÉ¸ì(€ô(€¥˜€ …l‰¥Ñ•µM•…É ˆ°€‰¥Ñ•µMÑ…ÑÕÌ‰t¹¥¹±Õ‘•Ì¡•Ù•¹Ð¹Ñ…É•Ð¹¥¤¤É•ÑÕÉ¸ì(€±•…ÉQ¥µ•½ÕÐ¡¥Ñ•µ¥±Ñ•ÉQ¥µ•È¤ì(€¥Ñ•µ¥±Ñ•ÉQ¥µ•È€ôÍ•ÑQ¥µ•½ÕÐ  ¤€ôøì(€€€ÍÑ…Ñ”¹¥Ñ•µÌ¹Í•…É €ô‘½Õµ•¹Ð¹•Ñ±•µ•¹Ñ	å% ‰¥Ñ•µM•…É ˆ¤ü¹Ù…±Õ”¹ÑÉ¥´ ¤ñð€ˆˆì(€€€ÍÑ…Ñ”¹¥Ñ•µÌ¹ÍÑ…ÑÕÌ€ô‘½Õµ•¹Ð¹•Ñ±•µ•¹Ñ	å% ‰¥Ñ•µMÑ…ÑÕÌˆ¤ü¹Ù…±Õ”ñð€ˆˆì(€€€ÍÑ…Ñ”¹¥Ñ•µÌ¹½™™Í•Ð€ô€Àì(€€€±½…‘½Õ¹Ñ%Ñ•µÌ ¤ì(€ô°•Ù•¹Ð¹Ñ…É•Ð¹¥€ôôô€‰¥Ñ•µM•…É ˆ€ü€ÈàÀ€è€À¤ì)ô()…Íå¹Œ™Õ¹Ñ¥½¸¡…¹‘±•A…ÍÍÝ½É‘¥…±½œ¡•Ù•¹Ð¤ì(€•Ù•¹Ð¹ÁÉ•Ù•¹Ñ•™…Õ±Ð ¤ì(€¥˜€¡•Ù•¹Ð¹ÍÕ‰µ¥ÑÑ•Èü¹Ù…±Õ”€ôôô€‰…¹•°ˆ¤ì(€€€•°¹Á…ÍÍÝ½É‘¥…±½œ¹±½Í” ¤ì(€€€É•ÑÕÉ¸ì(€ô(€½¹ÍÐÁ…ÍÍÝ½É€ô•°¹¹•Ý½Õ¹ÑA…ÍÍÝ½É¹Ù…±Õ”ì(€¥˜€¡Á…ÍÍÝ½É¹±•¹Ñ €ð€à¤É•ÑÕÉ¸ì(€…Ý…¥Ð…Á¤¡€½…Á¤½…½Õ¹ÑÌ¼‘í•¹½‘•UI%½µÁ½¹•¹Ð¡ÍÑ…Ñ”¹…½Õ¹Ð¹…½Õ¹Ð¹ÕÍ•É¹…µ”¥ô½Á…ÍÍÝ½É‘€°ì(€€€µ•Ñ¡½è€‰A=MPˆ°(€€€‰½‘äèìÁ…ÍÍÝ½Éô°(€ô¤ì(€•°¹Á…ÍÍÝ½É‘¥…±½œ¹±½Í” ¤ì(€Ñ½…ÍÐ ‹b«fƒb«bëf+f+bÄƒfffb¤ƒbŸffbÇf#bÄƒf#b—bëfbŸfƒbŸfb³fbÏbŸb¨ˆ¤ì(€…Ý…¥Ð½Á•¹½Õ¹Ð¡ÍÑ…Ñ”¹…½Õ¹Ð¹…½Õ¹Ð¹ÕÍ•É¹…µ”¤ì)ô()™Õ¹Ñ¥½¸É•¹‘•É…Ñ…‰…Í” ¤ì(€½¹ÍÐ‘…Ñ„€ôÍÑ…Ñ”¹½Ù•ÉÙ¥•Üì(€¥˜€ …‘…Ñ„¤É•ÑÕÉ¸ì(€•°¹‘…Ñ…‰…Í•¥ÍÁ±…å9…µ”¹Ñ•áÑ½¹Ñ•¹Ð€ô‘…Ñ„¹‘…Ñ…‰…Í”¹‘¥ÍÁ±…å9…µ”ì(€•°¹Í½ÕÉ•ÁÁ1¥¹¬¹¡É•˜€ô‘…Ñ„¹‘…Ñ…‰…Í”¹Í½ÕÉ•ÁÁUÉ°ì(€•°¹‘…Ñ…‰…Í•…ÑÌ¹¥¹¹•É!Q50€ôl(€€€l‹bŸfbŸbÏfƒbŸfb¿bŸb»ff(ˆ°‘…Ñ„¹‘…Ñ…‰…Í”¹…ÑÕ…±9…µ•t°(€€€l‹bŸfffbßfb¤ˆ°‘…Ñ„¹‘…Ñ…‰…Í”¹É•¥½¹t°(€€€l‹bŸfb—b×b¿bŸbÄˆ°A½ÍÑÉ•ME0€‘í‘…Ñ„¹‘…Ñ…‰…Í”¹Ù•ÉÍ¥½¹õt°(€€€l‹bŸfb«fbŸb„ƒbŸfb»bßb¤ƒbŸffb³bŸff+b¤ˆ°‘…Ñ„¹‘…Ñ…‰…Í”¹•áÁ¥É•ÍÐ€ü™½Éµ…Ñ…Ñ”¡‘…Ñ„¹‘…Ñ…‰…Í”¹•áÁ¥É•ÍÐ¤€è€‹bëf+bÄƒfb·b¿b¼‰t°(€€€l‹bŸfb·b³fƒbŸfb·bŸff(ˆ°™½Éµ…Ñ	åÑ•Ì¡‘…Ñ„¹ÍÑ½É…”¹‘…Ñ…‰…Í•	åÑ•Ì¥t°(€€€l‹bŸffb«b£ff(ƒbŸfb«fb¿f+bÇf(ˆ°™½Éµ…Ñ	åÑ•Ì¡‘…Ñ„¹ÍÑ½É…”¹É•µ…¥¹¥¹	åÑ•Ì¥t°(€€€l‹b£f+bŸfbŸb¨ƒbŸffbÏb«b»b¿ff+fˆ°™½Éµ…Ñ	åÑ•Ì¡‘…Ñ„¹ÍÑ½É…”¹ÕÍ•ÉÍ…Ñ…	åÑ•Ì¥t°(€€€l‹b‹b»bÄƒfbÇbŸb‡b¤ˆ°™½Éµ…Ñ…Ñ”¡‘…Ñ„¹•¹•É…Ñ•‘Ð¥t°(€t¹µ…À ¡m±…‰•°°Ù…±Õ•t¤€ôø™…Ð¡±…‰•°°Ù…±Õ”¤¤¹©½¥¸ ˆˆ¤ì(€•°¹Ñ…‰±•ÍQ…‰±”¹¥¹¹•É!Q50€ô‘…Ñ„¹Ñ…‰±•Ì(€€€€¹µ…À ¡Ñ…‰±”¤€ôø€ñÑÈøñÑø‘í•Í…Á•!Ñµ°¡Ñ…‰±”¹¹…µ”¥ôð½ÑøñÑø‘í™½Éµ…Ñ	åÑ•Ì¡Ñ…‰±”¹‰åÑ•Ì¥ôð½ÑøñÑø‘í™½Éµ…Ñ9Õµ‰•È¡Ñ…‰±”¹É½ÝÍÍÑ¥µ…Ñ”¥ôð½Ñøð½ÑÈù€¤(€€€€¹©½¥¸ ˆˆ¤ì)ô()…Íå¹Œ™Õ¹Ñ¥½¸±½…‘…Ñ…‰…Í•UÍ•ÉÌ ¤ì(€½¹ÍÐ…½Õ¹ÑÌ€ômtì(€±•Ð½™™Í•Ð€ô€Àì(€±•ÐÑ½Ñ…°€ô€Àì(€‘¼ì(€€€½¹ÍÐÁ…”€ô…Ý…¥Ð…Á¤¡€½…Á¤½…½Õ¹ÑÌý±¥µ¥ÐôÄÀÀ™½™™Í•Ðô‘í½™™Í•Ñõ€¤ì(€€€…½Õ¹ÑÌ¹ÁÕÍ  ¸¸¹Á…”¹¥Ñ•µÌ¤ì(€€€Ñ½Ñ…°€ôÁ…”¹Ñ½Ñ…°ì(€€€½™™Í•Ð€¬ôÁ…”¹¥Ñ•µÌ¹±•¹Ñ ì(€ôÝ¡¥±”€¡½™™Í•Ð€ðÑ½Ñ…°€˜˜½™™Í•Ð€ð€ÔÀÀÀ¤ì(€ÍÑ…Ñ”¹‘…Ñ…‰…Í•½Õ¹ÑÌ€ô…½Õ¹ÑÌì(€É•¹‘•É…Ñ…‰…Í•UÍ•ÉÌ ¤ì)ô()™Õ¹Ñ¥½¸É•¹‘•É…Ñ…‰…Í•UÍ•ÉÌ ¤ì(€½¹ÍÐÅÕ•Éä€ôÍÑ…Ñ”¹‘…Ñ…‰…Í•M•…É ì(€½¹ÍÐ…½Õ¹ÑÌ€ôÍÑ…Ñ”¹‘…Ñ…‰…Í•½Õ¹ÑÌ¹™¥±Ñ•È ¡…½Õ¹Ð¤€ôø(€€€€…ÅÕ•Éäñð€‘í…½Õ¹Ð¹ÕÍ•É¹…µ•ô€‘í…½Õ¹Ð¹¹…µ•ô€‘í…½Õ¹Ð¹•µ…¥±õ€¹Ñ½1½…±•1½Ý•É…Í” ¤¹¥¹±Õ‘•Ì¡ÅÕ•Éä¤°(€€¤ì(€•°¹‘…Ñ…‰…Í•½Õ¹Ñ½Õ¹Ð¹Ñ•áÑ½¹Ñ•¹Ð€ô€‘í™½Éµ…Ñ9Õµ‰•È¡…½Õ¹ÑÌ¹±•¹Ñ ¥ôƒb·bÏbŸb¡€ì(€•°¹‘…Ñ…‰…Í•UÍ•ÉÍ1¥ÍÐ¹¥¹¹•É!Q50€ô…½Õ¹ÑÌ¹±•¹Ñ (€€€€ü…½Õ¹ÑÌ¹µ…À ¡…½Õ¹Ð¤€ôø€(€€€€€€ñ‰ÕÑÑ½¸±…ÍÌô‰‘…Ñ…‰…Í”µÕÍ•Èˆ‘…Ñ„µ½Á•¸µ…½Õ¹Ðôˆ‘í•Í…Á•ÑÑÈ¡…½Õ¹Ð¹ÕÍ•É¹…µ”¥ôˆÑåÁ”ô‰‰ÕÑÑ½¸ˆø(€€€€€€€€ñÍÁ…¸±…ÍÌô‰…½Õ¹Ðµ…Ù…Ñ…ÈµÍµ…±°ˆøñ¤‘…Ñ„µ±Õ¥‘”ô‰ÕÍ•Èˆøð½¤øð½ÍÁ…¸ø(€€€€€€€€ñÍÁ…¸øñÍÑÉ½¹œø‘í•Í…Á•!Ñµ°¡…½Õ¹Ð¹¹…µ”ñð…½Õ¹Ð¹ÕÍ•É¹…µ”¥ôð½ÍÑÉ½¹œøñÍµ…±°ù ‘í•Í…Á•!Ñµ°¡…½Õ¹Ð¹ÕÍ•É¹…µ”¥ôƒ
Ü€‘í•Í…Á•!Ñµ°¡…½Õ¹Ð¹•µ…¥°ñð€‹b£fbœƒb£bÇf+b¼ˆ¥ôð½Íµ…±°øð½ÍÁ…¸ø(€€€€€€€€ñÍÁ…¸±…ÍÌô‰‘…Ñ…‰…Í”µÕÍ•ÈµÍÑ…ÑÌˆøñˆø‘í™½Éµ…Ñ	åÑ•Ì¡…½Õ¹Ð¹ÍÑ½É…•	åÑ•Ì¥ôð½ˆøñÍµ…±°ø‘í™½Éµ…Ñ9Õµ‰•È¡…½Õ¹Ð¹Ñ…Í­I•½É‘Í½Õ¹Ð¥ôƒbÏb³fð½Íµ…±°øð½ÍÁ…¸ø(€€€€€€€€ñ¤‘…Ñ„µ±Õ¥‘”ô‰¡•ÙÉ½¸µ±•™Ðˆøð½¤ø(€€€€€€ð½‰ÕÑÑ½¸ù€¤¹©½¥¸ ˆˆ¤(€€€€è•µÁÑä ‹fbœƒb«f#b³b¼ƒb·bÏbŸb£bŸb¨ƒfbßbŸb£fb¤ˆ¤ì(€É•™É•Í¡%½¹Ì ¤ì)ô()…Íå¹Œ™Õ¹Ñ¥½¸±½…‘Õ‘¥Ð ¤ì(€½¹ÍÐÅÕ•Éä€ô¹•ÜUI1M•…É¡A…É…µÌ¡ì±¥µ¥ÐèÍÑ…Ñ”¹…Õ‘¥Ð¹±¥µ¥Ð°½™™Í•ÐèÍÑ…Ñ”¹…Õ‘¥Ð¹½™™Í•Ðô¤ì(€½¹ÍÐÉ•ÍÕ±Ð€ô…Ý…¥Ð…Á¤¡€½…Á¤½…Õ‘¥Ðü‘íÅÕ•Éåõ€¤ì(€=‰©•Ð¹…ÍÍ¥¸¡ÍÑ…Ñ”¹…Õ‘¥Ð°É•ÍÕ±Ð¤ì(€É•¹‘•ÉÕ‘¥Ð ¤ì)ô()™Õ¹Ñ¥½¸É•¹‘•ÉÕ‘¥Ð ¤ì(€•°¹…Õ‘¥Ñ½Õ¹Ð¹Ñ•áÑ½¹Ñ•¹Ð€ô€‘í™½Éµ…Ñ9Õµ‰•È¡ÍÑ…Ñ”¹…Õ‘¥Ð¹Ñ½Ñ…°¥ôƒb—b³bÇbŸb…€ì(€•°¹…Õ‘¥Ñ1¥ÍÐ¹¥¹¹•É!Q50€ôÍÑ…Ñ”¹…Õ‘¥Ð¹¥Ñ•µÌ¹±•¹Ñ (€€€€üÍÑ…Ñ”¹…Õ‘¥Ð¹¥Ñ•µÌ¹µ…À¡…Õ‘¥ÑI½Ü¤¹©½¥¸ ˆˆ¤(€€€€è•µÁÑä ‹fbœƒb«f#b³b¼ƒb—b³bÇbŸb‡bŸb¨ƒb£bçb¼ˆ¤ì(€½¹ÍÐÁ…”€ô5…Ñ ¹™±½½È¡ÍÑ…Ñ”¹…Õ‘¥Ð¹½™™Í•Ð€¼ÍÑ…Ñ”¹…Õ‘¥Ð¹±¥µ¥Ð¤€¬€Äì(€½¹ÍÐÁ…•Ì€ô5…Ñ ¹µ…à Ä°5…Ñ ¹•¥°¡ÍÑ…Ñ”¹…Õ‘¥Ð¹Ñ½Ñ…°€¼ÍÑ…Ñ”¹…Õ‘¥Ð¹±¥µ¥Ð¤¤ì(€•°¹…Õ‘¥ÑA…”¹Ñ•áÑ½¹Ñ•¹Ð€ô€‘íÁ…•ôƒff€‘íÁ…•Íõ€ì(€•°¹…Õ‘¥ÑAÉ•Ø¹‘¥Í…‰±•€ôÍÑ…Ñ”¹…Õ‘¥Ð¹½™™Í•Ð€ôôô€Àì(€•°¹…Õ‘¥Ñ9•áÐ¹‘¥Í…‰±•€ôÍÑ…Ñ”¹…Õ‘¥Ð¹½™™Í•Ð€¬ÍÑ…Ñ”¹…Õ‘¥Ð¹±¥µ¥Ð€øôÍÑ…Ñ”¹…Õ‘¥Ð¹Ñ½Ñ…°ì(€É•™É•Í¡%½¹Ì ¤ì)ô()™Õ¹Ñ¥½¸Á…•Õ‘¥Ð¡‘¥É•Ñ¥½¸¤ì(€ÍÑ…Ñ”¹…Õ‘¥Ð¹½™™Í•Ð€ô5…Ñ ¹µ…à À°ÍÑ…Ñ”¹…Õ‘¥Ð¹½™™Í•Ð€¬‘¥É•Ñ¥½¸€¨ÍÑ…Ñ”¹…Õ‘¥Ð¹±¥µ¥Ð¤ì(€±½…‘Õ‘¥Ð ¤ì)ô()™Õ¹Ñ¥½¸…½Õ¹Ñ½µÁ…ÑI½Ü¡…½Õ¹Ð¤ì(€É•ÑÕÉ¸€ñ‘¥Ø±…ÍÌô‰½µÁ…ÐµÉ½Üˆøñ‘¥ØøñÍÑÉ½¹œø‘í•Í…Á•!Ñµ°¡…½Õ¹Ð¹¹…µ”ñð…½Õ¹Ð¹ÕÍ•É¹…µ”¥ôð½ÍÑÉ½¹œøñÍÁ…¸ù ‘í•Í…Á•!Ñµ°¡…½Õ¹Ð¹ÕÍ•É¹…µ”¥ôƒ
Ü€‘í•Í…Á•!Ñµ°¡…½Õ¹Ð¹•µ…¥°ñð€‹b£fbœƒb£bÇf+b¼ˆ¥ôð½ÍÁ…¸øð½‘¥ØøñÑ¥µ”ø‘í™½Éµ…Ñ…Ñ”¡…½Õ¹Ð¹ÕÁ‘…Ñ•‘Ð¥ôð½Ñ¥µ”øð½‘¥Øù€ì)ô()™Õ¹Ñ¥½¸…Õ‘¥Ñ½µÁ…ÑI½Ü¡¥Ñ•´¤ì(€É•ÑÕÉ¸€ñ‘¥Ø±…ÍÌô‰½µÁ…ÐµÉ½Üˆøñ‘¥ØøñÍÑÉ½¹œø‘í•Í…Á•!Ñµ°¡…Ñ¥½¹1…‰•°¡¥Ñ•´¹…Ñ¥½¸¤¥ôð½ÍÑÉ½¹œøñÍÁ…¸ø‘í•Í…Á•!Ñµ°¡¥Ñ•´¹Ñ…É•Ñ}ÕÍ•É¹…µ”ñð¥Ñ•´¹…‘µ¥¹}ÕÍ•É¹…µ”¥ôð½ÍÁ…¸øð½‘¥ØøñÑ¥µ”ø‘í™½Éµ…Ñ…Ñ”¡¥Ñ•´¹É•…Ñ•‘}…Ð¥ôð½Ñ¥µ”øð½‘¥Øù€ì)ô()™Õ¹Ñ¥½¸…Õ‘¥ÑI½Ü¡¥Ñ•´¤ì(€É•ÑÕÉ¸€ñ…ÉÑ¥±”±…ÍÌô‰…Õ‘¥ÐµÉ½ÜˆøñÍÁ…¸±…ÍÌô‰…Õ‘¥Ðµ¥½¸ˆøñ¤‘…Ñ„µ±Õ¥‘”ô‰…Ñ¥Ù¥Ñäˆøð½¤øð½ÍÁ…¸øñ‘¥ØøñÀøñÍÑÉ½¹œø‘í•Í…Á•!Ñµ°¡…Ñ¥½¹1…‰•°¡¥Ñ•´¹…Ñ¥½¸¤¥ôð½ÍÑÉ½¹œøƒ
Ü€‘í•Í…Á•!Ñµ°¡¥Ñ•´¹Ñ…É•Ñ}ÕÍ•É¹…µ”ñð€‹bçbŸfˆ¥ôð½ÀøñÍÁ…¸ûb£f#bŸbÏbßb¤€‘í•Í…Á•!Ñµ°¡¥Ñ•´¹…‘µ¥¹}ÕÍ•É¹…µ”¥ôƒ
Ü€‘í•Í…Á•!Ñµ°¡)M=8¹ÍÑÉ¥¹¥™ä¡¥Ñ•´¹‘•Ñ…¥±Ìñðíô¤¥ôð½ÍÁ…¸øð½‘¥ØøñÑ¥µ”ø‘í™½Éµ…Ñ…Ñ”¡¥Ñ•´¹É•…Ñ•‘}…Ð¥ôð½Ñ¥µ”øð½…ÉÑ¥±”ù€ì)ô()™Õ¹Ñ¥½¸™…Ð¡±…‰•°°Ù…±Õ”¤ì(€É•ÑÕÉ¸€ñ…ÉÑ¥±”±…ÍÌô‰™…ÐˆøñÍÁ…¸ø‘í•Í…Á•!Ñµ°¡±…‰•°¥ôð½ÍÁ…¸øñÍÑÉ½¹œø‘í•Í…Á•!Ñµ°¡MÑÉ¥¹œ¡Ù…±Õ”€üü€‹bëf+bÄƒfb·b¿b¼ˆ¤¥ôð½ÍÑÉ½¹œøð½…ÉÑ¥±”ù€ì)ô()™Õ¹Ñ¥½¸ÍÑ…ÑÕÍ1…‰•°¡Ù…±Õ”¤ì(€É•ÑÕÉ¸ì(€€€µ…¥¸è€‹bÇb›f+bÏf+b¤ˆ°½µÁ±•Ñ•è€‹ffb«ffb¤ˆ°É•ÅÕ¥É•‘=Ù•É‘Õ”è€‹f#bŸb³b£b¤ƒfb«bb»bÇb¤ˆ°(€€€½ÁÑ¥½¹…±=Ù•É‘Õ”è€‹bŸb»b«f+bŸbÇf+b¤ƒfb«bb»bÇb¤ˆ°¹•Ù•Èè€‹ffƒb«ffbÀˆ°‘•±•Ñ•è€‹fb·bÃf#fb¤ˆ°(€õmÙ…±Õ•tñðÙ…±Õ”ñð€‹b£fbœƒb·bŸfb¤ˆì)ô()™Õ¹Ñ¥½¸…Ñ¥½¹1…‰•°¡Ù…±Õ”¤ì(€É•ÑÕÉ¸ì(€€€±½¥¸è€‹b«bÏb³f+fƒb¿b»f#fƒbŸffb¿f+bÄˆ°(€€€±½½ÕÐè€‹b«bÏb³f+fƒb»bÇf#b°ƒbŸffb¿f+bÄˆ°(€€€ÕÁ‘…Ñ•}ÁÉ½™¥±”è€‹b«bçb¿f+fƒb£f+bŸfbŸb¨ƒbŸfb·bÏbŸb ˆ°(€€€É•Í•Ñ}Á…ÍÍÝ½Éè€‹b—bçbŸb¿b¤ƒb«bçf+f+fƒfffb¤ƒbŸffbÇf#bÄˆ°(€€€É•Ù½­•}Í•ÍÍ¥½¹Ìè€‹b—bëfbŸfƒb³fbÏbŸb¨ƒbŸffbÏb«b»b¿fˆ°(€€€‘•±•Ñ•}Ñ…Í¬è€‹b·bÃfƒfffb¤ˆ°(€€€‘•±•Ñ•}É•½Éè€‹b·bÃfƒbÏb³fˆ°(€€€ÕÁ‘…Ñ•}Ñ…Í¬è€‹b«bçb¿f+fƒfffb¤ˆ°(€€€ÕÁ‘…Ñ•}É•½Éè€‹b«bçb¿f+fƒbÏb³fˆ°(€€€‘•±•Ñ•}…½Õ¹Ðè€‹b·bÃfƒb·bÏbŸb ˆ°(€õmÙ…±Õ•tñðÙ…±Õ”ì)ô()…Íå¹Œ™Õ¹Ñ¥½¸…Á¤¡Á…Ñ °½ÁÑ¥½¹Ì€ôíô¤ì(€½¹ÍÐ¡•…‘•ÉÌ€ôì•ÁÐè€‰…ÁÁ±¥…Ñ¥½¸½©Í½¸ˆôì(€¥˜€¡½ÁÑ¥½¹Ì¹‰½‘ä€„ôôÕ¹‘•™¥¹•¤¡•…‘•ÉÍl‰½¹Ñ•¹ÐµQåÁ”‰t€ô€‰…ÁÁ±¥…Ñ¥½¸½©Í½¸ˆì(€¥˜€¡ÍÑ…Ñ”¹ÍÉ˜€˜˜½ÁÑ¥½¹Ì¹…ÕÑ €„ôô™…±Í”€˜˜½ÁÑ¥½¹Ì¹µ•Ñ¡½€˜˜½ÁÑ¥½¹Ì¹µ•Ñ¡½€„ôô€‰Pˆ¤ì(€€€¡•…‘•ÉÍl‰`µMIµQ½­•¸‰t€ôÍÑ…Ñ”¹ÍÉ˜ì(€ô(€½¹ÍÐÉ•ÍÁ½¹Í”€ô…Ý…¥Ð™•Ñ ¡Á…Ñ °ì(€€€µ•Ñ¡½è½ÁÑ¥½¹Ì¹µ•Ñ¡½ñð€‰Pˆ°(€€€¡•…‘•ÉÌ°(€€€É•‘•¹Ñ¥…±Ìè€‰Í…µ”µ½É¥¥¸ˆ°(€€€‰½‘äè½ÁÑ¥½¹Ì¹‰½‘ä€ôôôÕ¹‘•™¥¹•€üÕ¹‘•™¥¹•€è)M=8¹ÍÑÉ¥¹¥™ä¡½ÁÑ¥½¹Ì¹‰½‘ä¤°(€ô¤ì(€±•Ð‰½‘ä€ôíôì(€ÑÉäì(€€€‰½‘ä€ô…Ý…¥ÐÉ•ÍÁ½¹Í”¹©Í½¸ ¤ì(€ô…Ñ íô(€¥˜€ …É•ÍÁ½¹Í”¹½¬¤ì(€€€¥˜€¡É•ÍÁ½¹Í”¹ÍÑ…ÑÕÌ€ôôô€ÐÀÄ€˜˜½ÁÑ¥½¹Ì¹…ÕÑ €„ôô™…±Í”¤Í¡½Ý1½¥¸ ¤ì(€€€Ñ¡É½Ü¹•ÜÉÉ½È¡‰½‘ä¹•ÉÉ½Èñð€‹b«bçbÃbÄƒb«fff+bÀƒbŸfbßfb ˆ¤ì(€ô(€É•ÑÕÉ¸‰½‘äì)ô()™Õ¹Ñ¥½¸™½Éµ…Ñ	åÑ•Ì¡‰åÑ•Ì¤ì(€½¹ÍÐÙ…±Õ”€ô5…Ñ ¹µ…à À°9Õµ‰•È¡‰åÑ•Ì¤ñð€À¤ì(€¥˜€¡Ù…±Õ”€ð€ÄÀÈÐ¤É•ÑÕÉ¸€‘íÙ…±Õ•ôƒb£bŸf+b©€ì(€½¹ÍÐÕ¹¥ÑÌ€ôl‹f»b ˆ°€‹f»b ˆ°€‹b°»b ˆ°€‹b¨»b ‰tì(€±•ÐÍ¥é”€ôÙ…±Õ”ì(€±•ÐÕ¹¥Ð€ô€‹b£bŸf+b¨ˆì(€™½È€¡½¹ÍÐ¹•áÐ½˜Õ¹¥ÑÌ¤ì(€€€Í¥é”€¼ô€ÄÀÈÐì(€€€Õ¹¥Ð€ô¹•áÐì(€€€¥˜€¡Í¥é”€ð€ÄÀÈÐ¤‰É•…¬ì(€ô(€É•ÑÕÉ¸€‘íÍ¥é”€øô€ÄÀÀ€üÍ¥é”¹Ñ½¥á• À¤€èÍ¥é”€øô€ÄÀ€üÍ¥é”¹Ñ½¥á• Ä¤€èÍ¥é”¹Ñ½¥á• È¥ô€‘íÕ¹¥Ñõ€ì)ô()™Õ¹Ñ¥½¸™½Éµ…Ñ9Õµ‰•È¡Ù…±Õ”¤ì(€É•ÑÕÉ¸¹•Ü%¹Ñ°¹9Õµ‰•É½Éµ…Ð ‰…ÈµMˆ¤¹™½Éµ…Ð¡9Õµ‰•È¡Ù…±Õ”¤ñð€À¤ì)ô()™Õ¹Ñ¥½¸™½Éµ…Ñ…Ñ”¡Ù…±Õ”¤ì(€½¹ÍÐ‘…Ñ”€ô¹•Ü…Ñ”¡Ù…±Õ”¤ì(€¥˜€ …9Õµ‰•È¹¥Í¥¹¥Ñ”¡‘…Ñ”¹•ÑQ¥µ” ¤¤¤É•ÑÕÉ¸€‹bëf+bÄƒfb·b¿b¼ˆì(€É•ÑÕÉ¸¹•Ü%¹Ñ°¹…Ñ•Q¥µ•½Éµ…Ð ‰…ÈµMˆ°ì(€€€‘…Ñ•MÑå±”è€‰µ•‘¥Õ´ˆ°(€€€Ñ¥µ•MÑå±”è€‰Í¡½ÉÐˆ°(€€€Ñ¥µ•i½¹”è€‰Í¥„½I¥å…‘ ˆ°(€ô¤¹™½Éµ…Ð¡‘…Ñ”¤ì)ô()™Õ¹Ñ¥½¸•µÁÑä¡µ•ÍÍ…”¤ì(€É•ÑÕÉ¸€ñ‘¥Ø±…ÍÌô‰•µÁÑäˆø‘í•Í…Á•!Ñµ°¡µ•ÍÍ…”¥ôð½‘¥Øù€ì)ô()™Õ¹Ñ¥½¸Ñ½…ÍÐ¡µ•ÍÍ…”¤ì(€•°¹Ñ½…ÍÐ¹Ñ•áÑ½¹Ñ•¹Ð€ôµ•ÍÍ…”ì(€•°¹Ñ½…ÍÐ¹±…ÍÍ1¥ÍÐ¹…‘ ‰Í¡½Üˆ¤ì(€±•…ÉQ¥µ•½ÕÐ¡Ñ½…ÍÐ¹Ñ¥µ•È¤ì(€Ñ½…ÍÐ¹Ñ¥µ•È€ôÍ•ÑQ¥µ•½ÕÐ  ¤€ôø•°¹Ñ½…ÍÐ¹±…ÍÍ1¥ÍÐ¹É•µ½Ù” ‰Í¡½Üˆ¤°€ÈØÀÀ¤ì)ô()™Õ¹Ñ¥½¸É•™É•Í¡%½¹Ì ¤ì(€±½‰…±Q¡¥Ì¹±Õ¥‘”ü¹É•…Ñ•%½¹Ì ¤ì)ô()™Õ¹Ñ¥½¸•Í…Á•!Ñµ°¡Ù…±Õ”¤ì(€É•ÑÕÉ¸MÑÉ¥¹œ¡Ù…±Õ”€üü€ˆˆ¤(€€€€¹É•Á±…•±° ˆ˜ˆ°€ˆ™…µÀìˆ¤(€€€€¹É•Á±…•±° ˆðˆ°€ˆ™±Ðìˆ¤(€€€€¹É•Á±…•±° ˆøˆ°€ˆ™Ðìˆ¤(€€€€¹É•Á±…•±° œˆœ°€ˆ™ÅÕ½Ðìˆ¤(€€€€¹É•Á±…•±° ˆœˆ°€ˆ˜ŒÀÌäìˆ¤ì)ô()™Õ¹Ñ¥½¸•Í…Á•ÑÑÈ¡Ù…±Õ”¤ì(€É•ÑÕÉ¸•Í…Á•!Ñµ°¡Ù…±Õ”¤¹É•Á±…•±° ‰€ˆ°€ˆ˜ŒÀäØìˆ¤ì)ô(