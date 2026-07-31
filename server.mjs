import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Pool } from "pg";
import {
  accountDataSection,
  compactAccountData,
  hydrateAccountData,
  normalizeUsername,
  pagination,
  summarizeData,
} from "./core.mjs";

const scrypt = promisify(crypto.scrypt);
const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const port = Number(process.env.PORT || 3000);
const cookieName = "ef3l_admin_session";
const sessionHours = Math.min(12, Math.max(1, Number(process.env.SESSION_HOURS || 4)));
const protectedUsernames = new Set(
  String(process.env.PROTECTED_USERNAMES || "tariq")
    .split(",")
    .map(normalizeUsername)
    .filter(Boolean),
);
const loginAttempts = new Map();
let pool;
let schemaPromise;

const staticFiles = new Set([
  "/index.html",
  "/app.js",
  "/styles.css",
  "/lucide.js",
  "/icon.svg",
]);

const securityHeaders = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (url.pathname === "/health") return handleHealth(response);
    if (url.pathname.startsWith("/api/")) return handleApi(request, response, url);
    return serveStatic(request, response, url.pathname);
  } catch (error) {
    console.error("Request error", error);
    return sendJson(response, 500, { error: "Ø­Ø¯Ø« Ø®Ø·Ø£ Ø¯Ø§Ø®Ù„ÙŠ ØºÙŠØ± Ù…ØªÙˆÙ‚Ø¹" });
  }
});

server.listen(port, () => {
  console.log(`EF3L Control listening on port ${port}`);
  ensureAuditSchema().catch((error) => console.error("Schema error", error));
});

async function handleHealth(response) {
  try {
    await getPool().query("SELECT 1");
    return sendJson(response, 200, { ok: true, databaseConnected: true });
  } catch {
    return sendJson(response, 503, { ok: false, databaseConnected: false });
  }
}

async function handleApi(request, response, url) {
  response.setHeader("Cache-Control", "no-store");
  const pathname = url.pathname;
  if (pathname === "/api/auth/login" && request.method === "POST") {
    return login(request, response);
  }

  const session = readAdminSession(request);
  if (pathname === "/api/session" && request.method === "GET") {
    return sendJson(response, 200, session ? sessionResponse(session) : { authenticated: false });
  }
  if (!session) return sendJson(response, 401, { error: "ÙŠÙ„Ø²Ù… ØªØ³Ø¬ÙŠÙ„ Ø¯Ø®ÙˆÙ„ Ø§Ù„Ù…Ø¯ÙŠØ±" });
  if (isMutation(request.method) && request.headers["x-csrf-token"] !== session.csrf) {
    return sendJson(response, 403, { error: "Ø±Ù…Ø² Ø­Ù…Ø§ÙŠØ© Ø§Ù„Ø·Ù„Ø¨ ØºÙŠØ± ØµØ§Ù„Ø­" });
  }

  await ensureAuditSchema();
  if (pathname === "/api/auth/logout" && request.method === "POST") {
    clearSessionCookie(request, response);
    await logAudit(session.sub, "logout", session.sub, {});
    return sendJson(response, 200, { ok: true });
  }
  if (pathname === "/api/overview" && request.method === "GET") {
    return overview(response);
  }
  if (pathname === "/api/accounts" && request.method === "GET") {
    return listAccounts(response, url);
  }
  if (pathname === "/api/audit" && request.method === "GET") {
    return listAudit(response, url);
  }

  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "api" || parts[1] !== "accounts" || !parts[2]) {
    return sendJson(response, 404, { error: "Ø§Ù„Ù…Ø³Ø§Ø± ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯" });
  }
  const username = normalizeUsername(decodeURIComponent(parts[2]));
  if (!username) return sendJson(response, 400, { error: "Ø§Ø³Ù… Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù… ØºÙŠØ± ØµØ§Ù„Ø­" });

  if (parts.length === 3 && request.method === "GET") {
    return accountDetails(response, username);
  }
  if (parts[3] === "items" && request.method === "GET") {
    return accountItems(response, username, url);
  }
  if (parts[3] === "raw" && request.method === "GET") {
    return accountRaw(response, username, url);
  }
  if (parts[3] === "export" && request.method === "GET") {
    return exportAccount(response, username);
  }
  if (parts[3] === "profile" && request.method === "PATCH") {
    return updateProfile(request, response, session, username);
  }
  if (parts[3] === "password" && request.method === "POST") {
    return resetPassword(request, response, session, username);
  }
  if (parts[3] === "sessions" && request.method === "DELETE") {
    return revokeSessions(response, session, username);
  }
  if (parts[3] === "items" && parts[4] && request.method === "DELETE") {
    return deleteAccountItem(response, session, username, decodeURIComponent(parts[4]), url);
  }
  if (parts[3] === "items" && parts[4] && request.method === "PATCH") {
    return updateAccountItem(request, response, session, username, decodeURIComponent(parts[4]), url);
  }
  if (parts.length === 3 && request.method === "DELETE") {
    return deleteAccount(response, session, username);
  }
  return sendJson(response, 404, { error: "Ø§Ù„Ù…Ø³Ø§Ø± ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯" });
}

async function login(request, response) {
  const ip = clientIp(request);
  if (isRateLimited(ip)) {
    return sendJson(response, 429, { error: "Ù…Ø­Ø§ÙˆÙ„Ø§Øª ÙƒØ«ÙŠØ±Ø©. Ø§Ù†ØªØ¸Ø± 15 Ø¯Ù‚ÙŠÙ‚Ø© Ø«Ù… Ø­Ø§ÙˆÙ„ Ù…Ø¬Ø¯Ø¯Ù‹Ø§." });
  }
  const body = await readJson(request);
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  const expectedUsername = String(process.env.ADMIN_USERNAME || "");
  const expectedPassword = String(process.env.ADMIN_PASSWORD || "");
  if (
    !expectedUsername ||
    expectedPassword.length < 12 ||
    !constantTimeEqual(username.toLocaleLowerCase("en-US"), expectedUsername.toLocaleLowerCase("en-US")) ||
    !constantTimeEqual(password, expectedPassword)
  ) {
    recordFailure(ip);
    return sendJson(response, 401, { error: "Ø§Ø³Ù… Ø§Ù„Ù…Ø¯ÙŠØ± Ø£Ùˆ ÙƒÙ„Ù…Ø© Ø§Ù„Ù…Ø±ÙˆØ± ØºÙŠØ± ØµØ­ÙŠØ­Ø©" });
  }
  clearFailures(ip);
  const now = Math.floor(Date.now() / 1000);
  const session = {
    sub: expectedUsername,
    csrf: crypto.randomBytes(24).toString("base64url"),
    iat: now,
    exp: now + sessionHours * 3600,
    jti: crypto.randomUUID(),
  };
  setSessionCookie(request, response, signSession(session));
  await ensureAuditSchema();
  await logAudit(session.sub, "login", session.sub, { ip });
  return sendJson(response, 200, sessionResponse(session));
}

async function overview(response) {
  const [databaseResult, countsResult, tablesResult, recentResult, auditResult] = await Promise.all([
    getPool().query(
      `SELECT current_database() AS database_name,
              pg_database_size(current_database())::bigint AS database_bytes`,
    ),
    getPool().query(
      `SELECT
         count(*)::bigint AS accounts,
         COALESCE(sum(jsonb_array_length(
           CASE WHEN jsonb_typeof(data->'tasks') = 'array' THEN data->'tasks' ELSE '[]'::jsonb END
         )), 0)::bigint AS task_settings,
         COALESCE(sum((
           SELECT count(*) FROM jsonb_object_keys(
             CASE WHEN jsonb_typeof(data->'instances') = 'object' THEN data->'instances' ELSE '{}'::jsonb END
           )
         )), 0)::bigint AS task_records,
         COALESCE(sum(pg_column_size(data) + pg_column_size(summary)), 0)::bigint AS users_data_bytes
       FROM accounts`,
    ),
    getPool().query(
      `SELECT relname AS name, pg_total_relation_size(relid)::bigint AS bytes,
              n_live_tup::bigint AS rows_estimate
         FROM pg_stat_user_tables
        ORDER BY pg_total_relation_size(relid) DESC`,
    ),
    getPool().query(
      `SELECT username, name, email, created_at, updated_at, pg_column_size(data)::bigint AS data_bytes
         FROM accounts ORDER BY updated_at DESC LIMIT 6`,
    ),
    getPool().query(
      `SELECT id, admin_username, action, target_username, details, created_at
         FROM admin_audit_log ORDER BY created_at DESC LIMIT 8`,
    ),
  ]);

  const databaseBytes = Number(databaseResult.rows[0].database_bytes);
  const capacityBytes = Math.max(
    databaseBytes,
    Number(process.env.DATABASE_CAPACITY_BYTES || 1_073_741_824),
  );
  const counts = countsResult.rows[0];
  return sendJson(response, 200, {
    storage: {
      databaseBytes,
      capacityBytes,
      remainingBytes: Math.max(0, capacityBytes - databaseBytes),
      usedPercent: Number(((databaseBytes / capacityBytes) * 100).toFixed(3)),
      usersDataBytes: Number(counts.users_data_bytes),
      estimated: true,
    },
    counts: {
      accounts: Number(counts.accounts),
      taskSettings: Number(counts.task_settings),
      taskRecords: Number(counts.task_records),
      sessions: await sessionCount(),
    },
    database: {
      actualName: databaseResult.rows[0].database_name,
      displayName: process.env.DATABASE_DISPLAY_NAME || "ifal-render-db",
      region: process.env.DATABASE_REGION || "frankfurt",
      version: process.env.DATABASE_VERSION || "16",
      expiresAt: process.env.DATABASE_EXPIRES_AT || null,
      sourceAppUrl: process.env.SOURCE_APP_URL || "https://ef3l.onrender.com",
    },
    tables: tablesResult.rows.map((row) => ({
      ...row,
      bytes: Number(row.bytes),
      rowsEstimate: Number(row.rows_estimate),
    })),
    recentAccounts: recentResult.rows.map(publicAccountRow),
    recentAudit: auditResult.rows,
    generatedAt: new Date().toISOString(),
  });
}

