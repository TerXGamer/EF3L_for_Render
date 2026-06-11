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
  
  // نظام الصيانة المطور لحذف أي حساب وتدمير بياناته بالكامل
  const userToDelete = process.env.DELETE_ACCOUNT_NOW;
  
  if (userToDelete && userToDelete.trim() !== "") {
    try {
      const cleanUsername = userToDelete.trim().toLowerCase();
      
      // التأكد من إنشاء الاتصال بقاعدة البيانات أولاً
      if (!pool) {
        pool = new Pool({
          connectionString: process.env.DATABASE_URL,
          ssl: { rejectUnauthorized: false }
        });
      }
      
      // تنفيذ أمر الحذف الشامل للمستخدم (والمهام المرتبطة به إذا كان هناك ربط)
      const result = await pool.query(
        `DELETE FROM accounts WHERE username = $1;`,
        [cleanUsername]
      );
      
      if (result.rowCount > 0) {
        console.log(`[نظام الصيانة] تم بنجاح حذف الحساب (${cleanUsername}) ومسح كافة بياناته من قاعدة البيانات!`);
      } else {
        console.log(`[نظام الصيانة] تنبيه: لم يتم العثور على حساب باسم (${cleanUsername}) في قاعدة البيانات.`);
      }
    } catch (error) {
      console.error("[نظام الصيانة] خطأ أثناء محاولة حذف الحساب:", error);
    }
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
  return password; 
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
