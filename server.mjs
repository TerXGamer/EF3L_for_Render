import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync } from "node:zlib";
import pg from "pg";

const { Pool } = pg;
const scrypt = promisify(crypto.scrypt);
const rootDir = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const accountPaths = new Set(["/api/account", "/.netlify/functions/account"]);
const adminPaths = new Set(["/api/admin"]);
const publicFiles = new Set([
  "/index.html",
  "/styles.css",
  "/core.mjs",
  "/lucide.js",
  "/icon.svg",
  "/sw.js",
]);
const maxBodyBytes = 6 * 1024 * 1024;
const sessionDays = Math.min(90, Math.max(1, Number(process.env.SESSION_DAYS || 30)));
const appTimeZone = process.env.APP_TIME_ZONE || "Asia/Riyadh";
const loginAttempts = new Map();

const jsonHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

const securityHeaders = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

let pool;
let schemaReady;

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

    if (url.pathname === "/health") {
      return sendJson(response, 200, {
        ok: true,
        databaseConfigured: Boolean(process.env.DATABASE_URL),
      });
    }

    if (accountPaths.has(url.pathname)) {
      return handleAccountRequest(request, response);
    }

    if (adminPaths.has(url.pathname)) {
      return handleAdminRequest(request, response);
    }

    if (url.pathname === "/app.js") {
      return serveBundledAppScript(request, response);
    }

    return serveStaticFile(request, response, url.pathname);
  } catch (error) {
    console.error("Request error", error);
    return sendJson(response, 500, { error: "حدث خطأ غير متوقع في الخادم" });
  }
});

server.headersTimeout = 15_000;
server.requestTimeout = 20_000;
server.keepAliveTimeout = 5_000;

server.listen(port, "0.0.0.0", () => {
  console.log(`Ifal server listening on port ${port}`);
  runMaintenanceTasks().catch((error) => {
    console.error("Maintenance error", error);
  });
});

function parseAdminSet() {
  return (process.env.ADMIN_SET || "")
    .split(",")
    .map((item) => normalizeUsername(item))
    .filter(Boolean);
}

function isAdminUser(username) {
  return parseAdminSet().includes(normalizeUsername(username));
}

