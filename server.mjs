import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync } from "node:zlib";
import pg from "pg";
import { compactAccountData, hydrateAccountData } from "./core.mjs";

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
      return handleHealthRequest(response);
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
    return sendJson(response, 500, { error: "Ø­Ø¯Ø« Ø®Ø·Ø£ ØºÙŠØ± Ù…ØªÙˆÙ‚Ø¹ ÙÙŠ Ø§Ù„Ø®Ø§Ø¯Ù…" });
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

async function handleHealthRequest(response) {
  if (!process.env.DATABASE_URL) {
    return sendJson(response, 503, {
      ok: false,
      databaseConfigured: false,
      databaseConnected: false,
    });
  }

  try {
    await getPool().query("SELECT 1");
    return sendJson(response, 200, {
      ok: true,
      databaseConfigured: true,
      databaseConnected: true,
    });
  } catch {
    return sendJson(response, 503, {
      ok: false,
      databaseConfigured: true,
      databaseConnected: false,
    });
  }
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
    return sendJson(response, 405, { error: "Ø·Ø±ÙŠÙ‚Ø© Ø§Ù„Ø·Ù„Ø¨ ØºÙŠØ± Ù…Ø³Ù…ÙˆØ­Ø©" }, { Allow: "POST" });
  }
  if (!process.env.DATABASE_URL) {
    return sendJson(response, 503, { error: "Ù‚Ø§Ø¹Ø¯Ø© Ø§Ù„Ø¨ÙŠØ§Ù†Ø§Øª ØºÙŠØ± Ù…ØªØµÙ„Ø© ÙÙŠ Ù‡Ø°Ø§ Ø§Ù„ØªØ´ØºÙŠÙ„" });
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
      return sendJson(response, 401, { error: "Ø§Ù†ØªÙ‡Øª Ø§Ù„Ø¬Ù„Ø³Ø© Ø£Ùˆ Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ø¯Ø®ÙˆÙ„ ØºÙŠØ± ØµØ­ÙŠØ­Ø©" });
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

    return sendJson(response, 400, { error: "Ø·Ù„Ø¨ ØºÙŠØ± Ù…Ø¹Ø±ÙˆÙ" });
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
    return sendJson(response, 429, { error: "Ù…Ø­Ø§ÙˆÙ„Ø§Øª ÙƒØ«ÙŠØ±Ø©Ø› Ø§Ù†ØªØ¸Ø± Ù‚Ù„ÙŠÙ„Ù‹Ø§ Ø«Ù… Ø­Ø§ÙˆÙ„ Ù…Ø±Ø© Ø£Ø®Ø±Ù‰" });
  }

  const existing = await readAccount(username);
  if (existing) {
    recordFailedAttempt(attemptKey);
    return sendJson(response, 409, { error: "Ø§Ø³Ù… Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù… Ù…ÙˆØ¬ÙˆØ¯ Ù…Ø³Ø¨Ù‚Ù‹Ø§" });
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
    return sendJson(response, 400, { error: "Ø§Ø³Ù… Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù… ÙˆÙƒÙ„Ù…Ø© Ø§Ù„Ù…Ø±ÙˆØ± Ù…Ø·Ù„ÙˆØ¨Ø©" });
  }

  const attemptKey = requestAttemptKey(request, username);
  if (isRateLimited(attemptKey)) {
    return sendJson(response, 429, { error: "Ù…Ø­Ø§ÙˆÙ„Ø§Øª ÙƒØ«ÙŠØ±Ø©Ø› Ø§Ù†ØªØ¸Ø± Ù‚Ù„ÙŠÙ„Ù‹Ø§ Ø«Ù… Ø­Ø§ÙˆÙ„ Ù…Ø±Ø© Ø£Ø®Ø±Ù‰" });
  }

  const account = await authenticateAccount(username, password, true);
  if (!account) {
    recordFailedAttempt(attemptKey);
    return sendJson(response, 401, { error: "Ø§Ø³Ù… Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù… Ø£Ùˆ ÙƒÙ„Ù…Ø© Ø§Ù„Ù…Ø±ÙˆØ± ØºÙŠØ± ØµØ­ÙŠØ­Ø©" });
  }

  const token = await createSession(account.username);
  clearAttempts(attemptKey);
  return sendJson(response, 200, publicResponse(account, token));
}

