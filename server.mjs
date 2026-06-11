import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync } from "node:zlib";
import pg from "pg";

const { Pool } = pg;
const rootDir = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const accountPaths = new Set(["/api/account", "/.netlify/functions/account"]);
const maxBodyBytes = 8 * 1024 * 1024;

const jsonHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};

const securityHeaders = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

let pool;
let schemaReady;

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
// =========================================================
    // نظام لوحة تحكم المسؤول المصلح والمحمي بـ ADMIN_SET و ADMIN_SECRET
    // =========================================================
    if (url.pathname === "/api/admin/users") {
      if (request.method === "OPTIONS") return sendJson(response, 200, {});
      
      const secret = request.headers["x-admin-secret"];
      const adminUser = request.headers["x-admin-user"] || "";
      
      if (!secret || secret !== process.env.ADMIN_SECRET) {
        return sendJson(response, 401, { error: "رمز المسؤول السري غير صحيح أو غير متوفر!" });
      }

      // التحقق من قائمة الأسماء المسموح لها بالإشراف ADMIN_SET
      const adminSetRaw = process.env.ADMIN_SET || "";
      const adminUsersArray = adminSetRaw.split(",").map(u => u.trim().toLowerCase());
      if (!adminUsersArray.includes(adminUser.toLowerCase().trim())) {
        return sendJson(response, 403, { error: "اسم المستخدم هذا لا يملك صلاحيات إدارية في قائمة البيئة!" });
      }
      
      try {
        // جلب قائمة الحسابات من الجدول الصحيح accounts
        const result = await getPool().query("SELECT username, name, email, created_at FROM accounts ORDER BY created_at DESC");
        return sendJson(response, 200, { users: result.rows });
      } catch (err) {
        return sendJson(response, 500, { error: "فشل جلب المستخدمين من الجدول: " + err.message });
      }
    }

    if (url.pathname === "/api/admin/user-data") {
      if (request.method === "OPTIONS") return sendJson(response, 200, {});
      
      const secret = request.headers["x-admin-secret"];
      const adminUser = request.headers["x-admin-user"] || "";
      
      if (!secret || secret !== process.env.ADMIN_SECRET) {
        return sendJson(response, 401, { error: "غير مصرح لك!" });
      }

      const adminSetRaw = process.env.ADMIN_SET || "";
      const adminUsersArray = adminSetRaw.split(",").map(u => u.trim().toLowerCase());
      if (!adminUsersArray.includes(adminUser.toLowerCase().trim())) {
        return sendJson(response, 403, { error: "غير مصرح لك بالوصول!" });
      }
      
      const targetUser = url.searchParams.get("username");
      if (!targetUser) return sendJson(response, 400, { error: "اسم المستخدم مطلوب" });

      try {
        // جلب السطر كاملاً متضمناً المهام المخزنة داخل الـ JSONB في حقل data
        const userResult = await getPool().query("SELECT username, name, email, data, summary, created_at, updated_at FROM accounts WHERE LOWER(username) = $1", [targetUser.toLowerCase().trim()]);
        if (userResult.rows.length === 0) {
          return sendJson(response, 404, { error: "المستخدم المطلوبة معاينته غير موجود" });
        }
        
        return sendJson(response, 200, { userData: userResult.rows[0] });
      } catch (err) {
        return sendJson(response, 500, { error: "حدث خطأ أثناء جلب سجلات المستخدم: " + err.message });
      }
    }
    // =========================================================
    if (url.pathname === "/api/admin/users") {
      if (request.method === "OPTIONS") return sendJson(response, 200, {});
      
      const secret = request.headers["x-admin-secret"];
      if (!secret || secret !== process.env.ADMIN_SECRET) {
        return sendJson(response, 401, { error: "غير مصرح لك بدخول لوحة التحكم!" });
      }
      
      try {
        // جلب قائمة المستخدمين المسجلين مع تاريخ التسجيل
        const result = await pool.query("SELECT id, username, name, email, created_at FROM users ORDER BY created_at DESC");
        return sendJson(response, 200, { users: result.rows });
      } catch (err) {
        return sendJson(response, 500, { error: "فشل جلب المستخدمين: " + err.message });
      }
    }

    if (url.pathname === "/api/admin/user-data") {
      if (request.method === "OPTIONS") return sendJson(response, 200, {});
      
      const secret = request.headers["x-admin-secret"];
      if (!secret || secret !== process.env.ADMIN_SECRET) {
        return sendJson(response, 401, { error: "غير مصرح لك!" });
      }
      
      const targetUser = url.searchParams.get("username");
      if (!targetUser) return sendJson(response, 400, { error: "اسم المستخدم مطلوب" });

      try {
        // جلب سطر المستخدم كاملاً (بما يحتوي عليه من مهام وبيانات مزامنة)
        const userResult = await pool.query("SELECT * FROM users WHERE username = $1", [targetUser.toLowerCase().trim()]);
        if (userResult.rows.length === 0) {
          return sendJson(response, 404, { error: "المستخدم غير موجود" });
        }
        
        // جلب البيانات عند الطلب فقط (On-Demand) دون تحميل الخادم مسبقاً
        return sendJson(response, 200, { userData: userResult.rows[0] });
      } catch (err) {
        return sendJson(response, 500, { error: "حدث خطأ أثناء جلب البيانات: " + err.message });
      }
    }
    // --- [نهاية نظام المسؤول] ---
    
    if (url.pathname === "/health") {
      return sendJson(response, 200, { ok: true });
    }

    if (accountPaths.has(url.pathname)) {
      return handleAccountRequest(request, response);
    }

    if (url.pathname === "/app.js") {
      return serveBundledAppScript(request, response);
    }

    return serveStaticFile(request, response, url.pathname);
  } catch (error) {
    console.error("Request error", error);
    return sendJson(response, 500, { error: "حدث خطأ في الخادم", details: cleanText(error?.message, 240) });
  }
});