async function listAccounts(response, url) {
  const { limit, offset } = pagination(url.searchParams.get("limit"), url.searchParams.get("offset"));
  const search = String(url.searchParams.get("search") || "").trim().slice(0, 100);
  const pattern = `%${search}%`;
  const where = search
    ? "WHERE username ILIKE $1 OR name ILIKE $1 OR email ILIKE $1"
    : "";
  const params = search ? [pattern, limit, offset] : [limit, offset];
  const limitIndex = search ? 2 : 1;
  const [rows, count] = await Promise.all([
    getPool().query(
      `SELECT a.username, a.name, a.email, a.summary, a.created_at, a.updated_at,
              (pg_column_size(a.data) + pg_column_size(a.summary))::bigint AS storage_bytes,
              jsonb_array_length(
                CASE WHEN jsonb_typeof(a.data->'tasks') = 'array' THEN a.data->'tasks' ELSE '[]'::jsonb END
              )::bigint AS task_settings_count,
              (SELECT count(*) FROM jsonb_object_keys(
                CASE WHEN jsonb_typeof(a.data->'instances') = 'object' THEN a.data->'instances' ELSE '{}'::jsonb END
              ))::bigint AS task_records_count,
              (SELECT count(*) FROM account_sessions s WHERE s.username = a.username)::bigint AS sessions_count
         FROM accounts a ${where}
        ORDER BY a.updated_at DESC
        LIMIT $${limitIndex} OFFSET $${limitIndex + 1}`,
      params,
    ),
    getPool().query(`SELECT count(*)::bigint AS total FROM accounts ${where}`, search ? [pattern] : []),
  ]);
  return sendJson(response, 200, {
    items: rows.rows.map((row) => ({
      ...publicAccountRow(row),
      summary: row.summary || {},
      storageBytes: Number(row.storage_bytes),
      taskSettingsCount: Number(row.task_settings_count),
      taskRecordsCount: Number(row.task_records_count),
      sessionsCount: Number(row.sessions_count),
      protected: protectedUsernames.has(row.username),
    })),
    total: Number(count.rows[0].total),
    limit,
    offset,
  });
}

async function accountDetails(response, username) {
  const [accountResult, sessionsResult] = await Promise.all([
    getPool().query(
      `SELECT username, name, email, data, summary, created_at, updated_at,
              (pg_column_size(data) + pg_column_size(summary))::bigint AS storage_bytes
         FROM accounts WHERE username = $1`,
      [username],
    ),
    getPool().query(
      `SELECT created_at, last_used_at, expires_at
         FROM account_sessions WHERE username = $1 ORDER BY last_used_at DESC`,
      [username],
    ),
  ]);
  if (!accountResult.rowCount) return sendJson(response, 404, { error: "Ø§Ù„Ø­Ø³Ø§Ø¨ ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯" });
  const row = accountResult.rows[0];
  const data = hydrateAccountData(row.data);
  const activity = buildActivitySummary(data);
  return sendJson(response, 200, {
    account: {
      ...publicAccountRow(row),
      summary: row.summary || summarizeData(data),
      storageBytes: Number(row.storage_bytes),
      protected: protectedUsernames.has(username),
    },
    counts: summarizeData(data),
    activity,
    storageBreakdown: {
      tasks: jsonBytes(data.tasks || []),
      records: jsonBytes(data.instances || {}),
      settings: jsonBytes(data.settings || {}),
      metadata: jsonBytes({ user: data.user || {}, meta: data.meta || {} }),
    },
    sessions: sessionsResult.rows,
    sections: {
      version: data.version ?? null,
      user: data.user || null,
      settings: data.settings || null,
      meta: data.meta || null,
      sync: data.sync || null,
    },
  });
}