async function changePassword(response, account, body) {
  const currentPassword = String(body.currentPassword || "");
  const newPassword = String(body.newPassword || "");
  if (!(await verifyPassword(account, currentPassword))) {
    return sendJson(response, 401, { error: "ÙƒÙ„Ù…Ø© Ø§Ù„Ù…Ø±ÙˆØ± Ø§Ù„Ø­Ø§Ù„ÙŠØ© ØºÙŠØ± ØµØ­ÙŠØ­Ø©" });
  }
  if (newPassword.length < 8 || newPassword.length > 128) {
    return sendJson(response, 400, { error: "ÙƒÙ„Ù…Ø© Ø§Ù„Ù…Ø±ÙˆØ± Ø§Ù„Ø¬Ø¯ÙŠØ¯Ø© ÙŠØ¬Ø¨ Ø£Ù† ØªÙƒÙˆÙ† Ø¨ÙŠÙ† 8 Ùˆ128 Ø­Ø±ÙÙ‹Ø§" });
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
    return sendJson(response, 405, { error: "Ø·Ø±ÙŠÙ‚Ø© Ø§Ù„Ø·Ù„Ø¨ ØºÙŠØ± Ù…Ø³Ù…ÙˆØ­Ø©" }, { Allow: "POST" });
  }
  if (!process.env.DATABASE_URL) {
    return sendJson(response, 503, { error: "Ù‚Ø§Ø¹Ø¯Ø© Ø§Ù„Ø¨ÙŠØ§Ù†Ø§Øª ØºÙŠØ± Ù…ØªØµÙ„Ø© ÙÙŠ Ù‡Ø°Ø§ Ø§Ù„ØªØ´ØºÙŠÙ„" });
  }

  try {
    await ensureSchema();
    const body = await readJsonBody(request);
    const authenticated = await authenticateRequest(request, body);
    if (!authenticated) {
      return sendJson(response, 401, { error: "Ø§Ù†ØªÙ‡Øª Ø§Ù„Ø¬Ù„Ø³Ø© Ø£Ùˆ Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ø¯Ø®ÙˆÙ„ ØºÙŠØ± ØµØ­ÙŠØ­Ø©" });
    }
    if (!isAdminUser(authenticated.account.username)) {
      return sendJson(response, 403, { error: "ØºÙŠØ± Ù…ØµØ±Ø­" });
    }

    if (body.action === "check") {
      return sendJson(response, 200, { isAdmin: true });
    }

    if (body.action === "list") {
      const result = await getPool().query(
        `SELECT username, name, email, summary, created_at, updated_at
           FROM accounts
          ORDER BY LOWER(username) ASC`,
      );
      return sendJson(response, 200, {
        users: result.rows.map((row) => adminUserSummary(row)),
      });
    }

    if (body.action === "reveal") {
      const targetUsername = normalizeUsername(body.targetUsername);
      if (!targetUsername) {
        return sendJson(response, 400, { error: "Ø§Ø³Ù… Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù… Ø§Ù„Ù…Ø·Ù„ÙˆØ¨ Ø¥Ø¯Ø§Ø±ØªÙ‡ ØºÙŠØ± ØµØ§Ù„Ø­" });
      }
      const target = await readAccount(targetUsername);
      if (!target) return sendJson(response, 404, { error: "Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù… ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯" });
      const { monthStart, monthEnd, monthLabel } = currentMonthRange();
      return sendJson(response, 200, buildAdminRevealReport(target, monthStart, monthEnd, monthLabel));
    }

    if (body.action === "update-user") {
      const targetUsername = normalizeUsername(body.targetUsername);
      const target = targetUsername ? await readAccount(targetUsername) : null;
      if (!target) return sendJson(response, 404, { error: "Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù… ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯" });

      const name = cleanText(body.name, 80);
      const email = cleanText(body.email, 120).toLocaleLowerCase("en-US");
      if (!name) return sendJson(response, 400, { error: "Ø§Ø³Ù… Ø§Ù„Ø­Ø³Ø§Ø¨ Ù…Ø·Ù„ÙˆØ¨" });
      if (!isValidEmail(email)) {
        return sendJson(response, 400, { error: "Ø§Ù„Ø¨Ø±ÙŠØ¯ Ø§Ù„Ø¥Ù„ÙƒØªØ±ÙˆÙ†ÙŠ ØºÙŠØ± ØµØ§Ù„Ø­" });
      }

      const nextData =
        target.data && typeof target.data === "object" && !Array.isArray(target.data)
          ? structuredClone(target.data)
          : {};
      nextData.user = {
        ...(nextData.user && typeof nextData.user === "object" ? nextData.user : {}),
        username: target.username,
        name,
        email,
      };

      const result = await getPool().query(
        `UPDATE accounts
            SET name = $2, email = $3, data = $4::jsonb, updated_at = NOW()
          WHERE username = $1
          RETURNING username, name, email, summary, created_at, updated_at`,
        [target.username, name, email, JSON.stringify(nextData)],
      );
      logAdminAction(authenticated.account.username, "ØªØ¹Ø¯ÙŠÙ„ Ø§Ù„Ø­Ø³Ø§Ø¨", target.username);
      return sendJson(response, 200, {
        ok: true,
        user: adminUserSummary(result.rows[0]),
      });
    }

    if (body.action === "reset-password") {
      const targetUsername = normalizeUsername(body.targetUsername);
      const newPassword = String(body.newPassword || "");
      if (!targetUsername || !(await readAccount(targetUsername))) {
        return sendJson(response, 404, { error: "Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù… ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯" });
      }
      if (targetUsername === normalizeUsername(authenticated.account.username)) {
        return sendJson(response, 400, {
          error: "ØºÙŠÙ‘Ø± ÙƒÙ„Ù…Ø© Ù…Ø±ÙˆØ± Ø­Ø³Ø§Ø¨ Ø§Ù„Ù…Ø¯ÙŠØ± Ù…Ù† ØµÙØ­Ø© Ø­Ø³Ø§Ø¨ÙŠ",
        });
      }
      if (newPassword.length < 8 || newPassword.length > 128) {
        return sendJson(response, 400, {
          error: "ÙƒÙ„Ù…Ø© Ø§Ù„Ù…Ø±ÙˆØ± Ø§Ù„Ø¬Ø¯ÙŠØ¯Ø© ÙŠØ¬Ø¨ Ø£Ù† ØªÙƒÙˆÙ† Ø¨ÙŠÙ† 8 Ùˆ128 Ø­Ø±ÙÙ‹Ø§",
        });
      }

      const salt = crypto.randomBytes(16).toString("hex");
      const passwordHash = await hashPassword(newPassword, salt);
      const client = await getPool().connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `UPDATE accoußÍ7¶‰Ëkºwµçt°(€€¤ì(€É•ÑÕÉ¸ÉÉ…ä¹™É½´¡µ…À¹Ù…±Õ•Ì ¤¤ì)ô()™Õ¹Ñ¥½¸µ•É•Q¥µ•ÍÑ…µÁ5…ÁÌ¡™¥ÉÍĞ°Í•½¹¤ì(€½¹ÍĞµ•É•€ôì€¸¸¸¡™¥ÉÍĞñğíô¤ôì(€=‰©•Ğ¹•¹ÑÉ¥•Ì¡Í•½¹ñğíô¤¹™½É…  ¡m¥°Ù…±Õ•t¤€ôøì(€€€µ•É•‘m¥‘t€ô±…Ñ•ÍÑQ¥µ•ÍÑ…µÀ¡µ•É•‘m¥‘t°Ù…±Õ”¤ì(€ô¤ì(€É•ÑÕÉ¸µ•É•ì)ô()™Õ¹Ñ¥½¸±…Ñ•ÍÑQ¥µ•ÍÑ…µÀ¡™¥ÉÍĞ°Í•½¹¤ì(€¥˜€ …™¥ÉÍĞ¤É•ÑÕÉ¸Í•½¹ñğ¹Õ±°ì(€¥˜€ …Í•½¹¤É•ÑÕÉ¸™¥ÉÍĞì(€É•ÑÕÉ¸¹•Ü…Ñ”¡™¥ÉÍĞ¤¹•ÑQ¥µ” ¤€øô¹•Ü…Ñ”¡Í•½¹¤¹•ÑQ¥µ” ¤€ü™¥ÉÍĞ€èÍ•½¹ì)ô()™Õ¹Ñ¥½¸¥Í™Ñ•ÉQ½µ‰ÍÑ½¹”¡ÕÁ‘…Ñ•‘Ğ°‘•±•Ñ•‘Ğ¤ì(€¥˜€ …‘•±•Ñ•‘Ğ¤É•ÑÕÉ¸ÑÉÕ”ì(€É•ÑÕÉ¸¹•Ü…Ñ”¡ÕÁ‘…Ñ•‘Ğñğ€À¤¹•ÑQ¥µ” ¤€ø¹•Ü…Ñ”¡‘•±•Ñ•‘Ğ¤¹•ÑQ¥µ” ¤ì)ô()™Õ¹Ñ¥½¸Õ¹¥ÅÕ•MÑÉ¥¹Ì¡™¥ÉÍĞ°Í•½¹¤ì(€É•ÑÕÉ¸ÉÉ…ä¹™É½´ (€€€¹•ÜM•Ğ¡l¸¸¸¡ÉÉ…ä¹¥ÍÉÉ…ä¡™¥ÉÍĞ¤€ü™¥ÉÍĞ€èmt¤°€¸¸¸¡ÉÉ…ä¹¥ÍÉÉ…ä¡Í•½¹¤€üÍ•½¹€èmt¥t¤°(€€¤¹Í±¥” ´ÔÁ|ÀÀÀ¤ì)ô()™Õ¹Ñ¥½¸Í…¹¥Ñ¥é•…Ñ„¡‘…Ñ„°ÕÍ•É¹…µ”¤ì(€¥˜€ …‘…Ñ„ñğÑåÁ•½˜‘…Ñ„€„ôô€‰½‰©•ĞˆñğÉÉ…ä¹¥ÍÉÉ…ä¡‘…Ñ„¤¤É•ÑÕÉ¸íôì(€½¹ÍĞÍ…™”€ôÍÑÉÕÑÕÉ•‘±½¹”¡‘…Ñ„¤ì(€¥˜€¡Í…™”¹ÕÍ•È€˜˜ÑåÁ•½˜Í…™”¹ÕÍ•È€ôôô€‰½‰©•Ğˆ¤ì(€€€Í…™”¹ÕÍ•È€ôì(€€€€€¹…µ”è±•…¹Q•áĞ¡Í…™”¹ÕÍ•È¹¹…µ”°€àÀ¤°(€€€€€•µ…¥°è±•…¹Q•áĞ¡Í…™”¹ÕÍ•È¹•µ…¥°°€ÄÈÀ¤°(€€€€€ÕÍ•É¹…µ”è¹½Éµ…±¥é•UÍ•É¹…µ”¡ÕÍ•É¹…µ”ñğÍ…™”¹ÕÍ•È¹ÕÍ•É¹…µ”¤°(€€€€€±½•‘%¹Ğè±•…¹Q•áĞ¡Í…™”¹ÕÍ•È¹±½•‘%¹Ğ°€ĞÀ¤°(€€€ôì(€ô(€Í…™”¹Ñ…Í­Ì€ô€¡ÉÉ…ä¹¥ÍÉÉ…ä¡Í…™”¹Ñ…Í­Ì¤€üÍ…™”¹Ñ…Í­Ì€èmt¤¹Í±¥” À°€ÄÀÀÀ¤ì(€Í…™”¹¥¹ÍÑ…¹•Ì€ô=‰©•Ğ¹™É½µ¹ÑÉ¥•Ì (€€€=‰©•Ğ¹•¹ÑÉ¥•Ì (€€€€€Í…™”¹¥¹ÍÑ…¹•Ì€˜˜ÑåÁ•½˜Í…™”¹¥¹ÍÑ…¹•Ì€ôôô€‰½‰©•Ğˆ€˜˜€…ÉÉ…ä¹¥ÍÉÉ…ä¡Í…™”¹¥¹ÍÑ…¹•Ì¤(€€€€€€€€üÍ…™”¹¥¹ÍÑ…¹•Ì(€€€€€€€€èíô°(€€€€¤(€€€€€€¹™¥±Ñ•È ¡m¥°¥Ñ•µt¤€ôø±•…¹%¡¥¤€˜˜¥Ñ•´€˜˜ÑåÁ•½˜¥Ñ•´€ôôô€‰½‰©•Ğˆ¤(€€€€€€¹Í±¥” ´ÔÁ|ÀÀÀ¤°(€€¤ì(€Í…™”¹Í•ÑÑ¥¹Ì€ôÍ…™”¹Í•ÑÑ¥¹Ì€˜˜ÑåÁ•½˜Í…™”¹Í•ÑÑ¥¹Ì€ôôô€‰½‰©•Ğˆ€üÍ…™”¹Í•ÑÑ¥¹Ì€èíôì(€Í…™”¹Í•ÑÑ¥¹Ì¹Í¹…ÁÍ¡½ÑÌ€ô€¡ÉÉ…ä¹¥ÍÉÉ…ä¡Í…™”¹Í•ÑÑ¥¹Ì¹Í¹…ÁÍ¡½ÑÌ¤(€€€€üÍ…™”¹Í•ÑÑ¥¹Ì¹Í¹…ÁÍ¡½ÑÌ(€€€€èmt(€€¤¹Í±¥” À°€ÌÀ¤ì(€Í…™”¹µ•Ñ„€ôÍ…™”¹µ•Ñ„€˜˜ÑåÁ•½˜Í…™”¹µ•Ñ„€ôôô€‰½‰©•Ğˆ€üÍ…™”¹µ•Ñ„€èíôì(€Í…™”¹µ•Ñ„¹Ñ…Í­Q½µ‰ÍÑ½¹•Ì€ôÍ…¹¥Ñ¥é•Q¥µ•ÍÑ…µÁ5…À¡Í…™”¹µ•Ñ„¹Ñ…Í­Q½µ‰ÍÑ½¹•Ì¤ì(€Í…™”¹µ•Ñ„¹¥¹ÍÑ…¹•Q½µ‰ÍÑ½¹•Ì€ôÍ…¹¥Ñ¥é•Q¥µ•ÍÑ…µÁ5…À¡Í…™”¹µ•Ñ„¹¥¹ÍÑ…¹•Q½µ‰ÍÑ½¹•Ì¤ì(€‘•±•Ñ”Í…™”¹¥µÁ½ÉÑÌì(€É•ÑÕÉ¸Í…™”ì)ô()™Õ¹Ñ¥½¸Í…¹¥Ñ¥é•Q¥µ•ÍÑ…µÁ5…À¡Ù…±Õ”¤ì(€É•ÑÕÉ¸=‰©•Ğ¹™É½µ¹ÑÉ¥•Ì (€€€=‰©•Ğ¹•¹ÑÉ¥•Ì¡Ù…±Õ”€˜˜ÑåÁ•½˜Ù…±Õ”€ôôô€‰½‰©•Ğˆ€üÙ…±Õ”€èíô¤(€€€€€€¹™¥±Ñ•È (€€€€€€€€¡m¥°Ñ¥µ•ÍÑ…µÁt¤€ôø(€€€€€€€€€±•…¹%¡¥¤€˜˜9Õµ‰•È¹¥Í¥¹¥Ñ”¡¹•Ü…Ñ”¡MÑÉ¥¹œ¡Ñ¥µ•ÍÑ…µÀñğ€ˆˆ¤¤¹•ÑQ¥µ” ¤¤°(€€€€€€¤(€€€€€€¹Í±¥” ´ÔÁ|ÀÀÀ¤°(€€¤ì)ô()™Õ¹Ñ¥½¸‰Õ¥±‘MÕµµ…Éä¡‘…Ñ„¤ì(€½¹ÍĞÑ…Í­Ì€ôÉÉ…ä¹¥ÍÉÉ…ä¡‘…Ñ„ü¹Ñ…Í­Ì¤€ü‘…Ñ„¹Ñ…Í­Ì€èmtì(€½¹ÍĞ¥¹ÍÑ…¹•Ì€ô(€€€‘…Ñ„ü¹¥¹ÍÑ…¹•Ì€˜˜ÑåÁ•½˜‘…Ñ„¹¥¹ÍÑ…¹•Ì€ôôô€‰½‰©•Ğˆ€ü=‰©•Ğ¹Ù…±Õ•Ì¡‘…Ñ„¹¥¹ÍÑ…¹•Ì¤€èmtì(€É•ÑÕÉ¸ì(€€€Ñ…Í­M•ÑÑ¥¹Í½Õ¹ĞèÑ…Í­Ì¹±•¹Ñ °(€€€Ñ…Í­I•½É‘Í½Õ¹Ğè¥¹ÍÑ…¹•Ì¹±•¹Ñ °(€€€½µÁ±•Ñ•‘½Õ¹Ğè¥¹ÍÑ…¹•Ì¹™¥±Ñ•È ¡¥Ñ•´¤€ôø¥Ñ•´ü¹ÍÑ…ÑÕÌ€ôôô€‰½µÁ±•Ñ•ˆ¤¹±•¹Ñ °(€€€ÕÁ‘…Ñ•‘Ğè¹•Ü…Ñ” ¤¹Ñ½%M=MÑÉ¥¹œ ¤°(€ôì)ô()™Õ¹Ñ¥½¸Ù…±¥‘…Ñ•9•İ½Õ¹Ğ¡ìÕÍ•É¹…µ”°Á…ÍÍİ½É°¹…µ”°•µ…¥°ô¤ì(€¥˜€ „½ymqÁí1õqÁí9ô¹|µuìÌ°ÔÁô½Ô¹Ñ•ÍĞ¡ÕÍ•É¹…µ”¤¤ì(€€€É•ÑÕÉ¸€‹bŸbÏfƒbŸffbÏb«b»b¿fƒf+b³b ƒbfƒf+ff#fƒff€Ìƒb—ff$€ÔÀƒb·bÇff/bœƒb¿f#fƒfbÏbŸfbŸb¨ˆì(€ô(€¥˜€¡Á…ÍÍİ½É¹±•¹Ñ €ğ€àñğÁ…ÍÍİ½É¹±•¹Ñ €ø€ÄÈà¤ì(€€€É•ÑÕÉ¸€‹fffb¤ƒbŸffbÇf#bÄƒf+b³b ƒbfƒb«ff#fƒb£f+f€àƒf ÄÈàƒb·bÇff/bœˆì(€ô(€¥˜€ …¹…µ”¤É•ÑÕÉ¸€‹bŸfbŸbÏfƒfbßff#b ˆì(€¥˜€ …¥ÍY…±¥‘µ…¥°¡•µ…¥°¤¤É•ÑÕÉ¸€‹bŸfb£bÇf+b¼ƒbŸfb—ffb«bÇf#ff(ƒbëf+bÄƒb×bŸfb´ˆì(€É•ÑÕÉ¸€ˆˆì)ô()™Õ¹Ñ¥½¸¥ÍY…±¥‘µ…¥°¡Ù…±Õ”¤ì(€É•ÑÕÉ¸€½ymyqÍt­myqÍt­p¹myqÍt¬¼¹Ñ•ÍĞ¡±•…¹Q•áĞ¡Ù…±Õ”°€ÄÈÀ¤¤ì)ô()™Õ¹Ñ¥½¸É•ÅÕ•ÍÑÑÑ•µÁÑ-•ä¡É•ÅÕ•ÍĞ°ÕÍ•É¹…µ”¤ì(€½¹ÍĞ™½Éİ…É‘•€ôMÑÉ¥¹œ¡É•ÅÕ•ÍĞ¹¡•…‘•ÉÍl‰àµ™½Éİ…É‘•µ™½È‰tñğ€ˆˆ¤¹ÍÁ±¥Ğ ˆ°ˆ¥lÁt¹ÑÉ¥´ ¤ì(€É•ÑÕÉ¸€‘í™½Éİ…É‘•ñğÉ•ÅÕ•ÍĞ¹Í½­•Ğ¹É•µ½Ñ•‘‘É•ÍÌñğ€‰Õ¹­¹½İ¸‰ôè‘íÕÍ•É¹…µ•õ€ì)ô()™Õ¹Ñ¥½¸¥ÍI…Ñ•1¥µ¥Ñ•¡­•ä¤ì(€½¹ÍĞÕÑ½™˜€ô…Ñ”¹¹½Ü ¤€´€ÄÔ€¨€ØÁ|ÀÀÀì(€½¹ÍĞ…ÑÑ•µÁÑÌ€ô€¡±½¥¹ÑÑ•µÁÑÌ¹•Ğ¡­•ä¤ñğmt¤¹™¥±Ñ•È ¡Ñ¥µ”¤€ôøÑ¥µ”€øôÕÑ½™˜¤ì(€¥˜€¡…ÑÑ•µÁÑÌ¹±•¹Ñ ¤±½¥¹ÑÑ•µÁÑÌ¹Í•Ğ¡­•ä°…ÑÑ•µÁÑÌ¤ì(€É•ÑÕÉ¸…ÑÑ•µÁÑÌ¹±•¹Ñ €øô€àì)ô()™Õ¹Ñ¥½¸É•½É‘…¥±•‘ÑÑ•µÁĞ¡­•ä¤ì(€½¹ÍĞ…ÑÑ•µÁÑÌ€ô±½¥¹ÑÑ•µÁÑÌ¹•Ğ¡­•ä¤ñğmtì(€…ÑÑ•µÁÑÌ¹ÁÕÍ ¡…Ñ”¹¹½Ü ¤¤ì(€±½¥¹ÑÑ•µÁÑÌ¹Í•Ğ¡­•ä°…ÑÑ•µÁÑÌ¹Í±¥” ´à¤¤ì)ô()™Õ¹Ñ¥½¸±•…ÉÑÑ•µÁÑÌ¡­•ä¤ì(€±½¥¹ÑÑ•µÁÑÌ¹‘•±•Ñ”¡­•ä¤ì)ô()…Íå¹Œ™Õ¹Ñ¥½¸Í•ÉÙ•MÑ…Ñ¥¥±”¡É•ÅÕ•ÍĞ°É•ÍÁ½¹Í”°Á…Ñ¡¹…µ”¤ì(€¥˜€¡É•ÅÕ•ÍĞ¹µ•Ñ¡½€„ôô€‰Pˆ€˜˜É•ÅÕ•ÍĞ¹µ•Ñ¡½€„ôô€‰!ˆ¤ì(€€€É•ÑÕÉ¸Í•¹‘Q•áĞ¡É•ÍÁ½¹Í”°€ĞÀÔ°€‰5•Ñ¡½¹½Ğ…±±½İ•ˆ°ì±±½Üè€‰P°!ˆô¤ì(€ô((€½¹ÍĞÉ•ÅÕ•ÍÑ•‘A…Ñ €ôÁ…Ñ¡¹…µ”€ôôô€ˆ¼ˆ€ü€ˆ½¥¹‘•à¹¡Ñµ°ˆ€èÁ…Ñ¡¹…µ”ì(€¥˜€ …ÁÕ‰±¥¥±•Ì¹¡…Ì¡É•ÅÕ•ÍÑ•‘A…Ñ ¤¤É•ÑÕÉ¸Í•¹‘Q•áĞ¡É•ÍÁ½¹Í”°€ĞÀĞ°€‰9½Ğ™½Õ¹ˆ¤ì(€½¹ÍĞ™¥±•A…Ñ €ôÁ…Ñ ¹©½¥¸¡É½½Ñ¥È°É•ÅÕ•ÍÑ•‘A…Ñ ¹Í±¥” Ä¤¤ì(€½¹ÍĞÉ•±…Ñ¥Ù”€ôÁ…Ñ ¹É•±…Ñ¥Ù”¡É½½Ñ¥È°™¥±•A…Ñ ¤ì(€¥˜€¡É•±…Ñ¥Ù”¹ÍÑ…ÉÑÍ]¥Ñ  ˆ¸¸ˆ¤ñğÁ…Ñ ¹¥Í‰Í½±ÕÑ”¡É•±…Ñ¥Ù”¤¤ì(€€€É•ÑÕÉ¸Í•¹‘Q•áĞ¡É•ÍÁ½¹Í”°€ĞÀÌ°€‰½É‰¥‘‘•¸ˆ¤ì(€ô((€±•Ğ¥¹™¼ì(€ÑÉäì(€€€¥¹™¼€ô…İ…¥ĞÍÑ…Ğ¡™¥±•A…Ñ ¤ì(€ô…Ñ ì(€€€É•ÑÕÉ¸Í•¹‘Q•áĞ¡É•ÍÁ½¹Í”°€ĞÀĞ°€‰9½Ğ™½Õ¹ˆ¤ì(€ô(€¥˜€ …¥¹™¼¹¥Í¥±” ¤¤É•ÑÕÉ¸Í•¹‘Q•áĞ¡É•ÍÁ½¹Í”°€ĞÀĞ°€‰9½Ğ™½Õ¹ˆ¤ì((€É•ÍÁ½¹Í”¹İÉ¥Ñ•!•… ÈÀÀ°ì(€€€€¸¸¹Í•ÕÉ¥Ñå!•…‘•ÉÌ°(€€€€‰½¹Ñ•¹ĞµQåÁ”ˆè½¹Ñ•¹ÑQåÁ”¡Á…Ñ ¹•áÑ¹…µ”¡™¥±•A…Ñ ¤¤°(€€€€‰½¹Ñ•¹Ğµ1•¹Ñ ˆè¥¹™¼¹Í¥é”°(€€€€‰…¡”µ½¹ÑÉ½°ˆè…¡•½¹ÑÉ½°¡™¥±•A…Ñ ¤°(€ô¤ì(€¥˜€¡É•ÅÕ•ÍĞ¹µ•Ñ¡½€ôôô€‰!ˆ¤É•ÑÕÉ¸É•ÍÁ½¹Í”¹•¹ ¤ì(€É•…Ñ•I•…‘MÑÉ•…´¡™¥±•A…Ñ ¤¹Á¥Á”¡É•ÍÁ½¹Í”¤ì)ô()…Íå¹Œ™Õ¹Ñ¥½¸Í•ÉÙ•	Õ¹‘±•‘ÁÁMÉ¥ÁĞ¡É•ÅÕ•ÍĞ°É•ÍÁ½¹Í”¤ì(€¥˜€¡É•ÅÕ•ÍĞ¹µ•Ñ¡½€„ôô€‰Pˆ€˜˜É•ÅÕ•ÍĞ¹µ•Ñ¡½€„ôô€‰!ˆ¤ì(€€€É•ÑÕÉ¸Í•¹‘Q•áĞ¡É•ÍÁ½¹Í”°€ĞÀÔ°€‰5•Ñ¡½¹½Ğ…±±½İ•ˆ°ì±±½Üè€‰P°!ˆô¤ì(€ô(€½¹ÍĞ•¹½‘•€ô…İ…¥ĞÉ•…‘¥±”¡Á…Ñ ¹©½¥¸¡É½½Ñ¥È°€‰…ÁÀ¹©Ì¹‰È¹ˆØĞˆ¤°€‰ÕÑ˜àˆ¤ì(€½¹ÍĞ½¹Ñ•¹Ğ€ô‰É½Ñ±¥•½µÁÉ•ÍÍMå¹Œ¡	Õ™™•È¹™É½´¡•¹½‘•¹É•Á±…” ½qÌ¬½œ°€ˆˆ¤°€‰‰…Í”ØĞˆ¤¤ì(€É•ÍÁ½¹Í”¹İÉ¥Ñ•!•… ÈÀÀ°ì(€€€€¸¸¹Í•ÕÉ¥Ñå!•…‘•ÉÌ°(€€€€‰½¹Ñ•¹ĞµQåÁ”ˆè€‰Ñ•áĞ½©…Ù…ÍÉ¥ÁĞì¡…ÉÍ•ĞõÕÑ˜´àˆ°(€€€€‰½¹Ñ•¹Ğµ1•¹Ñ ˆè½¹Ñ•¹Ğ¹±•¹Ñ °(€€€€‰…¡”µ½¹ÑÉ½°ˆè€‰¹¼µ…¡”ˆ°(€ô¤ì(€¥˜€¡É•ÅÕ•ÍĞ¹µ•Ñ¡½€ôôô€‰!ˆ¤É•ÑÕÉ¸É•ÍÁ½¹Í”¹•¹ ¤ì(€É•ÍÁ½¹Í”¹•¹¡½¹Ñ•¹Ğ¤ì)ô()™Õ¹Ñ¥½¸•ÑA½½° ¤ì(€¥˜€ …ÁÉ½•ÍÌ¹•¹Ø¹Q	M}UI0¤ì(€€€Ñ¡É½Ü¹•ÜÉÉ½È ‰Q	M}UI0ƒbëf+bÄƒff#b³f#b¼¸ƒbŸbÇb£bÜƒfbŸbçb¿b¤I•¹‘•ÈA½ÍÑÉ•ME0ƒb£bŸfb»b¿fb¤¸ˆ¤ì(€ô(€¥˜€ …Á½½°¤ì(€€€½¹ÍĞ½¹¹•Ñ¥½¹MÑÉ¥¹œ€ôÁÉ½•ÍÌ¹•¹Ø¹Q	M}UI0ì(€€€½¹ÍĞ½¹™¥œ€ôì(€€€€€½¹¹•Ñ¥½¹MÑÉ¥¹œ°(€€€€€µ…àè5…Ñ ¹µ¥¸ ÈÀ°5…Ñ ¹µ…à Ä°9Õµ‰•È¡ÁÉ½•ÍÌ¹•¹Ø¹A}A==1}5`ñğ€Ô¤¤¤°(€€€€€¥‘±•Q¥µ•½ÕÑ5¥±±¥Ìè€ÌÁ|ÀÀÀ°(€€€€€½¹¹•Ñ¥½¹Q¥µ•½ÕÑ5¥±±¥Ìè€ÄÁ|ÀÀÀ°(€€€ôì(€€€¥˜€¡Í¡½Õ±‘UÍ•MÍ°¡½¹¹•Ñ¥½¹MÑÉ¥¹œ¤¤½¹™¥œ¹ÍÍ°€ôìÉ•©•ÑU¹…ÕÑ¡½É¥é•è™…±Í”ôì(€€€Á½½°€ô¹•ÜA½½°¡½¹™¥œ¤ì(€€€Á½½°¹½¸ ‰•ÉÉ½Èˆ°€¡•ÉÉ½È¤€ôø½¹Í½±”¹•ÉÉ½È ‰…Ñ…‰…Í”Á½½°•ÉÉ½Èˆ°•ÉÉ½È¤¤ì(€ô(€É•ÑÕÉ¸Á½½°ì)ô()™Õ¹Ñ¥½¸Í¡½Õ±‘UÍ•MÍ°¡½¹¹•Ñ¥½¹MÑÉ¥¹œ¤ì(€¥˜€¡ÁÉ½•ÍÌ¹•¹Ø¹Q	M}MM0¤ì(€€€É•ÑÕÉ¸€½x ÅñÑÉÕ•ñå•ÍñÉ•ÅÕ¥É•¤½¤¹Ñ•ÍĞ¡ÁÉ½•ÍÌ¹•¹Ø¹Q	M}MM0¤ì(€ô(€É•ÑÕÉ¸€½ÍÍ±µ½‘”õÉ•ÅÕ¥É”½¤¹Ñ•ÍĞ¡½¹¹•Ñ¥½¹MÑÉ¥¹œ¤ñğ€½p¹É•¹‘•Ép¹½´½¤¹Ñ•ÍĞ¡½¹¹•Ñ¥½¹MÑÉ¥¹œ¤ì)ô()™Õ¹Ñ¥½¸•¹ÍÕÉ•M¡•µ„ ¤ì(€¥˜€ …Í¡•µ…I•…‘ä¤ì(€€€Í¡•µ…I•…‘ä€ô•ÑA½½° ¤(€€€€€€¹ÅÕ•Éä¡€(€€€€€€€IQQ	1%9=Pa%MQL…½Õ¹ÑÌ€ (€€€€€€€€€ÕÍ•É¹…µ”QaPAI%5Id-d°(€€€€€€€€€¹…µ”QaP9=P9U10U1P€œœ°(€€€€€€€€€•µ…¥°QaP9=P9U10U1P€œœ°(€€€€€€€€€Í…±ĞQaP9=P9U10°(€€€€€€€€€Á…ÍÍİ½É‘}¡…Í QaP9=P9U10°(€€€€€€€€€‘…Ñ„)M=99=P9U10U1P€íôœèé©Í½¹ˆ°(€€€€€€€€€ÍÕµµ…Éä)M=99=P9U10U1P€íôœèé©Í½¹ˆ°(€€€€€€€€€É•…Ñ•‘}…ĞQ%5MQ5AQh9=P9U10U1P9=\ ¤°(€€€€€€€€€ÕÁ‘…Ñ•‘}…ĞQ%5MQ5AQh9=P9U10U1P9=\ ¤(€€€€€€€€¤ì((€€€€€€€IQQ	1%9=Pa%MQL…½Õ¹Ñ}Í•ÍÍ¥½¹Ì€ (€€€€€€€€€Ñ½­•¹}¡…Í QaPAI%5Id-d°(€€€€€€€€€ÕÍ•É¹…µ”QaP9=P9U10II9L…½Õ¹ÑÌ¡ÕÍ•É¹…µ”¤=81QM=8UAQM°(€€€€€€€€€•áÁ¥É•Í}…ĞQ%5MQ5AQh9=P9U10°(€€€€€€€€€É•…Ñ•‘}…ĞQ%5MQ5AQh9=P9U10U1P9=\ ¤°(€€€€€€€€€±…ÍÑ}ÕÍ•‘}…ĞQ%5MQ5AQh9=P9U10U1P9=\ ¤(€€€€€€€€¤ì((€€€€€€€IQ%9`%9=Pa%MQL…½Õ¹Ñ}Í•ÍÍ¥½¹Í}ÕÍ•É¹…µ•}¥‘à=8…½Õ¹Ñ}Í•ÍÍ¥½¹Ì¡ÕÍ•É¹…µ”¤ì(€€€€€€€IQ%9`%9=Pa%MQL…½Õ¹Ñ}Í•ÍÍ¥½¹Í}•áÁ¥Éå}¥‘à=8…½Õ¹Ñ}Í•ÍÍ¥½¹Ì¡•áÁ¥É•Í}…Ğ¤ì(€€€€€€¤(€€€€€€¹…Ñ  ¡•ÉÉ½È¤€ôøì(€€€€€€€Í¡•µ…I•…‘ä€ô¹Õ±°ì(€€€€€€€Ñ¡É½Ü•ÉÉ½Èì(€€€€€ô¤ì(€ô(€É•ÑÕÉ¸Í¡•µ…I•…‘äì)ô()…Íå¹Œ™Õ¹Ñ¥½¸É•…‘½Õ¹Ğ¡ÕÍ•É¹…µ”¤ì(€½¹ÍĞÉ•ÍÕ±Ğ€ô…İ…¥Ğ•ÑA½½° ¤¹ÅÕ•Éä (€€€M1PÕÍ•É¹…µ”°¹…µ”°•µ…¥°°Í…±Ğ°Á…ÍÍİ½É‘}¡…Í °‘…Ñ„°ÍÕµµ…Éä°É•…Ñ•‘}…Ğ°ÕÁ‘…Ñ•‘}…Ğ(€€€€€€I=4…½Õ¹ÑÌ(€€€€€]!IÕÍ•É¹…µ”€ô€Å€°(€€€m¹½Éµ…±¥é•UÍ•É¹…µ”¡ÕÍ•É¹…µ”¥t°(€€¤ì(€É•ÑÕÉ¸É•ÍÕ±Ğ¹É½İÍlÁt€üµ…Á½Õ¹Ğ¡É•ÍÕ±Ğ¹É½İÍlÁt¤€è¹Õ±°ì)ô()…Íå¹Œ™Õ¹Ñ¥½¸ÕÁÍ•ÉÑ½Õ¹Ğ¡…½Õ¹Ğ¤ì(€…İ…¥Ğ•ÑA½½° ¤¹ÅÕ•Éä (€€€%9MIP%9Q<…½Õ¹ÑÌ€ (€€€€€€ÕÍ•É¹…µ”°¹…µ”°•µ…¥°°Í…±Ğ°Á…ÍÍİ½É‘}¡…Í °‘…Ñ„°ÍÕµµ…Éä°É•…Ñ•‘}…Ğ°ÕÁ‘…Ñ•‘}…Ğ(€€€€€¤Y1UL€ Ä°€È°€Ì°€Ğ°€Ô°€Øèé©Í½¹ˆ°€Üèé©Í½¹ˆ°€à°€ä¤(€€€€=8=91%P€¡ÕÍ•É¹…µ”¤<UAQMP(€€€€€€¹…µ”€ôa1U¹¹…µ”°(€€€€€€•µ…¥°€ôa1U¹•µ…¥°°(€€€€€€Í…±Ğ€ôa1U¹Í…±Ğ°(€€€€€€Á…ÍÍİ½É‘}¡…Í €ôa1U¹Á…ÍÍİ½É‘}¡…Í °(€€€€€€‘…Ñ„€ôa1U¹‘…Ñ„°(€€€€€€ÍÕµµ…Éä€ôa1U¹ÍÕµµ…Éä°(€€€€€€ÕÁ‘…Ñ•‘}…Ğ€ôa1U¹ÕÁ‘…Ñ•‘}…Ñ€°(€€€l(€€€€€…½Õ¹Ğ¹ÕÍ•É¹…µ”°(€€€€€…½Õ¹Ğ¹¹…µ”°(€€€€€…½Õ¹Ğ¹•µ…¥°°(€€€€€…½Õ¹Ğ¹Í…±Ğ°(€€€€€…½Õ¹Ğ¹Á…ÍÍİ½É‘!…Í °(€€€€€)M=8¹ÍÑÉ¥¹¥™ä¡…½Õ¹Ğ¹‘…Ñ„¤°(€€€€€)M=8¹ÍÑÉ¥¹¥™ä¡…½Õ¹Ğ¹ÍÕµµ…Éä¤°(€€€€€…½Õ¹Ğ¹É•…Ñ•‘Ğ°(€€€€€…½Õ¹Ğ¹ÕÁ‘…Ñ•‘Ğ°(€€€t°(€€¤ì)ô()™Õ¹Ñ¥½¸µ…Á½Õ¹Ğ¡É½Ü¤ì(€É•ÑÕÉ¸ì(€€€ÕÍ•É¹…µ”èÉ½Ü¹ÕÍ•É¹…µ”°(€€€¹…µ”èÉ½Ü¹¹…µ”°(€€€•µ…¥°èÉ½Ü¹•µ…¥°°(€€€Í…±ĞèÉ½Ü¹Í…±Ğ°(€€€Á…ÍÍİ½É‘!…Í èÉ½Ü¹Á…ÍÍİ½É‘}¡…Í °(€€€‘…Ñ„èÉ½Ü¹‘…Ñ„ñğ¹Õ±°°(€€€ÍÕµµ…ÉäèÉ½Ü¹ÍÕµµ…Éäñğ¹Õ±°°(€€€É•…Ñ•‘ĞèÉ½Ü¹É•…Ñ•‘}…Ğ¥¹ÍÑ…¹•½˜…Ñ”€üÉ½Ü¹É•…Ñ•‘}…Ğ¹Ñ½%M=MÑÉ¥¹œ ¤€èÉ½Ü¹É•…Ñ•‘}…Ğ°(€€€ÕÁ‘…Ñ•‘ĞèÉ½Ü¹ÕÁ‘…Ñ•‘}…Ğ¥¹ÍÑ…¹•½˜…Ñ”€üÉ½Ü¹ÕÁ‘…Ñ•‘}…Ğ¹Ñ½%M=MÑÉ¥¹œ ¤€èÉ½Ü¹ÕÁ‘…Ñ•‘}…Ğ°(€ôì)ô()™Õ¹Ñ¥½¸ÁÕ‰±¥I•ÍÁ½¹Í”¡…½Õ¹Ğ°Ñ½­•¸¤ì(€É•ÑÕÉ¸ì(€€€ÕÍ•Èèì(€€€€€ÕÍ•É¹…µ”è…½Õ¹Ğ¹ÕÍ•É¹…µ”°(€€€€€¹…µ”è…½Õ¹Ğ¹¹…µ”°(€€€€€•µ…¥°è…½Õ¹Ğ¹•µ…¥°°(€€€€€É•…Ñ•‘Ğè…½Õ¹Ğ¹É•…Ñ•‘Ğ°(€€€€€ÕÁ‘…Ñ•‘Ğè…½Õ¹Ğ¹ÕÁ‘…Ñ•‘Ğ°(€€€ô°(€€€‘…Ñ„è…½Õ¹Ğ¹‘…Ñ„ñğ¹Õ±°°(€€€€¸¸¸¡Ñ½­•¸€üìÑ½­•¸ô€èíô¤°(€ôì)ô()…Íå¹Œ™Õ¹Ñ¥½¸ÉÕ¹5…¥¹Ñ•¹…¹•Q…Í­Ì ¤ì(€¥˜€ …ÁÉ½•ÍÌ¹•¹Ø¹Q	M}UI0¤É•ÑÕÉ¸ì(€…İ…¥Ğ•¹ÍÕÉ•M¡•µ„ ¤ì((€½¹ÍĞ‘•±•Ñ•UÍ•ÉÌ€ôÍÁ±¥Ñ¹Ù1¥ÍĞ¡ÁÉ½•ÍÌ¹•¹Ø¹1Q}=U9Q}9=\¤ì(€™½È€¡½¹ÍĞÕÍ•É¹…µ”½˜‘•±•Ñ•UÍ•ÉÌ¤ì(€€€…İ…¥Ğ•ÑA½½° ¤¹ÅÕ•Éä¡1QI=4…½Õ¹ÑÌ]!IÕÍ•É¹…µ”€ô€Å€°m¹½Éµ…±¥é•UÍ•É¹…µ”¡ÕÍ•É¹…µ”¥t¤ì(€ô((€™½È€¡½¹ÍĞmÕÍ•É¹…µ”°¹•İA…ÍÍİ½É‘t½˜Á…ÉÍ•¹ÙA…¥ÉÌ¡ÁÉ½•ÍÌ¹•¹Ø¹!9}AMM]=I¤¤ì(€€€¥˜€ …¹•İA…ÍÍİ½É¤½¹Ñ¥¹Õ”ì(€€€½¹ÍĞÍ…±Ğ€ôÉåÁÑ¼¹É…¹‘½µ	åÑ•Ì ÄØ¤¹Ñ½MÑÉ¥¹œ ‰¡•àˆ¤ì(€€€½¹ÍĞÁ…ÍÍİ½É‘!…Í €ô…İ…¥Ğ¡…Í¡A…ÍÍİ½É¡¹•İA…ÍÍİ½É°Í…±Ğ¤ì(€€€…İ…¥Ğ•ÑA½½° ¤¹ÅÕ•Éä (€€€€€UAQ…½Õ¹ÑÌMPÍ…±Ğ€ô€È°Á…ÍÍİ½É‘}¡…Í €ô€Ì°ÕÁ‘…Ñ•‘}…Ğ€ô9=\ ¤]!IÕÍ•É¹…µ”€ô€Å€°(€€€€€m¹½Éµ…±¥é•UÍ•É¹…µ”¡ÕÍ•É¹…µ”¤°Í…±Ğ°Á…ÍÍİ½É‘!…Í¡t°(€€€€¤ì(€€€…İ…¥Ğ•ÑA½½° ¤¹ÅÕ•Éä¡1QI=4…½Õ¹Ñ}Í•ÍÍ¥½¹Ì]!IÕÍ•É¹…µ”€ô€Å€°l(€€€€€¹½Éµ…±¥é•UÍ•É¹…µ”¡ÕÍ•É¹…µ”¤°(€€€t¤ì(€ô((€™½È€¡½¹ÍĞm½±‘UÍ•É¹…µ”°¹•İUÍ•É¹…µ•t½˜Á…ÉÍ•¹ÙA…¥ÉÌ¡ÁÉ½•ÍÌ¹•¹Ø¹!9}UMI95¤¤ì(€€€½¹ÍĞ½±‘Y…±Õ”€ô¹½Éµ…±¥é•UÍ•É¹…µ”¡½±‘UÍ•É¹…µ”¤ì(€€€½¹ÍĞ¹•İY…±Õ”€ô¹½Éµ…±¥é•UÍ•É¹…µ”¡¹•İUÍ•É¹…µ”¤ì(€€€¥˜€¡½±‘Y…±Õ”€˜˜€½ymqÁí1õqÁí9ô¹|µuìÌ°ÔÁô½Ô¹Ñ•ÍĞ¡¹•İY…±Õ”¤¤ì(€€€€€…İ…¥Ğ•ÑA½½° ¤¹ÅÕ•Éä¡UAQ…½Õ¹ÑÌMPÕÍ•É¹…µ”€ô€È°ÕÁ‘…Ñ•‘}…Ğ€ô9=\ ¤]!IÕÍ•É¹…µ”€ô€Å€°l(€€€€€€€½±‘Y…±Õ”°(€€€€€€€¹•İY…±Õ”°(€€€€€t¤ì(€€€ô(€ô((€™½È€¡½¹ÍĞmÕÍ•É¹…µ”°¹…µ•t½˜Á…ÉÍ•¹ÙA…¥ÉÌ¡ÁÉ½•ÍÌ¹•¹Ø¹!9}95¤¤ì(€€€…İ…¥Ğ•ÑA½½° ¤¹ÅÕ•Éä¡UAQ…½Õ¹ÑÌMP¹…µ”€ô€È°ÕÁ‘…Ñ•‘}…Ğ€ô9=\ ¤]!IÕÍ•É¹…µ”€ô€Å€°l(€€€€€¹½Éµ…±¥é•UÍ•É¹…µ”¡ÕÍ•É¹…µ”¤°(€€€€€±•…¹Q•áĞ¡¹…µ”°€àÀ¤°(€€€t¤ì(€ô((€™½È€¡½¹ÍĞmÕÍ•É¹…µ”°•µ…¥±t½˜Á…ÉÍ•¹ÙA…¥ÉÌ¡ÁÉ½•ÍÌ¹•¹Ø¹!9}5%0¤¤ì(€€€…İ…¥Ğ•ÑA½½° ¤¹ÅÕ•Éä¡UAQ…½Õ¹ÑÌMP•µ…¥°€ô€È°ÕÁ‘…Ñ•‘}…Ğ€ô9=\ ¤]!IÕÍ•É¹…µ”€ô€Å€°l(€€€€€¹½Éµ…±¥é•UÍ•É¹…µ”¡ÕÍ•É¹…µ”¤°(€€€€€±•…¹Q•áĞ¡•µ…¥°°€ÄÈÀ¤°(€€€t¤ì(€ô((€½¹ÍĞÍÑ½É•‘½Õ¹ÑÌ€ô…İ…¥Ğ•ÑA½½° ¤¹ÅÕ•Éä¡M1PÕÍ•É¹…µ”°‘…Ñ„I=4…½Õ¹ÑÍ€¤ì(€™½È€¡½¹ÍĞÉ½Ü½˜ÍÑ½É•‘½Õ¹ÑÌ¹É½İÌ¤ì(€€€½¹ÍĞ½µÁ…Ğ€ô½µÁ…Ñ½Õ¹Ñ…Ñ„¡É½Ü¹‘…Ñ„¤ì(€€€½¹ÍĞÍÕµµ…Éä€ô‰Õ¥±‘MÕµµ…Éä¡½µÁ…Ğ¤ì(€€€…İ…¥Ğ•ÑA½½° ¤¹ÅÕ•Éä (€€€€€UAQ…½Õ¹ÑÌ(€€€€€€€€€MP‘…Ñ„€ô€Èèé©Í½¹ˆ°ÍÕµµ…Éä€ô€Ìèé©Í½¹ˆ°ÕÁ‘…Ñ•‘}…Ğ€ô9=\ ¤(€€€€€€€]!IÕÍ•É¹…µ”€ô€Ä(€€€€€€€€€9‘…Ñ„%L%MQ%9PI=4€Èèé©Í½¹‰€°(€€€€€mÉ½Ü¹ÕÍ•É¹…µ”°)M=8¹ÍÑÉ¥¹¥™ä¡½µÁ…Ğ¤°)M=8¹ÍÑÉ¥¹¥™ä¡ÍÕµµ…Éä¥t°(€€€€¤ì(€ô)ô()™Õ¹Ñ¥½¸ÍÁ±¥Ñ¹Ù1¥ÍĞ¡Ù…±Õ”¤ì(€É•ÑÕÉ¸MÑÉ¥¹œ¡Ù…±Õ”ñğ€ˆˆ¤(€€€€¹ÍÁ±¥Ğ ˆ°ˆ¤(€€€€¹µ…À ¡¥Ñ•´¤€ôø¥Ñ•´¹ÑÉ¥´ ¤¤(€€€€¹™¥±Ñ•È¡	½½±•…¸¤ì)ô()™Õ¹Ñ¥½¸Á…ÉÍ•¹ÙA…¥ÉÌ¡Ù…±Õ”¤ì(€É•ÑÕÉ¸ÍÁ±¥Ñ¹Ù1¥ÍĞ¡Ù…±Õ”¤(€€€€¹µ…À ¡¥Ñ•´¤€ôøì(€€€€€½¹ÍĞÍ•Á…É…Ñ½È€ô¥Ñ•´¹¥¹‘•á=˜ ˆèˆ¤ì(€€€€€É•ÑÕÉ¸Í•Á…É…Ñ½È€ø€À(€€€€€€€€üm¥Ñ•´¹Í±¥” À°Í•Á…É…Ñ½È¤¹ÑÉ¥´ ¤°¥Ñ•´¹Í±¥”¡Í•Á…É…Ñ½È€¬€Ä¤¹ÑÉ¥´ ¥t(€€€€€€€€è¹Õ±°ì(€€€ô¤(€€€€¹™¥±Ñ•È¡	½½±•…¸¤ì)ô()…Íå¹Œ™Õ¹Ñ¥½¸É•…‘)Í½¹	½‘ä¡É•ÅÕ•ÍĞ¤ì(€½¹ÍĞ½¹Ñ•¹ÑQåÁ•Y…±Õ”€ôMÑÉ¥¹œ¡É•ÅÕ•ÍĞ¹¡•…‘•ÉÍl‰½¹Ñ•¹ĞµÑåÁ”‰tñğ€ˆˆ¤ì(€¥˜€ …½¹Ñ•¹ÑQåÁ•Y…±Õ”¹Ñ½1½İ•É…Í” ¤¹ÍÑ…ÉÑÍ]¥Ñ  ‰…ÁÁ±¥…Ñ¥½¸½©Í½¸ˆ¤¤ì(€€€½¹ÍĞ•ÉÉ½È€ô¹•ÜÉÉ½È ‹ff#bäƒbŸffb·b«f#f$ƒf+b³b ƒbfƒf+ff#f)M=8ˆ¤ì(€€€•ÉÉ½È¹ÍÑ…ÑÕÌ€ô€ĞÄÔì(€€€Ñ¡É½Ü•ÉÉ½Èì(€ô((€½¹ÍĞ¡Õ¹­Ì€ômtì(€±•ĞÑ½Ñ…°€ô€Àì(€™½È…İ…¥Ğ€¡½¹ÍĞ¡Õ¹¬½˜É•ÅÕ•ÍĞ¤ì(€€€Ñ½Ñ…°€¬ô¡Õ¹¬¹±•¹Ñ ì(€€€¥˜€¡Ñ½Ñ…°€øµ…á	½‘å	åÑ•Ì¤ì(€€€€€½¹ÍĞ•ÉÉ½È€ô¹•ÜÉÉ½È ‹b·b³fƒbŸfbßfb ƒbfb£bÄƒffƒbŸffbÏff#b´ˆ¤ì(€€€€€•ÉÉ½È¹ÍÑ…ÑÕÌ€ô€ĞÄÌì(€€€€€Ñ¡É½Ü•ÉÉ½Èì(€€€ô(€€€¡Õ¹­Ì¹ÁÕÍ ¡¡Õ¹¬¤ì(€ô(€¥˜€ …¡Õ¹­Ì¹±•¹Ñ ¤É•ÑÕÉ¸íôì(€ÑÉäì(€€€É•ÑÕÉ¸)M=8¹Á…ÉÍ”¡	Õ™™•È¹½¹…Ğ¡¡Õ¹­Ì¤¹Ñ½MÑÉ¥¹œ ‰ÕÑ˜àˆ¤¤ì(€ô…Ñ ì(€€€½¹ÍĞ•ÉÉ½È€ô¹•ÜÉÉ½È ‹b×f+bëb¤)M=8ƒbëf+bÄƒb×bŸfb·b¤ˆ¤ì(€€€•ÉÉ½È¹ÍÑ…ÑÕÌ€ô€ĞÀÀì(€€€Ñ¡É½Ü•ÉÉ½Èì(€ô)ô()™Õ¹Ñ¥½¸¡…¹‘±•Á¥ÉÉ½È¡É•ÍÁ½¹Í”°±…‰•°°•ÉÉ½È¤ì(€½¹Í½±”¹•ÉÉ½È¡±…‰•°°•ÉÉ½È¤ì(€½¹ÍĞÍÑ…ÑÕÌ€ô9Õµ‰•È¡•ÉÉ½Èü¹ÍÑ…ÑÕÌ¤ì(€¥˜€¡lĞÀÀ°€ĞÄÌ°€ĞÄÕt¹¥¹±Õ‘•Ì¡ÍÑ…ÑÕÌ¤¤ì(€€€É•ÑÕÉ¸Í•¹‘)Í½¸¡É•ÍÁ½¹Í”°ÍÑ…ÑÕÌ°ì•ÉÉ½Èè±•…¹Q•áĞ¡•ÉÉ½È¹µ•ÍÍ…”°€ÄàÀ¤ô¤ì(€ô(€É•ÑÕÉ¸Í•¹‘)Í½¸¡É•ÍÁ½¹Í”°€ÔÀÀ°ì•ÉÉ½Èè€‹b«bçbÃbÄƒb—ffbŸfƒbŸfbßfb ƒbŸfb‹fˆô¤ì)ô()™Õ¹Ñ¥½¸±•…¹Q•áĞ¡Ù…±Õ”°µ…à€ô€ÈĞÀ¤ì(€É•ÑÕÉ¸MÑÉ¥¹œ¡Ù…±Õ”ñğ€ˆˆ¤¹ÑÉ¥´ ¤¹Í±¥” À°µ…à¤ì)ô()™Õ¹Ñ¥½¸±•…¹%¡Ù…±Õ”¤ì(€½¹ÍĞ¥€ôMÑÉ¥¹œ¡Ù…±Õ”ñğ€ˆˆ¤ì(€É•ÑÕÉ¸€½ym„µéµhÀ´ä¹|èµuìÄ°ÈĞÁô¼¹Ñ•ÍĞ¡¥¤€ü¥€è€ˆˆì)ô()™Õ¹Ñ¥½¸¹½Éµ…±¥é•UÍ•É¹…µ”¡Ù…±Õ”¤ì(€É•ÑÕÉ¸±•…¹Q•áĞ¡Ù…±Õ”°€ÔÀ¤¹Ñ½1½…±•1½İ•É…Í” ‰…ÈµMˆ¤ì)ô()™Õ¹Ñ¥½¸Í•¹‘)Í½¸¡É•ÍÁ½¹Í”°ÍÑ…ÑÕÌ°‰½‘ä°¡•…‘•ÉÌ€ôíô¤ì(€É•ÍÁ½¹Í”¹İÉ¥Ñ•!•…¡ÍÑ…ÑÕÌ°ì€¸¸¹©Í½¹!•…‘•ÉÌ°€¸¸¹Í•ÕÉ¥Ñå!•…‘•ÉÌ°€¸¸¹¡•…‘•ÉÌô¤ì(€É•ÍÁ½¹Í”¹•¹¡)M=8¹ÍÑÉ¥¹¥™ä¡‰½‘ä¤¤ì)ô()™Õ¹Ñ¥½¸Í•¹‘Q•áĞ¡É•ÍÁ½¹Í”°ÍÑ…ÑÕÌ°‰½‘ä°¡•…‘•ÉÌ€ôíô¤ì(€É•ÍÁ½¹Í”¹İÉ¥Ñ•!•…¡ÍÑ…ÑÕÌ°ì(€€€€¸¸¹Í•ÕÉ¥Ñå!•…‘•ÉÌ°(€€€€‰½¹Ñ•¹ĞµQåÁ”ˆè€‰Ñ•áĞ½Á±…¥¸ì¡…ÉÍ•ĞõÕÑ˜´àˆ°(€€€€¸¸¹¡•…‘•ÉÌ°(€ô¤ì(€É•ÍÁ½¹Í”¹•¹¡‰½‘ä¤ì)ô()™Õ¹Ñ¥½¸½¹Ñ•¹ÑQåÁ”¡•áÑ•¹Í¥½¸¤ì(€É•ÑÕÉ¸ì(€€€€ˆ¹¡Ñµ°ˆè€‰Ñ•áĞ½¡Ñµ°ì¡…ÉÍ•ĞõÕÑ˜´àˆ°(€€€€ˆ¹ÍÌˆè€‰Ñ•áĞ½ÍÌì¡…ÉÍ•ĞõÕÑ˜´àˆ°(€€€€ˆ¹©Ìˆè€‰Ñ•áĞ½©…Ù…ÍÉ¥ÁĞì¡…ÉÍ•ĞõÕÑ˜´àˆ°(€€€€ˆ¹µ©Ìˆè€‰Ñ•áĞ½©…Ù…ÍÉ¥ÁĞì¡…ÉÍ•ĞõÕÑ˜´àˆ°(€€€€ˆ¹ÍÙœˆè€‰¥µ…”½ÍÙœ­áµ°ˆ°(€õm•áÑ•¹Í¥½¸¹Ñ½1½İ•É…Í” ¥tñğ€‰…ÁÁ±¥…Ñ¥½¸½½Ñ•ĞµÍÑÉ•…´ˆì)ô()™Õ¹Ñ¥½¸…¡•½¹ÑÉ½°¡™¥±•A…Ñ ¤ì(€½¹ÍĞ¹…µ”€ôÁ…Ñ ¹‰…Í•¹…µ”¡™¥±•A…Ñ ¤ì(€É•ÑÕÉ¸l‰¥¹‘•à¹¡Ñµ°ˆ°€‰…ÁÀ¹©Ìˆ°€‰½É”¹µ©Ìˆ°€‰ÍÑå±•Ì¹ÍÌˆ°€‰ÍÜ¹©Ì‰t¹¥¹±Õ‘•Ì¡¹…µ”¤(€€€€ü€‰¹¼µ…¡”ˆ(€€€€è€‰ÁÕ‰±¥Œ°µ…àµ…”ôÌØÀÀˆì)ô