function currentMonthRange() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: appTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const year = Number(values.year);
  const month = Number(values.month);
  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const monthEnd = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  const monthLabel = new Intl.DateTimeFormat("ar-SA-u-ca-gregory", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${monthStart}T12:00:00Z`));
  return { monthStart, monthEnd, monthLabel };
}

async function handleAccountRequest(request, response) {
  if (request.method !== "POST") {
    return sendJson(response, 405, { error: "طريقة الطلب غير مسموحة" }, { Allow: "POST" });
  }
  if (!process.env.DATABASE_URL) {
    return sendJson(response, 503, { error: "قاعدة البيانات غير متصلة في هذا التشغيل" });
  }

  try {
    await ensureSchema();
    const body = await readJsonBody(request);
    const action = cleanText(body.action, 40);

    if (action === "create") {
      return createAccount(request, response, body);
    }

    if (action === "login") {
      return loginAccount(request, response, body);
    }

    const authenticated = await authenticateRequest(request, body);
    if (!authenticated) {
      return sendJson(response, 401, { error: "انتهت الجلسة أو بيانات الدخول غير صحيحة" });
    }

    if (action === "session") {
      return sendJson(response, 200, publicResponse(authenticated.account));
    }

    if (action === "logout") {
      if (authenticated.tokenHash) {
        await getPool().query(`DELETE FROM account_sessions WHERE token_hash = $1`, [
          authenticated.tokenHash,
        ]);
      }
      return sendJson(response, 200, { ok: true });
    }

    if (action === "change-password") {
      return changePassword(response, authenticated.account, body);
    }

    if (action === "save") {
      const incomingData = sanitizeData(body.data, authenticated.account.username);
      const nextData = mergeCloudData(authenticated.account.data, incomingData);
      const nextSummary = buildSummary(nextData);
      const updatedAt = new Date().toISOString();
      const nextName = nextData?.user?.name
        ? cleanText(nextData.user.name, 80)
        : authenticated.account.name;
      const nextEmail = nextData?.user?.email
        ? cleanText(nextData.user.email, 120)
        : authenticated.account.email;

      await getPool().query(
        `UPDATE accounts
            SET name = $2,
                email = $3,
                data = $4::jsonb,
                summary = $5::jsonb,
                updated_at = $6
          WHERE username = $1`,
        [
          authenticated.account.username,
          nextName,
          nextEmail,
          JSON.stringify(nextData),
          JSON.stringify(nextSummary),
          updatedAt,
        ],
      );

      return sendJson(
        response,
        200,
        publicResponse({
          ...authenticated.account,
          name: nextName,
          email: nextEmail,
          data: nextData,
          summary: nextSummary,
          updatedAt,
        }),
      );
    }

    return sendJson(response, 400, { error: "طلب غير معروف" });
  } catch (error) {
    return handleApiError(response, "Account API error", error);
  }
}

async function createAccount(request, response, body) {
  const username = normalizeUsername(body.username);
  const password = String(body.password || "");
  const name = cleanText(body.name, 80);
  const email = cleanText(body.email, 120);
  const validationError = validateNewAccount({ username, password, name, email });
  if (validationError) return sendJson(response, 400, { error: validationError });

  const attemptKey = requestAttemptKey(request, username);
  if (isRateLimited(attemptKey)) {
    return sendJson(response, 429, { error: "محاولات كثيرة؛ انتظر قليلًا ثم حاول مرة أخرى" });
  }

  const existing = await readAccount(username);
  if (existing) {
    recordFailedAttempt(attemptKey);
    return sendJson(response, 409, { error: "اسم المستخدم موجود مسبقًا" });
  }

  const now = new Date().toISOString();
  const salt = crypto.randomBytes(16).toString("hex");
  const account = {
    username,
    name,
    email,
    salt,
    passwordHash: await hashPassword(password, salt),
    data: {},
    summary: {},
    createdAt: now,
    updatedAt: now,
  };
  await upsertAccount(account);
  const token = await createSession(username);
  clearAttempts(attemptKey);
  return sendJson(response, 201, publicResponse(account, token));
}

async function loginAccount(request, response, body) {
  const username = normalizeUsername(body.username);
  const password = String(body.password || "");
  if (!username || !password) {
    return sendJson(response, 400, { error: "اسم المستخدم وكلمة المرور مطلوبة" });
  }

  const attemptKey = requestAttemptKey(request, username);
  if (isRateLimited(attemptKey)) {
    return sendJson(response, 429, { error: "محاولات كثيرة؛ انتظر قليلًا ثم حاول مرة أخرى" });
  }

  const account = await authenticateAccount(username, password, true);
  if (!account) {
    recordFailedAttempt(attemptKey);
    return sendJson(response, 401, { error: "اسم المستخدم أو كلمة المرور غير صحيحة" });
  }

  const token = await createSession(account.username);
  clearAttempts(attemptKey);
  return sendJson(response, 200, publicResponse(account, token));
}

async function changePassword(response, account, body) {
  const currentPassword = String(body.currentPassword || "");
  const newPassword = String(body.newPassword || "");
  if (!(await verifyPassword(account, currentPassword))) {
    return sendJson(response, 401, { error: "كلمة المرور الحالية غير صحيحة" });
  }
  if (newPassword.length < 8 || newPassword.length > 128) {
    return sendJson(response, 400, { error: "كلمة المرور الجديدة يجب أن تكون بين 8 و128 حرفًا" });
  }

  const salt = crypto.randomBytes(16).toString("hex");
  const passwordHash = await hashPassword(newPassword, salt);
  await getPool().query(
    `UPDATE accounts SET salt = $2, password_hash = $3, updated_at = NOW() WHERE username = $1`,
    [account.username, salt, passwordHash],
  );
  await getPool().query(`DELETE FROM account_sessions WHERE username = $1`, [account.username]);
  const token = await createSession(account.username);
  return sendJson(response, 200, { ok: true, token });
}

async function handleAdminRequest(request, response) {
  if (request.method !== "POST") {
    return sendJson(response, 405, { error: "طريقة الطلب غير مسموحة" }, { Allow: "POST" });
  }
  if (!process.env.DATABASE_URL) {
    return sendJson(response, 503, { error: "قاعدة البيانات غير متصلة في هذا التشغيل" });
  }

  try {
    await ensureSchema();
    const body = await readJsonBody(request);
    const authenticated = await authenticateRequest(request, body);
    if (!authenticated) {
      return sendJson(response, 401, { error: "انتهت الجلسة أو بيانات الدخول غير صحيحة" });
    }
    if (!isAdminUser(authenticated.account.username)) {
      return sendJson(response, 403, { error: "غير مصرح" });
    }

    if (body.action === "check") {
      return sendJson(response, 200, { isAdmin: true });
    }

    if (body.action === "list") {
      const result = await getPool().query(`SELECT username FROM accounts ORDER BY LOWER(username) ASC`);
      return sendJson(response, 200, { users: result.rows.map((row) => row.username) });
    }

    if (body.action === "reveal") {
      const targetUsername = normalizeUsername(body.targetUsername);
      if (!targetUsername) {
        return sendJson(response, 400, { error: "اسم المستخدم المطلوب كشفه غير صالح" });
      }
      const target = await readAccount(targetUsername);
      if (!target) return sendJson(response, 404, { error: "المستخدم غير موجود" });
      const { monthStart, monthEnd, monthLabel } = currentMonthRange();
      return sendJson(response, 200, buildAdminRevealReport(target, monthStart, monthEnd, monthLabel));
    }

    return sendJson(response, 400, { error: "طلب غير معروف" });
  } catch (error) {
    return handleApiError(response, "Admin API error", error);
  }
}

function buildAdminRevealReport(account, monthStart, monthEnd, monthLabel) {
  const data = account.data && typeof account.data === "object" ? account.data : {};
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const instances =
    data.instances && typeof data.instances === "object" ? Object.values(data.instances) : [];
  const monthInstances = instances.filter(
    (item) => item?.date && item.date >= monthStart && item.date <= monthEnd,
  );
  const lastLogin = cleanText(data?.user?.loggedInAt || "", 40) || null;

  const taskReports = tasks.map((task) => {
    const taskInstances = monthInstances.filter((item) => item.taskId === task.id);
    const completedInstances = taskInstances.filter((item) => item.status === "completed");
    const lastAppearanceInstance = taskInstances
      .slice()
      .sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
    const lastCompletedInstance = completedInstances
      .slice()
      .sort((a, b) =>
        String(b.completedAt || b.updatedAt || "").localeCompare(
          String(a.completedAt || a.updatedAt || ""),
        ),
      )[0];

    return {
      id: cleanId(task.id),
      title: cleanText(task.title, 120),
      active: task.active !== false,
      createdAt: task.createdAt || null,
      appearanceFrom: task.time || null,
      appearanceTo: task.endTime || null,
      lastAppearance: lastAppearanceInstance?.date || null,
      lastCompletion: lastCompletedInstance?.completedAt || lastCompletedInstance?.updatedAt || null,
      completionCount: completedInstances.length,
      monthRecords: taskInstances.length,
    };
  });

  return {
    user: {
      username: account.username,
      name: account.name,
      email: account.email,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
      lastLogin,
    },
    month: { start: monthStart, end: monthEnd, label: monthLabel },
    tasks: taskReports,
  };
}

async function authenticateRequest(request, body) {
  const token = bearerToken(request);
  if (token) {
    const tokenHash = hashToken(token);
    const result = await getPool().query(
      `SELECT a.username, a.name, a.email, a.salt, a.password_hash, a.data, a.summary,
              a.created_at, a.updated_at
         FROM account_sessions s
         JOIN accounts a ON a.username = s.username
        WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
      [tokenHash],
    );
    if (result.rows[0]) {
      getPool()
        .query(`UPDATE account_sessions SET last_used_at = NOW() WHERE token_hash = $1`, [tokenHash])
        .catch(() => {});
      return { account: mapAccount(result.rows[0]), tokenHash };
    }
  }

  const username = normalizeUsername(body.username);
  const password = String(body.password || "");
  if (!username || !password) return null;
  const account = await authenticateAccount(username, password, true);
  return account ? { account, tokenHash: null } : null;
}

