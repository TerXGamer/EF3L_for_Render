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
  normalizeUsername,
  pagination,
  safeAccountData,
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
    return sendJson(response, 500, { error: "حدث خطأ داخلي غير متوقع" });
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
  if (!session) return sendJson(response, 401, { error: "يلزم تسجيل دخول المدير" });
  if (isMutation(request.method) && request.headers["x-csrf-token"] !== session.csrf) {
    return sendJson(response, 403, { error: "رمز حماية الطلب غير صالح" });
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
    return sendJson(response, 404, { error: "المسار غير موجود" });
  }
  const username = normalizeUsername(decodeURIComponent(parts[2]));
  if (!username) return sendJson(response, 400, { error: "اسم المستخدم غير صالح" });

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
  if (parts.length === 3 && request.method === "DELETE") {
    return deleteAccount(response, session, username);
  }
  return sendJson(response, 404, { error: "المسار غير موجود" });
}

async function login(request, response) {
  const ip = clientIp(request);
  if (isRateLimited(ip)) {
    return sendJson(response, 429, { error: "محاولات كثيرة. انتظر 15 دقيقة ثم حاول مجددًا." });
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
    return sendJson(response, 401, { error: "اسم المدير أو كلمة المرور غير صحيحة" });
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
  if (!accountResult.rowCount) return sendJson(response, 404, { error: "الحساب غير موجود" });
  const row = accountResult.rows[0];
  const data = safeAccountData(row.data);
  return sendJson(response, 200, {
    account: {
      ...publicAccountRow(row),
      summary: row.summary || summarizeData(data),
      storageBytes: Number(row.storage_bytes),
      protected: protectedUsernames.has(username),
    },
    counts: summarizeData(data),
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
  const data = await accountData(username);
  if (!data) return sendJson(response, 404, { error: "الحساب غير موجود" });
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
  items.sort((a, b) =>
    String(b.updatedAt || b.createdAt || b.date || "").localeCompare(
      String(a.updatedAt || a.createdAt || a.date || ""),
    ),
  );
  return sendJson(response, 200, {
    type,
    items: items.slice(offset, offset + limit),
    total: items.length,
    limit,
    offset,
  });
}

async function accountRaw(response, username, url) {
  const data = await accountData(username);
  if (!data) return sendJson(response, 404, { error: "الحساب غير موجود" });
  const section = String(url.searchParams.get("section") || "");
  return sendJson(response, 200, {
    section: section || "account",
    value: section === "summary" ? summarizeData(data) : accountDataSection(data, section),
  });
}

async function exportAccount(response, username) {
  const result = await getPool().query(
    `SELECT username, name, email, data, summary, created_at, updated_at
       FROM accounts WHERE username = $1`,
    [username],
  );
  if (!result.rowCount) return sendJson(response, 404, { error: "الحساب غير موجود" });
  const payload = JSON.stringify(
    { exportedAt: new Date().toISOString(), account: result.rows[0] },
    null,
    2,
  );
  response.writeHead(200, {
    ...securityHeaders,
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Disposition": `attachment; filename="ef3l-${username}.json"`,
    "Content-Length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

async function updateProfile(request, response, session, username) {
  const body = await readJson(request);
  const name = String(body.name || "").trim().slice(0, 80);
  const email = String(body.email || "").trim().toLocaleLowerCase().slice(0, 120);
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return sendJson(response, 400, { error: "الاسم أو البريد غير صالح" });
  }
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query("SELECT data FROM accounts WHERE username = $1 FOR UPDATE", [username]);
    if (!selected.rowCount) {
      await client.query("ROLLBACK");
      return sendJson(response, 404, { error: "الحساب غير موجود" });
    }
    const data = safeAccountData(selected.rows[0].data);
    data.user = { ...(data.user || {}), username, name, email };
    await client.query(
      `UPDATE accounts SET name = $2, email = $3, data = $4::jsonb, updated_at = NOW()
        WHERE username = $1`,
      [username, name, email, JSON.stringify(data)],
    );
    await client.query("COMMIT");
    await logAudit(session.sub, "update_profile", username, { name, email });
    return sendJson(response, 200, { ok: true });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function resetPassword(request, response, session, username) {
  const body = await readJson(request);
  const password = String(body.password || "");
  if (password.length < 8 || password.length > 128) {
    return sendJson(response, 400, { error: "كلمة المرور يجب أن تكون بين 8 و128 حرفًا" });
  }
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = Buffer.from(
    await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }),
  ).toString("hex");
  const result = await getPool().query(
    `UPDATE accounts SET salt = $2, password_hash = $3, updated_at = NOW()
      WHERE username = $1`,
    [username, salt, hash],
  );
  if (!result.rowCount) return sendJson(response, 404, { error: "الحساب غير موجود" });
  await getPool().query("DELETE FROM account_sessions WHERE username = $1", [username]);
  await logAudit(session.sub, "reset_password", username, { sessionsRevoked: true });
  return sendJson(response, 200, { ok: true });
}

async function revokeSessions(response, session, username) {
  const result = await getPool().query("DELETE FROM account_sessions WHERE username = $1", [username]);
  await logAudit(session.sub, "revoke_sessions", username, { count: result.rowCount });
  return sendJson(response, 200, { ok: true, count: result.rowCount });
}

async function deleteAccountItem(response, session, username, itemId, url) {
  const type = url.searchParams.get("type") === "records" ? "records" : "tasks";
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await client.query("SELECT data FROM accounts WHERE username = $1 FOR UPDATE", [username]);
    if (!result.rowCount) {
      await client.query("ROLLBACK");
      return sendJson(response, 404, { error: "الحساب غير موجود" });
    }
    const data = safeAccountData(result.rows[0].data);
    const deletedAt = new Date().toISOString();
    data.meta = data.meta && typeof data.meta === "object" ? data.meta : {};
    if (type === "tasks") {
      const before = Array.isArray(data.tasks) ? data.tasks.length : 0;
      data.tasks = (Array.isArray(data.tasks) ? data.tasks : []).filter(
        (task) => String(task?.id || "") !== itemId,
      );
      if (data.tasks.length === before) {
        await client.query("ROLLBACK");
        return sendJson(response, 404, { error: "المهمة غير موجودة" });
      }
      data.meta.taskTombstones = { ...(data.meta.taskTombstones || {}), [itemId]: deletedAt };
      data.instances = Object.fromEntries(
        Object.entries(data.instances || {}).filter(([, item]) => String(item?.taskId || "") !== itemId),
      );
    } else {
      if (!data.instances?.[itemId]) {
        await client.query("ROLLBACK");
        return sendJson(response, 404, { error: "السجل غير موجود" });
      }
      delete data.instances[itemId];
      data.meta.instanceTombstones = { ...(data.meta.instanceTombstones || {}), [itemId]: deletedAt };
    }
    const summary = summarizeData(data);
    await client.query(
      `UPDATE accounts SET data = $2::jsonb, summary = $3::jsonb, updated_at = NOW()
        WHERE username = $1`,
      [username, JSON.stringify(data), JSON.stringify(summary)],
    );
    await client.query("COMMIT");
    await logAudit(session.sub, type === "tasks" ? "delete_task" : "delete_record", username, {
      itemId,
    });
    return sendJson(response, 200, { ok: true });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function deleteAccount(response, session, username) {
  if (protectedUsernames.has(username)) {
    return sendJson(response, 403, { error: "هذا الحساب محمي ولا يمكن حذفه" });
  }
  const result = await getPool().query("DELETE FROM accounts WHERE username = $1", [username]);
  if (!result.rowCount) return sendJson(response, 404, { error: "الحساب غير موجود" });
  await logAudit(session.sub, "delete_account", username, {});
  return sendJson(response, 200, { ok: true });
}

async function listAudit(response, url) {
  const { limit, offset } = pagination(url.searchParams.get("limit"), url.searchParams.get("offset"));
  const [rows, count] = await Promise.all([
    getPool().query(
      `SELECT id, admin_username, action, target_username, details, created_at
         FROM admin_audit_log ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset],
    ),
    getPool().query("SELECT count(*)::bigint AS total FROM admin_audit_log"),
  ]);
  return sendJson(response, 200, {
    items: rows.rows,
    total: Number(count.rows[0].total),
    limit,
    offset,
  });
}

async function accountData(username) {
  const result = await getPool().query("SELECT data FROM accounts WHERE username = $1", [username]);
  return result.rowCount ? safeAccountData(result.rows[0].data) : null;
}

async function sessionCount() {
  const result = await getPool().query("SELECT count(*)::bigint AS total FROM account_sessions");
  return Number(result.rows[0].total);
}

function publicAccountRow(row) {
  return {
    username: row.username,
    name: row.name,
    email: row.email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    dataBytes: Number(row.data_bytes || 0),
  };
}

async function logAudit(adminUsername, action, targetUsername, details) {
  await getPool().query(
    `INSERT INTO admin_audit_log (admin_username, action, target_username, details)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [adminUsername, action, targetUsername || "", JSON.stringify(details || {})],
  );
}

function ensureAuditSchema() {
  if (!schemaPromise) {
    schemaPromise = getPool()
      .query(
        `CREATE TABLE IF NOT EXISTS admin_audit_log (
           id BIGSERIAL PRIMARY KEY,
           admin_username TEXT NOT NULL,
           action TEXT NOT NULL,
           target_username TEXT NOT NULL DEFAULT '',
           details JSONB NOT NULL DEFAULT '{}'::jsonb,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
         );
         CREATE INDEX IF NOT EXISTS admin_audit_log_created_at_idx
           ON admin_audit_log (created_at DESC);`,
      )
      .catch((error) => {
        schemaPromise = null;
        throw error;
      });
  }
  return schemaPromise;
}

function getPool() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL غير مضبوط");
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    const config = {
      connectionString,
      max: Math.min(10, Math.max(1, Number(process.env.PG_POOL_MAX || 4))),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    };
    if (/sslmode=require/i.test(connectionString) || /\.render\.com/i.test(connectionString)) {
      config.ssl = { rejectUnauthorized: false };
    }
    pool = new Pool(config);
    pool.on("error", (error) => console.error("Database pool error", error));
  }
  return pool;
}

function sessionResponse(session) {
  return {
    authenticated: true,
    username: session.sub,
    csrfToken: session.csrf,
    expiresAt: new Date(session.exp * 1000).toISOString(),
  };
}

function signSession(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", sessionSecret())
    .update(encoded)
    .digest("base64url");
  return `${encoded}.${signature}`;
}

function readAdminSession(request) {
  const token = parseCookies(request.headers.cookie || "")[cookieName];
  if (!token) return null;
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return null;
  const expected = crypto.createHmac("sha256", sessionSecret()).update(encoded).digest("base64url");
  if (!constantTimeEqual(signature, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    const expectedUser = String(process.env.ADMIN_USERNAME || "");
    if (
      payload.exp <= Math.floor(Date.now() / 1000) ||
      !constantTimeEqual(String(payload.sub || "").toLowerCase(), expectedUser.toLowerCase())
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function sessionSecret() {
  const secret = String(process.env.SESSION_SECRET || "");
  if (secret.length < 32) throw new Error("SESSION_SECRET يجب أن يكون 32 حرفًا على الأقل");
  return secret;
}

function setSessionCookie(request, response, token) {
  const secure = process.env.NODE_ENV === "production" || request.headers["x-forwarded-proto"] === "https";
  response.setHeader(
    "Set-Cookie",
    `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionHours * 3600}${secure ? "; Secure" : ""}`,
  );
}

function clearSessionCookie(request, response) {
  const secure = process.env.NODE_ENV === "production" || request.headers["x-forwarded-proto"] === "https";
  response.setHeader(
    "Set-Cookie",
    `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? "; Secure" : ""}`,
  );
}

function parseCookies(header) {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([key, value]) => key && value)
      .map(([key, ...value]) => [key, value.join("=")]),
  );
}

function constantTimeEqual(first, second) {
  const left = Buffer.from(String(first));
  const right = Buffer.from(String(second));
  if (left.length !== right.length) {
    crypto.timingSafeEqual(left, Buffer.alloc(left.length));
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function isRateLimited(ip) {
  const cutoff = Date.now() - 15 * 60_000;
  const attempts = (loginAttempts.get(ip) || []).filter((time) => time > cutoff);
  loginAttempts.set(ip, attempts);
  return attempts.length >= 6;
}

function recordFailure(ip) {
  loginAttempts.set(ip, [...(loginAttempts.get(ip) || []), Date.now()].slice(-6));
}

function clearFailures(ip) {
  loginAttempts.delete(ip);
}

function clientIp(request) {
  return String(request.headers["x-forwarded-for"] || request.socket.remoteAddress || "")
    .split(",")[0]
    .trim()
    .slice(0, 80);
}

function isMutation(method) {
  return ["POST", "PATCH", "PUT", "DELETE"].includes(method || "");
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 256 * 1024) throw new Error("الطلب أكبر من الحد المسموح");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("صيغة JSON غير صالحة");
  }
}

async function serveStatic(request, response, pathname) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return sendText(response, 405, "Method not allowed");
  }
  const requested = pathname === "/" ? "/index.html" : pathname;
  if (!staticFiles.has(requested)) return sendText(response, 404, "Not found");
  const filePath = path.join(rootDir, requested.slice(1));
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) return sendText(response, 404, "Not found");
  response.writeHead(200, {
    ...securityHeaders,
    "Content-Type": contentType(path.extname(filePath)),
    "Content-Length": info.size,
    "Cache-Control": requested === "/index.html" ? "no-cache" : "public, max-age=3600",
  });
  if (request.method === "HEAD") return response.end();
  createReadStream(filePath).pipe(response);
}

function contentType(extension) {
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
  }[extension] || "application/octet-stream";
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    ...securityHeaders,
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendText(response, status, value) {
  response.writeHead(status, {
    ...securityHeaders,
    "Content-Type": "text/plain; charset=utf-8",
  });
  response.end(value);
}