server.listen(port, "0.0.0.0", async () => {
  console.log(`Ifal Render server listening on port ${port}`);
  
  // التأكد من تهيئة الاتصال بقاعدة البيانات أولاً لنظام الصيانة الشامل
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
  }

  // [1] نظام الحذف السريع المشترك
  const usersToDeleteRaw = process.env.DELETE_ACCOUNT_NOW;
  if (usersToDeleteRaw && usersToDeleteRaw.trim() !== "") {
    try {
      const usernamesArray = usersToDeleteRaw.split(",").map(u => u.trim().toLowerCase()).filter(u => u !== "");
      for (const username of usernamesArray) {
        const result = await pool.query(`DELETE FROM accounts WHERE username = $1;`, [username]);
        if (result.rowCount > 0) console.log(`[الصيانة - حذف] تم تدمير الحساب (${username}) بالكامل.`);
        else console.log(`[الصيانة - حذف] تنبيه: الحساب (${username}) غير موجود.`);
      }
    } catch (err) { console.error("[نظام الصيانة] خطأ في الحذف:", err); }
  }

  // [2] نظام تغيير كلمة المرور (CHANGE_PASSWORD) -> username:new_password
  const changePasswordRaw = process.env.CHANGE_PASSWORD;
  if (changePasswordRaw && changePasswordRaw.trim() !== "") {
    try {
      const pairs = changePasswordRaw.split(",").map(p => p.trim()).filter(p => p.includes(":"));
      for (const pair of pairs) {
        const idx = pair.indexOf(":");
        const username = pair.substring(0, idx).trim().toLowerCase();
        const newPassword = pair.substring(idx + 1).trim();
        if (username && newPassword) {
          const newSalt = crypto.randomBytes(16).toString("hex");
          const newHash = hashPassword(newPassword, newSalt);
          const result = await pool.query(`UPDATE accounts SET salt = $1, password_hash = $2 WHERE username = $3;`, [newSalt, newHash, username]);
          if (result.rowCount > 0) console.log(`[الصيانة - كلمة المرور] نجاح: تم تحديث كلمة مرور الحساب (${username}).`);
          else console.log(`[الصيانة - كلمة المرور] تنبيه: الحساب (${username}) غير موجود.`);
        }
      }
    } catch (err) { console.error("[نظام الصيانة] خطأ في تغيير كلمة المرور:", err); }
  }

  // [3] نظام تغيير اسم المستخدم (CHANGE_USERNAME) -> old_username:new_username
  const changeUsernameRaw = process.env.CHANGE_USERNAME;
  if (changeUsernameRaw && changeUsernameRaw.trim() !== "") {
    try {
      const pairs = changeUsernameRaw.split(",").map(p => p.trim()).filter(p => p.includes(":"));
      for (const pair of pairs) {
        const idx = pair.indexOf(":");
        const oldUsername = pair.substring(0, idx).trim().toLowerCase();
        const newUsername = pair.substring(idx + 1).trim().toLowerCase();
        if (oldUsername && newUsername) {
          const check = await pool.query(`SELECT username FROM accounts WHERE username = $1;`, [newUsername]);
          if (check.rowCount > 0) {
            console.log(`[الصيانة - اسم المستخدم] خطأ: الاسم الجديد (${newUsername}) محجوز مسبقاً لحساب آخر.`);
            continue;
          }
          const result = await pool.query(`UPDATE accounts SET username = $1 WHERE username = $2;`, [newUsername, oldUsername]);
          if (result.rowCount > 0) console.log(`[الصيانة - اسم المستخدم] نجاح: تم التعديل من (${oldUsername}) إلى (${newUsername}). البيانات والمهام محفوظة كما هي.`);
          else console.log(`[الصيانة - اسم المستخدم] تنبيه: الحساب القديم (${oldUsername}) غير موجود.`);
        }
      }
    } catch (err) { console.error("[نظام الصيانة] خطأ في تغيير اسم المستخدم:", err); }
  }

  // [4] نظام تغيير الاسم العادي للمستخدم (CHANGE_NAME) -> username:new_name
  const changeNameRaw = process.env.CHANGE_NAME;
  if (changeNameRaw && changeNameRaw.trim() !== "") {
    try {
      const pairs = changeNameRaw.split(",").map(p => p.trim()).filter(p => p.includes(":"));
      for (const pair of pairs) {
        const idx = pair.indexOf(":");
        const username = pair.substring(0, idx).trim().toLowerCase();
        const newName = pair.substring(idx + 1).trim();
        if (username && newName) {
          const result = await pool.query(`UPDATE accounts SET name = $1 WHERE username = $2;`, [newName, username]);
          if (result.rowCount > 0) console.log(`[الصيانة - الاسم العادي] نجاح: تم تغيير اسم الحساب (${username}) إلى (${newName}).`);
          else console.log(`[الصيانة - الاسم العادي] تنبيه: الحساب (${username}) غير موجود.`);
        }
      }
    } catch (err) { console.error("[نظام الصيانة] خطأ في تغيير الاسم العادي:", err); }
  }

  // [5] نظام تغيير البريد الإلكتروني (CHANGE_EMAIL) -> username:new_email
  const changeEmailRaw = process.env.CHANGE_EMAIL;
  if (changeEmailRaw && changeEmailRaw.trim() !== "") {
    try {
      const pairs = changeEmailRaw.split(",").map(p => p.trim()).filter(p => p.includes(":"));
      for (const pair of pairs) {
        const idx = pair.indexOf(":");
        const username = pair.substring(0, idx).trim().toLowerCase();
        const newEmail = pair.substring(idx + 1).trim();
        if (username && newEmail) {
          const result = await pool.query(`UPDATE accounts SET email = $1 WHERE username = $2;`, [newEmail, username]);
          if (result.rowCount > 0) console.log(`[الصيانة - البريد] نجاح: تم تحديث بريد الحساب (${username}) إلى (${newEmail}).`);
          else console.log(`[الصيانة - البريد] تنبيه: الحساب (${username}) غير موجود.`);
        }
      }
    } catch (err) { console.error("[نظام الصيانة] خطأ في تغيير البريد الإلكتروني:", err); }
  }
});