async function accountItems(response, username, url) {
  const type = url.searchParams.get("type") === "records" ? "records" : "tasks";
  const { limit, offset } = pagination(url.searchParams.get("limit"), url.searchParams.get("offset"));
  const search = String(url.searchParams.get("search") || "").trim().toLocaleLowerCase();
  const status = String(url.searchParams.get("status") || "").trim();
  const year = boundedInteger(url.searchParams.get("year"), 2000, 2200);
  const month = boundedInteger(url.searchParams.get("month"), 1, 12);
  const day = boundedInteger(url.searchParams.get("day"), 1, 31);
  const data = await accountData(username);
  if (!data) return sendJson(response, 404, { error: "Ø§Ù„Ø­Ø³Ø§Ø¨ ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯" });
  let items =
    type === "records"
      ? Object.entries(data.instances || {}).map(([id, item]) => ({ id, ...(item || {}) }))
      : (Array.isArray(data.tasks) ? data.tasks : []);
  if (search) {
    items = items.filter((item) => JSON.stringify(item).toLocaleLowerCase().includes(search));
  }
  if (status && type === "records") {
    items = items.filter((item) => String(item.status || "") === status);
  }
  if (type === "records" && year) {
    const prefix = `${year}-${month ? String(month).padStart(2, "0") : ""}`;
    items = items.filter((item) => String(item.date || "").startsWith(prefix));
  }
  if (type === "records" && year && month && day) {
    const selectedDate = `${year}-${String(month).padStart(2, "0")}-${String(day×Þ;¶‰žËkºwµç@ô¹•Ü…Ñ” ¤¹Ñ½%M=MÑÉ¥¹œ ¤ì(€€€‘…Ñ„¹µ•Ñ„€ô‘…Ñ„¹µ•Ñ„€˜˜ÑåÁ•½˜‘…Ñ„¹µ•Ñ„€ôôô€‰½‰©•Ðˆ€ü‘…Ñ„¹µ•Ñ„€èíôì(€€€¥˜€¡ÑåÁ”€ôôô€‰Ñ…Í­Ìˆ¤ì(€€€€€½¹ÍÐ‰•™½É”€ôÉÉ…ä¹¥ÍÉÉ…ä¡‘…Ñ„¹Ñ…Í­Ì¤€ü‘…Ñ„¹Ñ…Í­Ì¹±•¹Ñ €è€Àì(€€€€€‘…Ñ„¹Ñ…Í­Ì€ô€¡ÉÉ…ä¹¥ÍÉÉ…ä¡‘…Ñ„¹Ñ…Í­Ì¤€ü‘…Ñ„¹Ñ…Í­Ì€èmt¤¹™¥±Ñ•È (€€€€€€€€¡Ñ…Í¬¤€ôøMÑÉ¥¹œ¡Ñ…Í¬ü¹¥ñð€ˆˆ¤€„ôô¥Ñ•µ%°(€€€€€€¤ì(€€€€€¥˜€¡‘…Ñ„¹Ñ…Í­Ì¹±•¹Ñ €ôôô‰•™½É”¤ì(€€€€€€€…Ý…¥Ð±¥•¹Ð¹ÅÕ•Éä ‰I=11	,ˆ¤ì(€€€€€€€É•ÑÕÉ¸Í•¹‘)Í½¸¡É•ÍÁ½¹Í”°€ÐÀÐ°ì•ÉÉ½Èè€‹bŸffffb¤ƒbëf+bÄƒff#b³f#b¿b¤ˆô¤ì(€€€€€ô(€€€€€‘…Ñ„¹µ•Ñ„¹Ñ…Í­Q½µ‰ÍÑ½¹•Ì€ôì€¸¸¸¡‘…Ñ„¹µ•Ñ„¹Ñ…Í­Q½µ‰ÍÑ½¹•Ìñðíô¤°m¥Ñ•µ%‘tè‘•±•Ñ•‘Ðôì(€€€€€‘…Ñ„¹¥¹ÍÑ…¹•Ì€ô=‰©•Ð¹™É½µ¹ÑÉ¥•Ì (€€€€€€€=‰©•Ð¹•¹ÑÉ¥•Ì¡‘…Ñ„¹¥¹ÍÑ…¹•Ìñðíô¤¹™¥±Ñ•È ¡l°¥Ñ•µt¤€ôøMÑÉ¥¹œ¡¥Ñ•´ü¹Ñ…Í­%ñð€ˆˆ¤€„ôô¥Ñ•µ%¤°(€€€€€€¤ì(€€€ô•±Í”ì(€€€€€¥˜€ …‘…Ñ„¹¥¹ÍÑ…¹•Ìü¹m¥Ñ•µ%‘t¤ì(€€€€€€€…Ý…¥Ð±¥•¹Ð¹ÅÕ•Éä ‰I=11	,ˆ¤ì(€€€€€€€É•ÑÕÉ¸Í•¹‘)Í½¸¡É•ÍÁ½¹Í”°€ÐÀÐ°ì•ÉÉ½Èè€‹bŸfbÏb³fƒbëf+bÄƒff#b³f#b¼ˆô¤ì(€€€€€ô(€€€€€‘•±•Ñ”‘…Ñ„¹¥¹ÍÑ…¹•Ím¥Ñ•µ%‘tì(€€€€€‘…Ñ„¹µ•Ñ„¹¥¹ÍÑ…¹•Q½µ‰ÍÑ½¹•Ì€ôì€¸¸¸¡‘…Ñ„¹µ•Ñ„¹¥¹ÍÑ…¹•Q½µ‰ÍÑ½¹•Ìñðíô¤°m¥Ñ•µ%‘tè‘•±•Ñ•‘Ðôì(€€€ô(€€€½¹ÍÐÍÕµµ…Éä€ôÍÕµµ…É¥é•…Ñ„¡‘…Ñ„¤ì(€€€½¹ÍÐ½µÁ…Ð€ô½µÁ…Ñ½Õ¹Ñ…Ñ„¡‘…Ñ„¤ì(€€€…Ý…¥Ð±¥•¹Ð¹ÅÕ•Éä (€€€€€UAQ…½Õ¹ÑÌMP‘…Ñ„€ô€Èèé©Í½¹ˆ°ÍÕµµ…Éä€ô€Ìèé©Í½¹ˆ°ÕÁ‘…Ñ•‘}…Ð€ô9=\ ¤(€€€€€€€]!IÕÍ•É¹…µ”€ô€Å€°(€€€€€mÕÍ•É¹…µ”°)M=8¹ÍÑÉ¥¹¥™ä¡½µÁ…Ð¤°)M=8¹ÍÑÉ¥¹¥™ä¡ÍÕµµ…Éä¥t°(€€€€¤ì(€€€…Ý…¥Ð±¥•¹Ð¹ÅÕ•Éä ‰=55%Pˆ¤ì(€€€…Ý…¥Ð±½Õ‘¥Ð¡Í•ÍÍ¥½¸¹ÍÕˆ°ÑåÁ”€ôôô€‰Ñ…Í­Ìˆ€ü€‰‘•±•Ñ•}Ñ…Í¬ˆ€è€‰‘•±•Ñ•}É•½Éˆ°ÕÍ•É¹…µ”°ì(€€€€€¥Ñ•µ%°(€€€ô¤ì(€€€É•ÑÕÉ¸Í•¹‘)Í½¸¡É•ÍÁ½¹Í”°€ÈÀÀ°ì½¬èÑÉÕ”ô¤ì(€ô…Ñ €¡•ÉÉ½È¤ì(€€€…Ý…¥Ð±¥•¹Ð¹ÅÕ•Éä ‰I=11	,ˆ¤ì(€€€Ñ¡É½Ü•ÉÉ½Èì(€ô™¥¹…±±äì(€€€±¥•¹Ð¹É•±•…Í” ¤ì(€ô)ô()…Íå¹Œ™Õ¹Ñ¥½¸ÕÁ‘…Ñ•½Õ¹Ñ%Ñ•´¡É•ÅÕ•ÍÐ°É•ÍÁ½¹Í”°Í•ÍÍ¥½¸°ÕÍ•É¹…µ”°¥Ñ•µ%°ÕÉ°¤ì(€½¹ÍÐÑåÁ”€ôÕÉ°¹Í•…É¡A…É…µÌ¹•Ð ‰ÑåÁ”ˆ¤€ôôô€‰É•½É‘Ìˆ€ü€‰É•½É‘Ìˆ€è€‰Ñ…Í­Ìˆì(€½¹ÍÐ‰½‘ä€ô…Ý…¥ÐÉ•…‘)Í½¸¡É•ÅÕ•ÍÐ¤ì(€½¹ÍÐ¥¹½µ¥¹œ€ô‰½‘ä¹¥Ñ•´ì(€¥˜€ …¥¹½µ¥¹œñðÑåÁ•½˜¥¹½µ¥¹œ€„ôô€‰½‰©•ÐˆñðÉÉ…ä¹¥ÍÉÉ…ä¡¥¹½µ¥¹œ¤¤ì(€€€É•ÑÕÉ¸Í•¹‘)Í½¸¡É•ÍÁ½¹Í”°€ÐÀÀ°ì•ÉÉ½Èè€‹b£f+bŸfbŸb¨ƒbŸfbçfb×bÄƒbëf+bÄƒb×bŸfb·b¤ˆô¤ì(€ô(€½¹ÍÐ±¥•¹Ð€ô…Ý…¥Ð•ÑA½½° ¤¹½¹¹•Ð ¤ì(€ÑÉäì(€€€…Ý…¥Ð±¥•¹Ð¹ÅÕ•Éä ‰	%8ˆ¤ì(€€€½¹ÍÐÉ•ÍÕ±Ð€ô…Ý…¥Ð±¥•¹Ð¹ÅÕ•Éä ‰M1P‘…Ñ„I=4…½Õ¹ÑÌ]!IÕÍ•É¹…µ”€ô€Ä=HUAQˆ°mÕÍ•É¹…µ•t¤ì(€€€¥˜€ …É•ÍÕ±Ð¹É½Ý½Õ¹Ð¤ì(€€€€€…Ý…¥Ð±¥•¹Ð¹ÅÕ•Éä ‰I=11	,ˆ¤ì(€€€€€É•ÑÕÉ¸Í•¹‘)Í½¸¡É•ÍÁ½¹Í”°€ÐÀÐ°ì•ÉÉ½Èè€‹bŸfb·bÏbŸb ƒbëf+bÄƒff#b³f#b¼ˆô¤ì(€€€ô(€€€½¹ÍÐ‘…Ñ„€ô¡å‘É…Ñ•½Õ¹Ñ…Ñ„¡É•ÍÕ±Ð¹É½ÝÍlÁt¹‘…Ñ„¤ì(€€€½¹ÍÐÕÁ‘…Ñ•‘Ð€ô¹•Ü…Ñ” ¤¹Ñ½%M=MÑÉ¥¹œ ¤ì(€€€¥˜€¡ÑåÁ”€ôôô€‰Ñ…Í­Ìˆ¤ì(€€€€€½¹ÍÐÑ…Í­Ì€ôÉÉ…ä¹¥ÍÉÉ…ä¡‘…Ñ„¹Ñ…Í­Ì¤€ü‘…Ñ„¹Ñ…Í­Ì€èmtì(€€€€€½¹ÍÐ¥¹‘•à€ôÑ…Í­Ì¹™¥¹‘%¹‘•à ¡¥Ñ•´¤€ôøMÑÉ¥¹œ¡¥Ñ•´ü¹¥ñð€ˆˆ¤€ôôô¥Ñ•µ%¤ì(€€€€€¥˜€¡¥¹‘•à€ð€À¤ì(€€€€€€€…Ý…¥Ð±¥•¹Ð¹ÅÕ•Éä ‰I=11	,ˆ¤ì(€€€€€€€É•ÑÕÉ¸Í•¹‘)Í½¸¡É•ÍÁ½¹Í”°€ÐÀÐ°ì•ÉÉ½Èè€‹bŸffffb¤ƒbëf+bÄƒff#b³f#b¿b¤ˆô¤ì(€€€€€ô(€€€€€‘…Ñ„¹Ñ…Í­Ím¥¹‘•át€ôì€¸¸¹¥¹½µ¥¹œ°¥è¥Ñ•µ%°ÕÁ‘…Ñ•‘Ðôì(€€€ô•±Í”ì(€€€€€¥˜€ …‘…Ñ„¹¥¹ÍÑ…¹•Ìü¹m¥Ñ•µ%‘t¤ì(€€€€€€€…Ý…¥Ð±¥•¹Ð¹ÅÕ•Éä ‰I=11	,ˆ¤ì(€€€€€€€É•ÑÕÉ¸Í•¹‘)Í½¸¡É•ÍÁ½¹Í”°€ÐÀÐ°ì•ÉÉ½Èè€‹bŸfbÏb³fƒbëf+bÄƒff#b³f#b¼ˆô¤ì(€€€€€ô(€€€€€‘…Ñ„¹¥¹ÍÑ…¹•Ím¥Ñ•µ%‘t€ôì€¸¸¹¥¹½µ¥¹œ°¥è¥Ñ•µ%°ÕÁ‘…Ñ•‘Ðôì(€€€ô(€€€½¹ÍÐÍÕµµ…Éä€ôÍÕµµ…É¥é•…Ñ„¡‘…Ñ„¤ì(€€€½¹ÍÐ½µÁ…Ð€ô½µÁ…Ñ½Õ¹Ñ…Ñ„¡‘…Ñ„¤ì(€€€…Ý…¥Ð±¥•¹Ð¹ÅÕ•Éä (€€€€€UAQ…½Õ¹ÑÌMP‘…Ñ„€ô€Èèé©Í½¹ˆ°ÍÕµµ…Éä€ô€Ìèé©Í½¹ˆ°ÕÁ‘…Ñ•‘}…Ð€ô9=\ ¤(€€€€€€€]!IÕÍ•É¹…µ”€ô€Å€°(€€€€€mÕÍ•É¹…µ”°)M=8¹ÍÑÉ¥¹¥™ä¡½µÁ…Ð¤°)M=8¹ÍÑÉ¥¹¥™ä¡ÍÕµµ…Éä¥t°(€€€€¤ì(€€€…Ý…¥Ð±¥•¹Ð¹ÅÕ•Éä ‰=55%Pˆ¤ì(€€€…Ý…¥Ð±½Õ‘¥Ð¡Í•ÍÍ¥½¸¹ÍÕˆ°ÑåÁ”€ôôô€‰Ñ…Í­Ìˆ€ü€‰ÕÁ‘…Ñ•}Ñ…Í¬ˆ€è€‰ÕÁ‘…Ñ•}É•½Éˆ°ÕÍ•É¹…µ”°ì¥Ñ•µ%ô¤ì(€€€É•ÑÕÉ¸Í•¹‘)Í½¸¡É•ÍÁ½¹Í”°€ÈÀÀ°ì½¬èÑÉÕ”ô¤ì(€ô…Ñ €¡•ÉÉ½È¤ì(€€€…Ý…¥Ð±¥•¹Ð¹ÅÕ•Éä ‰I=11	,ˆ¤ì(€€€Ñ¡É½Ü•ÉÉ½Èì(€ô™¥¹…±±äì(€€€±¥•¹Ð¹É•±•…Í” ¤ì(€ô)ô()…Íå¹Œ™Õ¹Ñ¥½¸‘•±•Ñ•½Õ¹Ð¡É•ÍÁ½¹Í”°Í•ÍÍ¥½¸°ÕÍ•É¹…µ”¤ì(€¥˜€¡ÁÉ½Ñ•Ñ•‘UÍ•É¹…µ•Ì¹¡…Ì¡ÕÍ•É¹…µ”¤¤ì(€€€É•ÑÕÉ¸Í•¹‘)Í½¸¡É•ÍÁ½¹Í”°€ÐÀÌ°ì•ÉÉ½Èè€‹fbÃbœƒbŸfb·bÏbŸb ƒfb·ff(ƒf#fbœƒf+fffƒb·bÃffˆô¤ì(€ô(€½¹ÍÐÉ•ÍÕ±Ð€ô…Ý…¥Ð•ÑA½½° ¤¹ÅÕ•Éä ‰1QI=4…½Õ¹ÑÌ]!IÕÍ•É¹…µ”€ô€Äˆ°mÕÍ•É¹…µ•t¤ì(€¥˜€ …É•ÍÕ±Ð¹É½Ý½Õ¹Ð¤É•ÑÕÉ¸Í•¹‘)Í½¸¡É•ÍÁ½¹Í”°€ÐÀÐ°ì•ÉÉ½Èè€‹bŸfb·bÏbŸb ƒbëf+bÄƒff#b³f#b¼ˆô¤ì(€…Ý…¥Ð±½Õ‘¥Ð¡Í•ÍÍ¥½¸¹ÍÕˆ°€‰‘•±•Ñ•}…½Õ¹Ðˆ°ÕÍ•É¹…µ”°íô¤ì(€É•ÑÕÉ¸Í•¹‘)Í½¸¡É•ÍÁ½¹Í”°€ÈÀÀ°ì½¬èÑÉÕ”ô¤ì)ô()…Íå¹Œ™Õ¹Ñ¥½¸±¥ÍÑÕ‘¥Ð¡É•ÍÁ½¹Í”°ÕÉ°¤ì(€½¹ÍÐì±¥µ¥Ð°½™™Í•Ðô€ôÁ…¥¹…Ñ¥½¸¡ÕÉ°¹Í•…É¡A…É…µÌ¹•Ð ‰±¥µ¥Ðˆ¤°ÕÉ°¹Í•…É¡A…É…µÌ¹•Ð ‰½™™Í•Ðˆ¤¤ì(€½¹ÍÐmÉ½ÝÌ°½Õ¹Ñt€ô…Ý…¥ÐAÉ½µ¥Í”¹…±°¡l(€€€•ÑA½½° ¤¹ÅÕ•Éä (€€€€€M1P¥°…‘µ¥¹}ÕÍ•É¹…µ”°…Ñ¥½¸°Ñ…É•Ñ}ÕÍ•É¹…µ”°‘•Ñ…¥±Ì°É•…Ñ•‘}…Ð(€€€€€€€€I=4…‘µ¥¹}…Õ‘¥Ñ}±½œ=IH	dÉ•…Ñ•‘}…ÐM1%5%P€Ä=MP€É€°(€€€€€m±¥µ¥Ð°½™™Í•Ñt°(€€€€¤°(€€€•ÑA½½° ¤¹ÅÕ•Éä ‰M1P½Õ¹Ð ¨¤èé‰¥¥¹ÐLÑ½Ñ…°I=4…‘µ¥¹}…Õ‘¥Ñ}±½œˆ¤°(€t¤ì(€É•ÑÕÉ¸Í•¹‘)Í½¸¡É•ÍÁ½¹Í”°€ÈÀÀ°ì(€€€¥Ñ•µÌèÉ½ÝÌ¹É½ÝÌ°(€€€Ñ½Ñ…°è9Õµ‰•È¡½Õ¹Ð¹É½ÝÍlÁt¹Ñ½Ñ…°¤°(€€€±¥µ¥Ð°(€€€½™™Í•Ð°(€ô¤ì)ô()…Íå¹Œ™Õ¹Ñ¥½¸…½Õ¹Ñ…Ñ„¡ÕÍ•É¹…µ”¤ì(€½¹ÍÐÉ•ÍÕ±Ð€ô…Ý…¥Ð•ÑA½½° ¤¹ÅÕ•Éä ‰M1P‘…Ñ„I=4…½Õ¹ÑÌ]!IÕÍ•É¹…µ”€ô€Äˆ°mÕÍ•É¹…µ•t¤ì(€É•ÑÕÉ¸É•ÍÕ±Ð¹É½Ý½Õ¹Ð€ü¡å‘É…Ñ•½Õ¹Ñ…Ñ„¡É•ÍÕ±Ð¹É½ÝÍlÁt¹‘…Ñ„¤€è¹Õ±°ì)ô()™Õ¹Ñ¥½¸‰Õ¥±‘Ñ¥Ù¥ÑåMÕµµ…Éä¡‘…Ñ„¤ì(€½¹ÍÐÉ•½É‘Ì€ô=‰©•Ð¹Ù…±Õ•Ì¡‘…Ñ„¹¥¹ÍÑ…¹•Ìñðíô¤¹™¥±Ñ•È (€€€€¡¥Ñ•´¤€ôø€½yq‘ìÑôµq‘ìÉôµq‘ìÉô¼¹Ñ•ÍÐ¡MÑÉ¥¹œ¡¥Ñ•´ü¹‘…Ñ”ñð€ˆˆ¤¤°(€€¤ì(€½¹ÍÐå•…ÉÌ€ôÉÉ…ä¹™É½´¡¹•ÜM•Ð¡É•½É‘Ì¹µ…À ¡¥Ñ•´¤€ôø9Õµ‰•È¡MÑÉ¥¹œ¡¥Ñ•´¹‘…Ñ”¤¹Í±¥” À°€Ð¤¤¤¤¤(€€€€¹™¥±Ñ•È¡9Õµ‰•È¹¥Í¥¹¥Ñ”¤(€€€€¹Í½ÉÐ ¡„°ˆ¤€ôøˆ€´„¤ì(€½¹ÍÐÕÉÉ•¹Ñe•…È€ô9Õµ‰•È¡±½…±…Ñ” ¤¹Í±¥” À°€Ð¤¤ì(€¥˜€ …å•…ÉÌ¹¥¹±Õ‘•Ì¡ÕÉÉ•¹Ñe•…È¤¤å•…ÉÌ¹Õ¹Í¡¥™Ð¡ÕÉÉ•¹Ñe•…È¤ì(€½¹ÍÐ‰åe•…È€ô=‰©•Ð¹™É½µ¹ÑÉ¥•Ì¡å•…ÉÌ¹µ…À ¡å•…È¤€ôøl(€€€å•…È°(€€€ÉÉ…ä¹™É½´¡ì±•¹Ñ è€ÄÈô°€¡|°¥¹‘•à¤€ôøì(€€€€€½¹ÍÐµ½¹Ñ €ô¥¹‘•à€¬€Äì(€€€€€½¹ÍÐÁÉ•™¥à€ô€‘íå•…Éô´‘íMÑÉ¥¹œ¡µ½¹Ñ ¤¹Á…‘MÑ…ÉÐ È°€ˆÀˆ¥õ€ì(€€€€€½¹ÍÐ¥Ñ•µÌ€ôÉ•½É‘Ì¹™¥±Ñ•È ¡¥Ñ•´¤€ôøMÑÉ¥¹œ¡¥Ñ•´¹‘…Ñ”¤¹ÍÑ…ÉÑÍ]¥Ñ ¡ÁÉ•™¥à¤¤ì(€€€€€É•ÑÕÉ¸ì(€€€€€€€µ½¹Ñ °(€€€€€€€Ñ½Ñ…°è¥Ñ•µÌ¹±•¹Ñ °(€€€€€€€½µÁ±•Ñ•è¥Ñ•µÌ¹™¥±Ñ•È ¡¥Ñ•´¤€ôø¥Ñ•´¹ÍÑ…ÑÕÌ€ôôô€‰½µÁ±•Ñ•ˆ¤¹±•¹Ñ °(€€€€€€€Á•¹‘¥¹œè¥Ñ•µÌ¹™¥±Ñ•È ¡¥Ñ•´¤€ôø¥Ñ•´¹ÍÑ…ÑÕÌ€ôôô€‰µ…¥¸ˆ¤¹±•¹Ñ °(€€€€€€€µ¥ÍÍ•è¥Ñ•µÌ¹™¥±Ñ•È ¡¥Ñ•´¤€ôø(€€€€€€€€€l‰É•ÅÕ¥É•‘=Ù•É‘Õ”ˆ°€‰½ÁÑ¥½¹…±=Ù•É‘Õ”ˆ°€‰¹•Ù•È‰t¹¥¹±Õ‘•Ì¡¥Ñ•´¹ÍÑ…ÑÕÌ¤°(€€€€€€€€¤¹±•¹Ñ °(€€€€€€€‰åÑ•Ìè©Í½¹	åÑ•Ì¡¥Ñ•µÌ¤°(€€€€€ôì(€€€ô¤°(€t¤¤ì(€É•ÑÕÉ¸ì(€€€å•…ÉÌ°(€€€‰åe•…È°(€€€Ñ½‘…äè‘…åMÕµµ…Éä¡É•½É‘Ì°±½…±…Ñ” ¤¤°(€€€å•ÍÑ•É‘…äè‘…åMÕµµ…Éä¡É•½É‘Ì°±½…±…Ñ” ´Ä¤¤°(€ôì)ô()™Õ¹Ñ¥½¸‘…åMÕµµ…Éä¡É•½É‘Ì°‘…Ñ”¤ì(€½¹ÍÐ¥Ñ•µÌ€ôÉ•½É‘Ì¹™¥±Ñ•È ¡¥Ñ•´¤€ôø¥Ñ•´¹‘…Ñ”€ôôô‘…Ñ”¤ì(€É•ÑÕÉ¸ì(€€€‘…Ñ”°(€€€Ñ½Ñ…°è¥Ñ•µÌ¹±•¹Ñ °(€€€½µÁ±•Ñ•è¥Ñ•µÌ¹™¥±Ñ•È ¡¥Ñ•´¤€ôø¥Ñ•´¹ÍÑ…ÑÕÌ€ôôô€‰½µÁ±•Ñ•ˆ¤¹±•¹Ñ °(€€€¥Ñ•µÌè¥Ñ•µÌ¹Í±¥” À°€ÈÀ¤¹µ…À ¡¥Ñ•´¤€ôø€¡ì(€€€€€¥è¥Ñ•´¹¥°(€€€€€Ñ¥Ñ±”è¥Ñ•´¹Ñ¥Ñ±”°(€€€€€ÍÑ…ÑÕÌè¥Ñ•´¹ÍÑ…ÑÕÌ°(€€€€€Ñ¥µ”è¥Ñ•´¹Ñ¥µ”°(€€€€€½µÁ±•Ñ•‘Ðè¥Ñ•´¹½µÁ±•Ñ•‘Ðñð¹Õ±°°(€€€ô¤¤°(€ôì)ô()™Õ¹Ñ¥½¸±½…±…Ñ”¡‘…å=™™Í•Ð€ô€À¤ì(€½¹ÍÐÙ…±Õ”€ô¹•Ü…Ñ”¡…Ñ”¹¹½Ü ¤€¬‘…å=™™Í•Ð€¨€àÙ|ÐÀÁ|ÀÀÀ¤ì(€½¹ÍÐÁ…ÉÑÌ€ô=‰©•Ð¹™É½µ¹ÑÉ¥•Ì¡¹•Ü%¹Ñ°¹…Ñ•Q¥µ•½Éµ…Ð ‰•¸ˆ°ì(€€€Ñ¥µ•i½¹”èÁÉ½•ÍÌ¹•¹Ø¹AA}Q%5}i=9ñð€‰Í¥„½I¥å…‘ ˆ°(€€€å•…Èè€‰¹Õµ•É¥Œˆ°(€€€µ½¹Ñ è€ˆÈµ‘¥¥Ðˆ°(€€€‘…äè€ˆÈµ‘¥¥Ðˆ°(€ô¤¹™½Éµ…ÑQ½A…ÉÑÌ¡Ù…±Õ”¤¹µ…À ¡Á…ÉÐ¤€ôømÁ…ÉÐ¹ÑåÁ”°Á…ÉÐ¹Ù…±Õ•t¤¤ì(€É•ÑÕÉ¸€‘íÁ…ÉÑÌ¹å•…Éô´‘íÁ…ÉÑÌ¹µ½¹Ñ¡ô´‘íÁ…ÉÑÌ¹‘…åõ€ì)ô()™Õ¹Ñ¥½¸©Í½¹	åÑ•Ì¡Ù…±Õ”¤ì(€É•ÑÕÉ¸	Õ™™•È¹‰åÑ•1•¹Ñ ¡)M=8¹ÍÑÉ¥¹¥™ä¡Ù…±Õ”€üü¹Õ±°¤°€‰ÕÑ˜àˆ¤ì)ô()™Õ¹Ñ¥½¸‰½Õ¹‘•‘%¹Ñ••È¡Ù…±Õ”°µ¥¸°µ…à¤ì(€½¹ÍÐ¹Õµ‰•È€ô9Õµ‰•È¹Á…ÉÍ•%¹Ð¡Ù…±Õ”°€ÄÀ¤ì(€É•ÑÕÉ¸9Õµ‰•È¹¥Í%¹Ñ••È¡¹Õµ‰•È¤€˜˜¹Õµ‰•È€øôµ¥¸€˜˜¹Õµ‰•È€ðôµ…à€ü¹Õµ‰•È€è¹Õ±°ì)ô()…Íå¹Œ™Õ¹Ñ¥½¸Í•ÍÍ¥½¹½Õ¹Ð ¤ì(€½¹ÍÐÉ•ÍÕ±Ð€ô…Ý…¥Ð•ÑA½½° ¤¹ÅÕ•Éä ‰M1P½Õ¹Ð ¨¤èé‰¥¥¹ÐLÑ½Ñ…°I=4…½Õ¹Ñ}Í•ÍÍ¥½¹Ìˆ¤ì(€É•ÑÕÉ¸9Õµ‰•È¡É•ÍÕ±Ð¹É½ÝÍlÁt¹Ñ½Ñ…°¤ì)ô()™Õ¹Ñ¥½¸ÁÕ‰±¥½Õ¹ÑI½Ü¡É½Ü¤ì(€É•ÑÕÉ¸ì(€€€ÕÍ•É¹…µ”èÉ½Ü¹ÕÍ•É¹…µ”°(€€€¹…µ”èÉ½Ü¹¹…µ”°(€€€•µ…¥°èÉ½Ü¹•µ…¥°°(€€€É•…Ñ•‘ÐèÉ½Ü¹É•…Ñ•‘}…Ð°(€€€ÕÁ‘…Ñ•‘ÐèÉ½Ü¹ÕÁ‘…Ñ•‘}…Ð°(€€€‘…Ñ…	åÑ•Ìè9Õµ‰•È¡É½Ü¹‘…Ñ…}‰åÑ•Ìñð€À¤°(€ôì)ô()…Íå¹Œ™Õ¹Ñ¥½¸±½Õ‘¥Ð¡…‘µ¥¹UÍ•É¹…µ”°…Ñ¥½¸°Ñ…É•ÑUÍ•É¹…µ”°‘•Ñ…¥±Ì¤ì(€…Ý…¥Ð•ÑA½½° ¤¹ÅÕ•Éä (€€€%9MIP%9Q<…‘µ¥¹}…Õ‘¥Ñ}±½œ€¡…‘µ¥¹}ÕÍ•É¹…µ”°…Ñ¥½¸°Ñ…É•Ñ}ÕÍ•É¹…µ”°‘•Ñ…¥±Ì¤(€€€€Y1UL€ Ä°€È°€Ì°€Ðèé©Í½¹ˆ¥€°(€€€m…‘µ¥¹UÍ•É¹…µ”°…Ñ¥½¸°Ñ…É•ÑUÍ•É¹…µ”ñð€ˆˆ°)M=8¹ÍÑÉ¥¹¥™ä¡‘•Ñ…¥±Ìñðíô¥t°(€€¤ì)ô()™Õ¹Ñ¥½¸•¹ÍÕÉ•Õ‘¥ÑM¡•µ„ ¤ì(€¥˜€ …Í¡•µ…AÉ½µ¥Í”¤ì(€€€Í¡•µ…AÉ½µ¥Í”€ô•ÑA½½° ¤(€€€€€€¹ÅÕ•Éä (€€€€€€€IQQ	1%9=Pa%MQL…‘µ¥¹}…Õ‘¥Ñ}±½œ€ (€€€€€€€€€€¥	%MI%0AI%5Id-d°(€€€€€€€€€€…‘µ¥¹}ÕÍ•É¹…µ”QaP9=P9U10°(€€€€€€€€€€…Ñ¥½¸QaP9=P9U10°(€€€€€€€€€€Ñ…É•Ñ}ÕÍ•É¹…µ”QaP9=P9U10U1P€œœ°(€€€€€€€€€€‘•Ñ…¥±Ì)M=99=P9U10U1P€íôœèé©Í½¹ˆ°(€€€€€€€€€€É•…Ñ•‘}…ÐQ%5MQ5AQh9=P9U10U1P9=\ ¤(€€€€€€€€€¤ì(€€€€€€€€IQ%9`%9=Pa%MQL…‘µ¥¹}…Õ‘¥Ñ}±½}É•…Ñ•‘}…Ñ}¥‘à(€€€€€€€€€€=8…‘µ¥¹}…Õ‘¥Ñ}±½œ€¡É•…Ñ•‘}…ÐM¤í€°(€€€€€€¤(€€€€€€¹…Ñ  ¡•ÉÉ½È¤€ôøì(€€€€€€€Í¡•µ…AÉ½µ¥Í”€ô¹Õ±°ì(€€€€€€€Ñ¡É½Ü•ÉÉ½Èì(€€€€€ô¤ì(€ô(€É•ÑÕÉ¸Í¡•µ…AÉ½µ¥Í”ì)ô()™Õ¹Ñ¥½¸•ÑA½½° ¤ì(€¥˜€ …ÁÉ½•ÍÌ¹•¹Ø¹Q	M}UI0¤Ñ¡É½Ü¹•ÜÉÉ½È ‰Q	M}UI0ƒbëf+bÄƒfbÛb£f#bÜˆ¤ì(€¥˜€ …Á½½°¤ì(€€€½¹ÍÐ½¹¹•Ñ¥½¹MÑÉ¥¹œ€ôÁÉ½•ÍÌ¹•¹Ø¹Q	M}UI0ì(€€€½¹ÍÐ½¹™¥œ€ôì(€€€€€½¹¹•Ñ¥½¹MÑÉ¥¹œ°(€€€€€µ…àè5…Ñ ¹µ¥¸ ÄÀ°5…Ñ ¹µ…à Ä°9Õµ‰•È¡ÁÉ½•ÍÌ¹•¹Ø¹A}A==1}5`ñð€Ð¤¤¤°(€€€€€¥‘±•Q¥µ•½ÕÑ5¥±±¥Ìè€ÌÁ|ÀÀÀ°(€€€€€½¹¹•Ñ¥½¹Q¥µ•½ÕÑ5¥±±¥Ìè€ÄÁ|ÀÀÀ°(€€€ôì(€€€¥˜€ ½ÍÍ±µ½‘”õÉ•ÅÕ¥É”½¤¹Ñ•ÍÐ¡½¹¹•Ñ¥½¹MÑÉ¥¹œ¤ñð€½p¹É•¹‘•Ép¹½´½¤¹Ñ•ÍÐ¡½¹¹•Ñ¥½¹MÑÉ¥¹œ¤¤ì(€€€€€½¹™¥œ¹ÍÍ°€ôìÉ•©•ÑU¹…ÕÑ¡½É¥é•è™…±Í”ôì(€€€ô(€€€Á½½°€ô¹•ÜA½½°¡½¹™¥œ¤ì(€€€Á½½°¹½¸ ‰•ÉÉ½Èˆ°€¡•ÉÉ½È¤€ôø½¹Í½±”¹•ÉÉ½È ‰…Ñ…‰…Í”Á½½°•ÉÉ½Èˆ°•ÉÉ½È¤¤ì(€ô(€É•ÑÕÉ¸Á½½°ì)ô()™Õ¹Ñ¥½¸Í•ÍÍ¥½¹I•ÍÁ½¹Í”¡Í•ÍÍ¥½¸¤ì(€É•ÑÕÉ¸ì(€€€…ÕÑ¡•¹Ñ¥…Ñ•èÑÉÕ”°(€€€ÕÍ•É¹…µ”èÍ•ÍÍ¥½¸¹ÍÕˆ°(€€€ÍÉ™Q½­•¸èÍ•ÍÍ¥½¸¹ÍÉ˜°(€€€•áÁ¥É•ÍÐè¹•Ü…Ñ”¡Í•ÍÍ¥½¸¹•áÀ€¨€ÄÀÀÀ¤¹Ñ½%M=MÑÉ¥¹œ ¤°(€ôì)ô()™Õ¹Ñ¥½¸Í¥¹M•ÍÍ¥½¸¡Á…å±½…¤ì(€½¹ÍÐ•¹½‘•€ô	Õ™™•È¹™É½´¡)M=8¹ÍÑÉ¥¹¥™ä¡Á…å±½…¤¤¹Ñ½MÑÉ¥¹œ ‰‰…Í”ØÑÕÉ°ˆ¤ì(€½¹ÍÐÍ¥¹…ÑÕÉ”€ôÉåÁÑ¼(€€€€¹É•…Ñ•!µ…Œ ‰Í¡„ÈÔØˆ°Í•ÍÍ¥½¹M•É•Ð ¤¤(€€€€¹ÕÁ‘…Ñ”¡•¹½‘•¤(€€€€¹‘¥•ÍÐ ‰‰…Í”ØÑÕÉ°ˆ¤ì(€É•ÑÕÉ¸€‘í•¹½‘•‘ô¸‘íÍ¥¹…ÑÕÉ•õ€ì)ô()™Õ¹Ñ¥½¸É•…‘‘µ¥¹M•ÍÍ¥½¸¡É•ÅÕ•ÍÐ¤ì(€½¹ÍÐÑ½­•¸€ôÁ…ÉÍ•½½­¥•Ì¡É•ÅÕ•ÍÐ¹¡•…‘•ÉÌ¹½½­¥”ñð€ˆˆ¥m½½­¥•9…µ•tì(€¥˜€ …Ñ½­•¸¤É•ÑÕÉ¸¹Õ±°ì(€½¹ÍÐm•¹½‘•°Í¥¹…ÑÕÉ•t€ôÑ½­•¸¹ÍÁ±¥Ð ˆ¸ˆ¤ì(€¥˜€ …•¹½‘•ñð€…Í¥¹…ÑÕÉ”¤É•ÑÕÉ¸¹Õ±°ì(€½¹ÍÐ•áÁ•Ñ•€ôÉåÁÑ¼¹É•…Ñ•!µ…Œ ‰Í¡„ÈÔØˆ°Í•ÍÍ¥½¹M•É•Ð ¤¤¹ÕÁ‘…Ñ”¡•¹½‘•¤¹‘¥•ÍÐ ‰‰…Í”ØÑÕÉ°ˆ¤ì(€¥˜€ …½¹ÍÑ…¹ÑQ¥µ•ÅÕ…°¡Í¥¹…ÑÕÉ”°•áÁ•Ñ•¤¤É•ÑÕÉ¸¹Õ±°ì(€ÑÉäì(€€€½¹ÍÐÁ…å±½…€ô)M=8¹Á…ÉÍ”¡	Õ™™•È¹™É½´¡•¹½‘•°€‰‰…Í”ØÑÕÉ°ˆ¤¹Ñ½MÑÉ¥¹œ ‰ÕÑ˜àˆ¤¤ì(€€€½¹ÍÐ•áÁ•Ñ•‘UÍ•È€ôMÑÉ¥¹œ¡ÁÉ½•ÍÌ¹•¹Ø¹5%9}UMI95ñð€ˆˆ¤ì(€€€¥˜€ (€€€€€Á…å±½…¹•áÀ€ðô5…Ñ ¹™±½½È¡…Ñ”¹¹½Ü ¤€¼€ÄÀÀÀ¤ñð(€€€€€€…½¹ÍÑ…¹ÑQ¥µ•ÅÕ…°¡MÑÉ¥¹œ¡Á…å±½…¹ÍÕˆñð€ˆˆ¤¹Ñ½1½Ý•É…Í” ¤°•áÁ•Ñ•‘UÍ•È¹Ñ½1½Ý•É…Í” ¤¤(€€€€¤ì(€€€€€É•ÑÕÉ¸¹Õ±°ì(€€€ô(€€€É•ÑÕÉ¸Á…å±½…ì(€ô…Ñ ì(€€€É•ÑÕÉ¸¹Õ±°ì(€ô)ô()™Õ¹Ñ¥½¸Í•ÍÍ¥½¹M•É•Ð ¤ì(€½¹ÍÐÍ•É•Ð€ôMÑÉ¥¹œ¡ÁÉ½•ÍÌ¹•¹Ø¹MMM%=9}MIPñð€ˆˆ¤ì(€¥˜€¡Í•É•Ð¹±•¹Ñ €ð€ÌÈ¤Ñ¡É½Ü¹•ÜÉÉ½È ‰MMM%=9}MIPƒf+b³b ƒbfƒf+ff#f€ÌÈƒb·bÇff/bœƒbçff$ƒbŸfbffˆ¤ì(€É•ÑÕÉ¸Í•É•Ðì)ô()™Õ¹Ñ¥½¸Í•ÑM•ÍÍ¥½¹½½­¥”¡É•ÅÕ•ÍÐ°É•ÍÁ½¹Í”°Ñ½­•¸¤ì(€½¹ÍÐÍ•ÕÉ”€ôÁÉ½•ÍÌ¹•¹Ø¹9=}9X€ôôô€‰ÁÉ½‘ÕÑ¥½¸ˆñðÉ•ÅÕ•ÍÐ¹¡•…‘•ÉÍl‰àµ™½ÉÝ…É‘•µÁÉ½Ñ¼‰t€ôôô€‰¡ÑÑÁÌˆì(€É•ÍÁ½¹Í”¹Í•Ñ!•…‘•È (€€€€‰M•Ðµ½½­¥”ˆ°(€€€€‘í½½­¥•9…µ•ôô‘íÑ½­•¹ôì!ÑÑÁ=¹±äìM…µ•M¥Ñ”õMÑÉ¥ÐìA…Ñ ô¼ì5…àµ”ô‘íÍ•ÍÍ¥½¹!½ÕÉÌ€¨€ÌØÀÁô‘íÍ•ÕÉ”€ü€ˆìM•ÕÉ”ˆ€è€ˆ‰õ€°(€€¤ì)ô()™Õ¹Ñ¥½¸±•…ÉM•ÍÍ¥½¹½½­¥”¡É•ÅÕ•ÍÐ°É•ÍÁ½¹Í”¤ì(€½¹ÍÐÍ•ÕÉ”€ôÁÉ½•ÍÌ¹•¹Ø¹9=}9X€ôôô€‰ÁÉ½‘ÕÑ¥½¸ˆñðÉ•ÅÕ•ÍÐ¹¡•…‘•ÉÍl‰àµ™½ÉÝ…É‘•µÁÉ½Ñ¼‰t€ôôô€‰¡ÑÑÁÌˆì(€É•ÍÁ½¹Í”¹Í•Ñ!•…‘•È (€€€€‰M•Ðµ½½­¥”ˆ°(€€€€‘í½½­¥•9…µ•ôôì!ÑÑÁ=¹±äìM…µ•M¥Ñ”õMÑÉ¥ÐìA…Ñ ô¼ì5…àµ”ôÀ‘íÍ•ÕÉ”€ü€ˆìM•ÕÉ”ˆ€è€ˆ‰õ€°(€€¤ì)ô()™Õ¹Ñ¥½¸Á…ÉÍ•½½­¥•Ì¡¡•…‘•È¤ì(€É•ÑÕÉ¸=‰©•Ð¹™É½µ¹ÑÉ¥•Ì (€€€¡•…‘•È(€€€€€€¹ÍÁ±¥Ð ˆìˆ¤(€€€€€€¹µ…À ¡Á…ÉÐ¤€ôøÁ…ÉÐ¹ÑÉ¥´ ¤¹ÍÁ±¥Ð ˆôˆ¤¤(€€€€€€¹™¥±Ñ•È ¡m­•ä°Ù…±Õ•t¤€ôø­•ä€˜˜Ù…±Õ”¤(€€€€€€¹µ…À ¡m­•ä°€¸¸¹Ù…±Õ•t¤€ôøm­•ä°Ù…±Õ”¹©½¥¸ ˆôˆ¥t¤°(€€¤ì)ô()™Õ¹Ñ¥½¸½¹ÍÑ…¹ÑQ¥µ•ÅÕ…°¡™¥ÉÍÐ°Í•½¹¤ì(€½¹ÍÐ±•™Ð€ô	Õ™™•È¹™É½´¡MÑÉ¥¹œ¡™¥ÉÍÐ¤¤ì(€½¹ÍÐÉ¥¡Ð€ô	Õ™™•È¹™É½´¡MÑÉ¥¹œ¡Í•½¹¤¤ì(€¥˜€¡±•™Ð¹±•¹Ñ €„ôôÉ¥¡Ð¹±•¹Ñ ¤ì(€€€ÉåÁÑ¼¹Ñ¥µ¥¹M…™•ÅÕ…°¡±•™Ð°	Õ™™•È¹…±±½Œ¡±•™Ð¹±•¹Ñ ¤¤ì(€€€É•ÑÕÉ¸™…±Í”ì(€ô(€É•ÑÕÉ¸ÉåÁÑ¼¹Ñ¥µ¥¹M…™•ÅÕ…°¡±•™Ð°É¥¡Ð¤ì)ô()™Õ¹Ñ¥½¸¥ÍI…Ñ•1¥µ¥Ñ•¡¥À¤ì(€½¹ÍÐÕÑ½™˜€ô…Ñ”¹¹½Ü ¤€´€ÄÔ€¨€ØÁ|ÀÀÀì(€½¹ÍÐ…ÑÑ•µÁÑÌ€ô€¡±½¥¹ÑÑ•µÁÑÌ¹•Ð¡¥À¤ñðmt¤¹™¥±Ñ•È ¡Ñ¥µ”¤€ôøÑ¥µ”€øÕÑ½™˜¤ì(€±½¥¹ÑÑ•µÁÑÌ¹Í•Ð¡¥À°…ÑÑ•µÁÑÌ¤ì(€É•ÑÕÉ¸…ÑÑ•µÁÑÌ¹±•¹Ñ €øô€Øì)ô()™Õ¹Ñ¥½¸É•½É‘…¥±ÕÉ”¡¥À¤ì(€±½¥¹ÑÑ•µÁÑÌ¹Í•Ð¡¥À°l¸¸¸¡±½¥¹ÑÑ•µÁÑÌ¹•Ð¡¥À¤ñðmt¤°…Ñ”¹¹½Ü ¥t¹Í±¥” ´Ø¤¤ì)ô()™Õ¹Ñ¥½¸±•…É…¥±ÕÉ•Ì¡¥À¤ì(€±½¥¹ÑÑ•µÁÑÌ¹‘•±•Ñ”¡¥À¤ì)ô()™Õ¹Ñ¥½¸±¥•¹Ñ%À¡É•ÅÕ•ÍÐ¤ì(€É•ÑÕÉ¸MÑÉ¥¹œ¡É•ÅÕ•ÍÐ¹¡•…‘•ÉÍl‰àµ™½ÉÝ…É‘•µ™½È‰tñðÉ•ÅÕ•ÍÐ¹Í½­•Ð¹É•µ½Ñ•‘‘É•ÍÌñð€ˆˆ¤(€€€€¹ÍÁ±¥Ð ˆ°ˆ¥lÁt(€€€€¹ÑÉ¥´ ¤(€€€€¹Í±¥” À°€àÀ¤ì)ô()™Õ¹Ñ¥½¸¥Í5ÕÑ…Ñ¥½¸¡µ•Ñ¡½¤ì(€É•ÑÕÉ¸l‰A=MPˆ°€‰AQ ˆ°€‰AUPˆ°€‰1Q‰t¹¥¹±Õ‘•Ì¡µ•Ñ¡½ñð€ˆˆ¤ì)ô()…Íå¹Œ™Õ¹Ñ¥½¸É•…‘)Í½¸¡É•ÅÕ•ÍÐ¤ì(€½¹ÍÐ¡Õ¹­Ì€ômtì(€±•ÐÍ¥é”€ô€Àì(€™½È…Ý…¥Ð€¡½¹ÍÐ¡Õ¹¬½˜É•ÅÕ•ÍÐ¤ì(€€€Í¥é”€¬ô¡Õ¹¬¹±•¹Ñ ì(€€€¥˜€¡Í¥é”€ø€ÈÔØ€¨€ÄÀÈÐ¤Ñ¡É½Ü¹•ÜÉÉ½È ‹bŸfbßfb ƒbfb£bÄƒffƒbŸfb·b¼ƒbŸffbÏff#b´ˆ¤ì(€€€¡Õ¹­Ì¹ÁÕÍ ¡¡Õ¹¬¤ì(€ô(€¥˜€ …¡Õ¹­Ì¹±•¹Ñ ¤É•ÑÕÉ¸íôì(€ÑÉäì(€€€É•ÑÕÉ¸)M=8¹Á…ÉÍ”¡	Õ™™•È¹½¹…Ð¡¡Õ¹­Ì¤¹Ñ½MÑÉ¥¹œ ‰ÕÑ˜àˆ¤¤ì(€ô…Ñ ì(€€€Ñ¡É½Ü¹•ÜÉÉ½È ‹b×f+bëb¤)M=8ƒbëf+bÄƒb×bŸfb·b¤ˆ¤ì(€ô)ô()…Íå¹Œ™Õ¹Ñ¥½¸Í•ÉÙ•MÑ…Ñ¥Œ¡É•ÅÕ•ÍÐ°É•ÍÁ½¹Í”°Á…Ñ¡¹…µ”¤ì(€¥˜€¡É•ÅÕ•ÍÐ¹µ•Ñ¡½€„ôô€‰Pˆ€˜˜É•ÅÕ•ÍÐ¹µ•Ñ¡½€„ôô€‰!ˆ¤ì(€€€É•ÑÕÉ¸Í•¹‘Q•áÐ¡É•ÍÁ½¹Í”°€ÐÀÔ°€‰5•Ñ¡½¹½Ð…±±½Ý•ˆ¤ì(€ô(€½¹ÍÐÉ•ÅÕ•ÍÑ•€ôÁ…Ñ¡¹…µ”€ôôô€ˆ¼ˆ€ü€ˆ½¥¹‘•à¹¡Ñµ°ˆ€èÁ…Ñ¡¹…µ”ì(€¥˜€ …ÍÑ…Ñ¥¥±•Ì¹¡…Ì¡É•ÅÕ•ÍÑ•¤¤É•ÑÕÉ¸Í•¹‘Q•áÐ¡É•ÍÁ½¹Í”°€ÐÀÐ°€‰9½Ð™½Õ¹ˆ¤ì(€½¹ÍÐ™¥±•A…Ñ €ôÁ…Ñ ¹©½¥¸¡É½½Ñ¥È°É•ÅÕ•ÍÑ•¹Í±¥” Ä¤¤ì(€½¹ÍÐ¥¹™¼€ô…Ý…¥ÐÍÑ…Ð¡™¥±•A…Ñ ¤¹…Ñ   ¤€ôø¹Õ±°¤ì(€¥˜€ …¥¹™¼ü¹¥Í¥±” ¤¤É•ÑÕÉ¸Í•¹‘Q•áÐ¡É•ÍÁ½¹Í”°€ÐÀÐ°€‰9½Ð™½Õ¹ˆ¤ì(€É•ÍÁ½¹Í”¹ÝÉ¥Ñ•!•… ÈÀÀ°ì(€€€€¸¸¹Í•ÕÉ¥Ñå!•…‘•ÉÌ°(€€€€‰½¹Ñ•¹ÐµQåÁ”ˆè½¹Ñ•¹ÑQåÁ”¡Á…Ñ ¹•áÑ¹…µ”¡™¥±•A…Ñ ¤¤°(€€€€‰½¹Ñ•¹Ðµ1•¹Ñ ˆè¥¹™¼¹Í¥é”°(€€€€‰…¡”µ½¹ÑÉ½°ˆèÉ•ÅÕ•ÍÑ•€ôôô€ˆ½¥¹‘•à¹¡Ñµ°ˆ€ü€‰¹¼µ…¡”ˆ€è€‰ÁÕ‰±¥Œ°µ…àµ…”ôÌØÀÀˆ°(€ô¤ì(€¥˜€¡É•ÅÕ•ÍÐ¹µ•Ñ¡½€ôôô€‰!ˆ¤É•ÑÕÉ¸É•ÍÁ½¹Í”¹•¹ ¤ì(€É•…Ñ•I•…‘MÑÉ•…´¡™¥±•A…Ñ ¤¹Á¥Á”¡É•ÍÁ½¹Í”¤ì)ô()™Õ¹Ñ¥½¸½¹Ñ•¹ÑQåÁ”¡•áÑ•¹Í¥½¸¤ì(€É•ÑÕÉ¸ì(€€€€ˆ¹¡Ñµ°ˆè€‰Ñ•áÐ½¡Ñµ°ì¡…ÉÍ•ÐõÕÑ˜´àˆ°(€€€€ˆ¹ÍÌˆè€‰Ñ•áÐ½ÍÌì¡…ÉÍ•ÐõÕÑ˜´àˆ°(€€€€ˆ¹©Ìˆè€‰Ñ•áÐ½©…Ù…ÍÉ¥ÁÐì¡…ÉÍ•ÐõÕÑ˜´àˆ°(€€€€ˆ¹ÍÙœˆè€‰¥µ…”½ÍÙœ­áµ°ˆ°(€õm•áÑ•¹Í¥½¹tñð€‰…ÁÁ±¥…Ñ¥½¸½½Ñ•ÐµÍÑÉ•…´ˆì)ô()™Õ¹Ñ¥½¸Í•¹‘)Í½¸¡É•ÍÁ½¹Í”°ÍÑ…ÑÕÌ°Ù…±Õ”¤ì(€½¹ÍÐ‰½‘ä€ô)M=8¹ÍÑÉ¥¹¥™ä¡Ù…±Õ”¤ì(€É•ÍÁ½¹Í”¹ÝÉ¥Ñ•!•…¡ÍÑ…ÑÕÌ°ì(€€€€¸¸¹Í•ÕÉ¥Ñå!•…‘•ÉÌ°(€€€€‰…¡”µ½¹ÑÉ½°ˆè€‰¹¼µÍÑ½É”ˆ°(€€€€‰½¹Ñ•¹ÐµQåÁ”ˆè€‰…ÁÁ±¥…Ñ¥½¸½©Í½¸ì¡…ÉÍ•ÐõÕÑ˜´àˆ°(€€€€‰½¹Ñ•¹Ðµ1•¹Ñ ˆè	Õ™™•È¹‰åÑ•1•¹Ñ ¡‰½‘ä¤°(€ô¤ì(€É•ÍÁ½¹Í”¹•¹¡‰½‘ä¤ì)ô()™Õ¹Ñ¥½¸Í•¹‘Q•áÐ¡É•ÍÁ½¹Í”°ÍÑ…ÑÕÌ°Ù…±Õ”¤ì(€É•ÍÁ½¹Í”¹ÝÉ¥Ñ•!•…¡ÍÑ…ÑÕÌ°ì(€€€€¸¸¹Í•ÕÉ¥Ñå!•…‘•ÉÌ°(€€€€‰½¹Ñ•¹ÐµQåÁ”ˆè€‰Ñ•áÐ½Á±…¥¸ì¡…ÉÍ•ÐõÕÑ˜´àˆ°(€ô¤ì(€É•ÍÁ½¹Í”¹•¹¡Ù…±Õ”¤ì)ô