async function authenticateAccount(username, password, upgradeLegacy = false) {
  const account = await readAccount(username);
  if (!account || !(await verifyPassword(account, password))) return null;
  if (upgradeLegacy && isLegacyPassword(account)) {
    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = await hashPassword(password, salt);
    await getPool().query(
      `UPDATE accounts SET salt = $2, password_hash = $3, updated_at = NOW() WHERE username = $1`,
      [account.username, salt, passwordHash],
    );
    account.salt = salt;
    account.passwordHash = passwordHash;
  }
  return account;
}

function isLegacyPassword(account) {
  return !account.salt || !/^[a-f0-9]{128}$/i.test(account.passwordHash || "");
}

async function verifyPassword(account, password) {
  if (!password) return false;
  if (isLegacyPassword(account)) {
    return constantTimeTextEqual(account.passwordHash || "", password);
  }
  const candidate = await hashPassword(password, account.salt);
  return constantTimeTextEqual(account.passwordHash, candidate);
}

async function hashPassword(password, salt) {
  const derived = await scrypt(String(password), String(salt), 64, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return Buffer.from(derived).toString("hex");
}

function constantTimeTextEqual(first, second) {
  const left = Buffer.from(String(first));
  const right = Buffer.from(String(second));
  if (left.length !== right.length) {
    crypto.timingSafeEqual(left, Buffer.alloc(left.length));
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

async function createSession(username) {
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  await getPool().query(
    `INSERT INTO account_sessions (token_hash, username, expires_at)
     VALUES ($1, $2, NOW() + make_interval(days => $3::int))`,
    [tokenHash, username, sessionDays],
  );
  getPool().query(`DELETE FROM account_sessions WHERE expires_at <= NOW()`).catch(() => {});
  return token;
}

function bearerToken(request) {
  const match = /^Bearer\s+([A-Za-z0-9_-]{20,})$/i.exec(String(request.headers.authorization || ""));
  return match ? match[1] : "";
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function mergeCloudData(existingInput, incomingInput) {
  const existing = sanitizeData(existingInput, incomingInput?.user?.username);
  const incoming = sanitizeData(incomingInput, incomingInput?.user?.username);
  if (!Object.keys(existing).length) return incoming;
  if (!Object.keys(incoming).length) return existing;

  const existingMeta = existing.meta || {};
  const incomingMeta = incoming.meta || {};
  const meta = {
    taskTombstones: mergeTimestampMaps(
      existingMeta.taskTombstones,
      incomingMeta.taskTombstones,
    ),
    instanceTombstones: mergeTimestampMaps(
      existingMeta.instanceTombstones,
      incomingMeta.instanceTombstones,
    ),
    runtimeResetAt: latestTimestamp(existingMeta.runtimeResetAt, incomingMeta.runtimeResetAt),
  };

  const tasks = mergeRecords(existing.tasks, incoming.tasks)
    .filter((task) => isAfterTombstone(task.updatedAt, meta.taskTombstones[task.id]))
    .slice(0, 1000);
  const instances = Object.fromEntries(
    mergeRecords(Object.values(existing.instances || {}), Object.values(incoming.instances || {}))
      .filter((instance) => {
        const deletedAt = latestTimestamp(
          meta.instanceTombstones[instance.id],
          meta.runtimeResetAt,
        );
        return isAfterTombstone(instance.updatedAt || instance.createdAt, deletedAt);
      })
      .slice(-50_000)
      .map((instance) => [instance.id, instance]),
  );

  const existingSettings = existing.settings || {};
  const incomingSettings = incoming.settings || {};
  const snapshots = mergeRecords(existingSettings.snapshots, incomingSettings.snapshots)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 30);

  return {
    ...existing,
    ...incoming,
    version: Math.max(Number(existing.version || 1), Number(incoming.version || 1)),
    user: { ...(existing.user || {}), ...(incoming.user || {}) },
    tasks,
    instances,
    settings: {
      ...existingSettings,
      ...incomingSettings,
      snapshots,
      statsExcludedInstanceIds: uniqueStrings(
        existingSettings.statsExcludedInstanceIds,
        incomingSettings.statsExcludedInstanceIds,
      ),
      hiddenListInstanceIds: uniqueStrings(
        existingSettings.hiddenListInstanceIds,
        incomingSettings.hiddenListInstanceIds,
      ),
    },
    meta,
  };
}

function mergeRecords(first, second) {
  const map = new Map();
  [...(Array.isArray(first) ? first : []), ...(Array.isArray(second) ? second : [])].forEach(
    (item) => {
      if (!item?.id) return;
      const current = map.get(item.id);
      if (
        !current ||
        new Date(item.updatedAt || item.createdAt || 0).getTime() >=
          new Date(current.updatedAt || current.createdAt || 0).getTime()
      ) {
        map.set(item.id, item);
      }
    },
  );
  return Array.from(map.values());
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

function isAfterTombstone(updatedAt, deletedAt) {
  if (!deletedAt) return true;
  return new Date(updatedAt || 0).getTime() > new Date(deletedAt).getTime();
}

function uniqueStrings(first, second) {
  return Array.from(
    new Set([...(Array.isArray(first) ? first : []), ...(Array.isArray(second) ? second : [])]),
  ).slice(-50_000);
}

function sanitizeData(data, username) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const safe = structuredClone(data);
  if (safe.user && typeof safe.user === "object") {
    safe.user = {
      name: cleanText(safe.user.name, 80),
      email: cleanText(safe.user.email, 120),
      username: normalizeUsername(username || safe.user.username),
      loggedInAt: cleanText(safe.user.loggedInAt, 40),
    };
  }
  safe.tasks = (Array.isArray(safe.tasks) ? safe.tasks : []).slice(0, 1000);
  safe.instances = Object.fromEntries(
    Object.entries(
      safe.instances && typeof safe.instances === "object" && !Array.isArray(safe.instances)
        ? safe.instances
        : {},
    )
      .filter(([id, item]) => cleanId(id) && item && typeof item === "object")
      .slice(-50_000),
  );
  safe.settings = safe.settings && typeof safe.settings === "object" ? safe.settings : {};
  safe.settings.snapshots = (Array.isArray(safe.settings.snapshots)
    ? safe.settings.snapshots
    : []
  ).slice(0, 30);
  safe.meta = safe.meta && typeof safe.meta === "object" ? safe.meta : {};
  safe.meta.taskTombstones = sanitizeTimestampMap(safe.meta.taskTombstones);
  safe.meta.instanceTombstones = sanitizeTimestampMap(safe.meta.instanceTombstones);
  delete safe.imports;
  return safe;
}

function sanitizeTimestampMap(value) {
  return Object.fromEntries(
    Object.entries(value && typeof value === "object" ? value : {})
      .filter(
        ([id, timestamp]) =>
          cleanId(id) && Number.isFinite(new Date(String(timestamp || "")).getTime()),
      )
      .slice(-50_000),
  );
}

function buildSummary(data) {
  const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
  const instances =
    data?.instances && typeof data.instances === "object" ? Object.values(data.instances) : [];
  return {
    taskSettingsCount: tasks.length,
    taskRecordsCount: instances.length,
    completedCount: instances.filter((item) => item?.status === "completed").length,
    updatedAt: new Date().toISOString(),
  };
}

function validateNewAccount({ username, password, name, email }) {
  if (!/^[\p{L}\p{N}._-]{3,50}$/u.test(username)) {
    return "اسم المستخدم يجب أن يكون من 3 إلى 50 حرفًا دون مسافات";
  }
  if (password.length < 8 || password.length > 128) {
    return "كلمة المرور يجب أن تكون بين 8 و128 حرفًا";
  }
  if (!name) return "الاسم مطلوب";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "البريد الإلكتروني غير صالح";
  return "";
}

function requestAttemptKey(request, username) {
  const forwarded = String(request.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return `${forwarded || request.socket.remoteAddress || "unknown"}:${username}`;
}

function isRateLimited(key) {
  const cutoff = Date.now() - 15 * 60_000;
  const attempts = (loginAttempts.get(key) || []).filter((time) => time >= cutoff);
  if (attempts.length) loginAttempts.set(key, attempts);
  return attempts.length >= 8;
}

function recordFailedAttempt(key) {
  const attempts = loginAttempts.get(key) || [];
  attempts.push(Date.now());
  loginAttempts.set(key, attempts.slice(-8));
}

function clearAttempts(key) {
  loginAttempts.delete(key);
}

async function serveStaticFile(request, response, pathname) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return sendText(response, 405, "Method not allowed", { Allow: "GET, HEAD" });
  }

  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  if (!publicFiles.has(requestedPath)) return sendText(response, 404, "Not found");
  const filePath = path.join(rootDir, requestedPath.slice(1));
  const relative = path.relative(rootDir, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return sendText(response, 403, "Forbidden");
  }

  let info;
  try {
    info = await stat(filePath);
  } catch {
    return sendText(response, 404, "Not found");
  }
  if (!info.isFile()) return sendText(response, 404, "Not found");

  response.writeHead(200, {
    ...securityHeaders,
    "Content-Type": contentType(path.extname(filePath)),
    "Content-Length": info.size,
    "Cache-Control": cacheControl(filePath),
  });
  if (request.method === "HEAD") return response.end();
  createReadStream(filePath).pipe(response);
}

async function serveBundledAppScript(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return sendText(response, 405, "Method not allowed", { Allow: "GET, HEAD" });
  }
  const encoded = await readFile(path.join(rootDir, "app.js.br.b64"), "utf8");
  const content = brotliDecompressSync(Buffer.from(encoded.replace(/\s+/g, ""), "base64"));
  response.writeHead(200, {
    ...securityHeaders,
    "Content-Type": "text/javascript; charset=utf-8",
    "Content-Length": content.length,
    "Cache-Control": "no-cache",
  });
  if (request.method === "HEAD") return response.end();
  response.end(content);
}

function getPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL غير موجود. اربط قاعدة Render PostgreSQL بالخدمة.");
  }
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    const config = {
      connectionString,
      max: Math.min(20, Math.max(1, Number(process.env.PG_POOL_MAX || 5))),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    };
    if (shouldUseSsl(connectionString)) config.ssl = { rejectUnauthorized: false };
    pool = new Pool(config);
    pool.on("error", (error) => console.error("Database pool error", error));
  }
  return pool;
}