async function handleAccountRequest(request, response) {
  if (request.method === "OPTIONS") {
    response.writeHead(204, jsonHeaders);
    response.end();
    return;
  }

  if (request.method !== "POST") {
    return sendJson(response, 405, { error: "Method not allowed" });
  }

  try {
    await ensureSchema();

    const body = await readJsonBody(request);
    const action = body.action;
    const username = normalizeUsername(body.username);
    const password = String(body.password || "");

    if (!username || !password) {
      return sendJson(response, 400, { error: "اسم المستخدم وكلمة المرور مطلوبة" });
    }

    const existing = await readAccount(username);

    if (action === "create") {
      if (existing) return sendJson(response, 409, { error: "اسم المستخدم موجود مسبقًا" });

      const now = new Date().toISOString();
      const account = {
        username,
        name: cleanText(body.name, 80),
        email: cleanText(body.email, 120),
        salt: "", 
        passwordHash: password, 
        data: {}, // إجبار الحساب الجديد على البدء ببيانات فارغة تماماً دون نسخ المهام القديمة
        summary: {}, // تفريغ ملخص المهام للحساب الجديد
        createdAt: now,
        updatedAt: now,
      };

      await upsertAccount(account);
      return sendJson(response, 200, publicResponse(account));
    }

    if (!existing || existing.passwordHash !== password) {
      return sendJson(response, 401, { error: "اسم المستخدم أو كلمة المرور غير صحيحة" });
    }

    if (action === "login") {
      return sendJson(response, 200, publicResponse(existing));
    }

    if (action === "save") {
      const nextData = sanitizeData(body.data, username);
      const nextSummary = buildSummary(nextData);
      const updatedAt = new Date().toISOString();
      const nextName = nextData?.user?.name ? cleanText(nextData.user.name, 80) : existing.name;
      const nextEmail = nextData?.user?.email ? cleanText(nextData.user.email, 120) : existing.email;

      await getPool().query(
        `UPDATE accounts
           SET name = $2,
               email = $3,
               data = $4::jsonb,
               summary = $5::jsonb,
               updated_at = $6
         WHERE username = $1`,
        [username, nextName, nextEmail, JSON.stringify(nextData), JSON.stringify(nextSummary), updatedAt],
      );

      return sendJson(response, 200, publicResponse({
        ...existing,
        name: nextName,
        email: nextEmail,
        data: nextData,
        summary: nextSummary,
        updatedAt,
      }));
    }

    return sendJson(response, 400, { error: "طلب غير معروف" });
  } catch (error) {
    console.error("Account API error", error);
    return sendJson(response, 500, {
      error: "حدث خطأ في خادم Render",
      details: cleanText(error?.message || error?.name || "unknown", 240),
    });
  }
}

async function serveStaticFile(request, response, pathname) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return sendText(response, 405, "Method not allowed", { Allow: "GET, HEAD" });
  }

  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  let filePath;

  try {
    const decodedPath = decodeURIComponent(requestedPath);
    filePath = path.normalize(path.join(rootDir, decodedPath));
  } catch {
    return sendText(response, 400, "Bad request");
  }

  if (!filePath.startsWith(rootDir) || filePath.includes("\0")) {
    return sendText(response, 403, "Forbidden");
  }

  let info;
  try {
    info = await stat(filePath);
  } catch {
    return sendText(response, 404, "Not found");
  }

  if (!info.isFile()) {
    return sendText(response, 404, "Not found");
  }

  const headers = {
    ...securityHeaders,
    "Content-Type": contentType(path.extname(filePath)),
    "Content-Length": info.size,
    "Cache-Control": cacheControl(filePath),
  };

  response.writeHead(200, headers);
  if (request.method === "HEAD") {
    response.end();
    return;
  }
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
  if (request.method === "HEAD") {
    response.end();
    return;
  }
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
      max: Number(process.env.PG_POOL_MAX || 5),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    };

    if (shouldUseSsl(connectionString)) {
      config.ssl = { rejectUnauthorized: false };
    }

    pool = new Pool(config);
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
    schemaReady = getPool().query(`
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
    `);
  }
  return schemaReady;
}

async function readAccount(username) {
  const result = await getPool().query(
    `SELECT username, name, email, salt, password_hash, data, summary, created_at, updated_at
       FROM accounts
      WHERE LOWER(username) = LOWER($1)`, // تم تعديل هذا السطر للمقارنة بحروف صغيرة دائماً داخل القاعدة
    [username],
  );

  if (!result.rows[0]) return null;
  return mapAccount(result.rows[0]);
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

function publicResponse(account) {
  return {
    user: {
      username: account.username,
      name: account.name,
      email: account.email,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    },
    data: account.data || null,
  };
}

function sanitizeData(data, username) {
  const safe = data && typeof data === "object" ? data : {};
  if (safe.user) {
    safe.user.username = username;
    delete safe.user.password;
  }
  return safe;
}

function buildSummary(data) {
  const safe = data && typeof data === "object" ? data : {};
  const tasks = Array.isArray(safe.tasks) ? safe.tasks : [];
  const instances = safe.instances && typeof safe.instances === "object" ? Object.values(safe.instances) : [];
  return {
    taskSettingsCount: tasks.length,
    taskRecordsCount: instances.length,
    completedCount: instances.filter((item) => item && item.status === "completed").length,
    updatedAt: new Date().toISOString(),
  };
}

async function readJsonBody(request) {
  const chunks = [];
  let total = 0;

  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBodyBytes) throw new Error("حجم الطلب أكبر من المسموح");
    chunks.push(chunk);
  }

  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function cleanText(value, max = 240) {
  return String(value || "").trim().slice(0, max);
}

function normalizeUsername(value) {
  return cleanText(value, 50).toLowerCase();
}

function hashPassword(password, salt) {
  // تشفير كلمة المرور وتحويلها إلى نص مشفر آمن لحماية الحسابات
  return crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
}

function sendJson(response, status, body) {
  response.writeHead(status, jsonHeaders);
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
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
  }[extension.toLowerCase()] || "application/octet-stream";
}

function cacheControl(filePath) {
  const name = path.basename(filePath);
  if (["index.html", "app.js", "styles.css", "sw.js"].includes(name)) {
    return "no-cache";
  }
  return "public, max-age=3600";
}