function shouldUseSsl(connectionString) {
  if (process.env.DATABASE_SSL) {
    return /^(1|true|yes|required)$/i.test(process.env.DATABASE_SSL);
  }
  return /sslmode=require/i.test(connectionString) || /\.render\.com/i.test(connectionString);
}

function ensureSchema() {
  if (!schemaReady) {
    schemaReady = getPool()
      .query(`
        CREATE TABLE IF NOT EXISTS accounts (
          username TEXT PRIMARY KEY,
          name TEXT NOT NULL DEFAULT '',
          email TEXT NOT NULL DEFAULT '',
          salt TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          data JSONB NOT NULL DEFAULT '{}'::jsonb,
          summary JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS account_sessions (
          token_hash TEXT PRIMARY KEY,
          username TEXT NOT NULL REFERENCES accounts(username) ON DELETE CASCADE ON UPDATE CASCADE,
          expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS account_sessions_username_idx ON account_sessions(username);
        CREATE INDEX IF NOT EXISTS account_sessions_expiry_idx ON account_sessions(expires_at);
      `)
      .catch((error) => {
        schemaReady = null;
        throw error;
      });
  }
  return schemaReady;
}

async function readAccount(username) {
  const result = await getPool().query(
    `SELECT username, name, email, salt, password_hash, data, summary, created_at, updated_at
       FROM accounts
      WHERE username = $1`,
    [normalizeUsername(username)],
  );
  return result.rows[0] ? mapAccount(result.rows[0]) : null;
}

async function upsertAccount(account) {
  await getPool().query(
    `INSERT INTO accounts (
       username, name, email, salt, password_hash, data, summary, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)
     ON CONFLICT (username) DO UPDATE SET
       name = EXCLUDED.name,
       email = EXCLUDED.email,
       salt = EXCLUDED.salt,
       password_hash = EXCLUDED.password_hash,
       data = EXCLUDED.data,
       summary = EXCLUDED.summary,
       updated_at = EXCLUDED.updated_at`,
    [
      account.username,
      account.name,
      account.email,
      account.salt,
      account.passwordHash,
      JSON.stringify(account.data),
      JSON.stringify(account.summary),
      account.createdAt,
      account.updatedAt,
    ],
  );
}

function mapAccount(row) {
  return {
    username: row.username,
    name: row.name,
    email: row.email,
    salt: row.salt,
    passwordHash: row.password_hash,
    data: row.data || null,
    summary: row.summary || null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

function publicResponse(account, token) {
  return {
    user: {
      username: account.username,
      name: account.name,
      email: account.email,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    },
    data: account.data || null,
    ...(token ? { token } : {}),
  };
}

async function runMaintenanceTasks() {
  if (!process.env.DATABASE_URL) return;
  await ensureSchema();

  const deleteUsers = splitEnvList(process.env.DELETE_ACCOUNT_NOW);
  for (const username of deleteUsers) {
    await getPool().query(`DELETE FROM accounts WHERE username = $1`, [normalizeUsername(username)]);
  }

  for (const [username, newPassword] of parseEnvPairs(process.env.CHANGE_PASSWORD)) {
    if (!newPassword) continue;
    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = await hashPassword(newPassword, salt);
    await getPool().query(
      `UPDATE accounts SET salt = $2, password_hash = $3, updated_at = NOW() WHERE username = $1`,
      [normalizeUsername(username), salt, passwordHash],
    );
    await getPool().query(`DELETE FROM account_sessions WHERE username = $1`, [
      normalizeUsername(username),
    ]);
  }

  for (const [oldUsername, newUsername] of parseEnvPairs(process.env.CHANGE_USERNAME)) {
    const oldValue = normalizeUsername(oldUsername);
    const newValue = normalizeUsername(newUsername);
    if (oldValue && /^[\p{L}\p{N}._-]{3,50}$/u.test(newValue)) {
      await getPool().query(`UPDATE accounts SET username = $2, updated_at = NOW() WHERE username = $1`, [
        oldValue,
        newValue,
      ]);
    }
  }

  for (const [username, name] of parseEnvPairs(process.env.CHANGE_NAME)) {
    await getPool().query(`UPDATE accounts SET name = $2, updated_at = NOW() WHERE username = $1`, [
      normalizeUsername(username),
      cleanText(name, 80),
    ]);
  }

  for (const [username, email] of parseEnvPairs(process.env.CHANGE_EMAIL)) {
    await getPool().query(`UPDATE accounts SET email = $2, updated_at = NOW() WHERE username = $1`, [
      normalizeUsername(username),
      cleanText(email, 120),
    ]);
  }
}

function splitEnvList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseEnvPairs(value) {
  return splitEnvList(value)
    .map((item) => {
      const separator = item.indexOf(":");
      return separator > 0
        ? [item.slice(0, separator).trim(), item.slice(separator + 1).trim()]
        : null;
    })
    .filter(Boolean);
}

async function readJsonBody(request) {
  const contentTypeValue = String(request.headers["content-type"] || "");
  if (!contentTypeValue.toLowerCase().startsWith("application/json")) {
    const error = new Error("نوع المحتوى يجب أن يكون JSON");
    error.status = 415;
    throw error;
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBodyBytes) {
      const error = new Error("حجم الطلب أكبر من المسموح");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("صيغة JSON غير صالحة");
    error.status = 400;
    throw error;
  }
}

function handleApiError(response, label, error) {
  console.error(label, error);
  const status = Number(error?.status);
  if ([400, 413, 415].includes(status)) {
    return sendJson(response, status, { error: cleanText(error.message, 180) });
  }
  return sendJson(response, 500, { error: "تعذر إكمال الطلب الآن" });
}

function cleanText(value, max = 240) {
  return String(value || "").trim().slice(0, max);
}

function cleanId(value) {
  const id = String(value || "");
  return /^[a-zA-Z0-9._:-]{1,240}$/.test(id) ? id : "";
}

function normalizeUsername(value) {
  return cleanText(value, 50).toLocaleLowerCase("ar-SA");
}

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, { ...jsonHeaders, ...securityHeaders, ...headers });
  response.end(JSON.stringify(body));
}

function sendText(response, status, body, headers = {}) {
  response.writeHead(status, {
    ...securityHeaders,
    "Content-Type": "text/plain; charset=utf-8",
    ...headers,
  });
  response.end(body);
}

function contentType(extension) {
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
  }[extension.toLowerCase()] || "application/octet-stream";
}

function cacheControl(filePath) {
  const name = path.basename(filePath);
  return ["index.html", "app.js", "core.mjs", "styles.css", "sw.js"].includes(name)
    ? "no-cache"
    : "public, max-age=3600";
}
