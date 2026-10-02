/* Sommersemester Finder — login + cloud-sync server (phone + 4-digit PIN).
   - One endpoint /api/auth does create-or-login: an unknown phone + any 4-digit
     PIN creates the account; a known phone verifies the PIN (5 wrong tries =>
     15-minute lock). PINs are stored ONLY as salted scrypt hashes.
   - Per-phone shortlist/remarks/status live in Neon (tables users/marks/sessions).
   - DATABASE_URL lives in .env, which is gitignored — it is never sent to the
     browser and never committed.
   Run:  npm install && npm start   →  http://localhost:8321  (app + API, same origin) */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

/* ---- load .env (DATABASE_URL, PORT) ---- */
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath))
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL missing — put it in webapp/.env (never committed).");
  process.exit(1);
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: true } });
const PORT = parseInt(process.env.PORT || "8321", 10);

const MAX_FAILS = 5;       // wrong-PIN tries before lock
const LOCK_MINUTES = 15;   // lock duration
const SESSION_DAYS = 30;   // login validity
const BODY_LIMIT = 200000; // ~200 KB per request
const MARKS_LIMIT = 150000;// JSON size cap for a user's marks blob

/* ---------------- helpers ---------------- */
const send = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(body);
};
const readBody = req => new Promise((resolve, reject) => {
  let size = 0; const chunks = [];
  req.on("data", c => { size += c.length; if (size > BODY_LIMIT) { reject(new Error("too big")); req.destroy(); } else chunks.push(c); });
  req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  req.on("error", reject);
});
const cleanPhone = p => String(p || "").replace(/\D/g, "");
const validPin = p => /^\d{4}$/.test(String(p || ""));
const makeSalt = () => crypto.randomBytes(16).toString("hex");
const hashPin = (pin, salt) => crypto.scryptSync(String(pin), Buffer.from(salt, "hex"), 32).toString("hex");
const pinOk = (pin, salt, stored) => {
  const a = Buffer.from(hashPin(pin, salt), "hex");
  const b = Buffer.from(String(stored || ""), "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const newToken = () => crypto.randomBytes(24).toString("hex");

async function createSession(phone) {
  const token = newToken();
  await pool.query(
    "INSERT INTO sessions (token, phone, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))",
    [token, phone, SESSION_DAYS]);
  await pool.query("UPDATE users SET last_login_at = now() WHERE phone = $1", [phone]);
  return token;
}
async function authedPhone(req) {
  const token = String(req.headers["x-auth-token"] || "").trim();
  if (!/^[0-9a-f]{48}$/.test(token)) return null;
  const r = await pool.query("SELECT phone FROM sessions WHERE token = $1 AND expires_at > now()", [token]);
  return r.rows[0] ? r.rows[0].phone : null;
}

/* ---------------- endpoints ---------------- */
async function handleAuth(res, body) {
  const phone = cleanPhone(body.phone), pin = String(body.pin || "");
  if (!/^\d{6,15}$/.test(phone)) return send(res, 400, { error: "Enter a full phone number (digits only)." });
  if (!validPin(pin)) return send(res, 400, { error: "The PIN must be exactly 4 digits." });

  const u = await pool.query(
    "SELECT pin_salt, pin_hash, failed_count, locked_until FROM users WHERE phone = $1", [phone]);

  if (u.rowCount === 0) { // create-or-login: new number => new account
    const salt = makeSalt();
    try {
      await pool.query("INSERT INTO users (phone, pin_salt, pin_hash) VALUES ($1, $2, $3)",
        [phone, salt, hashPin(pin, salt)]);
    } catch (e) { if (e.code !== "23505") throw e; } // race: second insert loses, falls through to verify
    const token = await createSession(phone);
    return send(res, 200, { token, phone, created: true });
  }

  const row = u.rows[0];
  if (row.locked_until && new Date(row.locked_until) > new Date()) {
    const mins = Math.max(1, Math.ceil((new Date(row.locked_until) - Date.now()) / 60000));
    return send(res, 429, { error: `Too many attempts — try again in ${mins} min.` });
  }
  if (!pinOk(pin, row.pin_salt, row.pin_hash)) {
    const fails = (row.failed_count || 0) + 1;
    /* the $N::int casts are required: in `CASE WHEN $2 >= $3` Postgres cannot
       infer the type of two bare parameters and the whole statement errors,
       which would silently disable the lockout. */
    await pool.query(
      `UPDATE users SET failed_count = $2::int,
         locked_until = CASE WHEN $2::int >= $3::int THEN now() + make_interval(mins => $4::int) ELSE NULL END
       WHERE phone = $1`, [phone, fails, MAX_FAILS, LOCK_MINUTES]);
    return send(res, 401, { error: fails >= MAX_FAILS
      ? `Wrong PIN — locked for ${LOCK_MINUTES} minutes.`
      : `Wrong PIN (${MAX_FAILS - fails} ${MAX_FAILS - fails === 1 ? "try" : "tries"} left).` });
  }
  await pool.query("UPDATE users SET failed_count = 0, locked_until = NULL WHERE phone = $1", [phone]);
  const token = await createSession(phone);
  return send(res, 200, { token, phone, created: false });
}

async function handleMarksGet(res, phone) {
  const r = await pool.query("SELECT data, updated_at FROM marks WHERE phone = $1", [phone]);
  return send(res, 200, { data: r.rows[0] ? r.rows[0].data : null, updatedAt: r.rows[0] ? r.rows[0].updated_at : null });
}
async function handleMarksPut(res, phone, body) {
  const d = body && body.data;
  if (!d || typeof d !== "object") return send(res, 400, { error: "Expected {data:{...}}." });
  const json = JSON.stringify(d);
  if (json.length > MARKS_LIMIT) return send(res, 413, { error: "Data too large." });
  await pool.query(
    `INSERT INTO marks (phone, data, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (phone) DO UPDATE SET data = $2::jsonb, updated_at = now()`, [phone, json]);
  return send(res, 200, { ok: true });
}

/* ---------------- static app ---------------- */
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
function serveStatic(urlPath, res) {
  let p = decodeURIComponent(String(urlPath).split("?")[0]);
  if (p === "/") p = "/index.html";
  const f = path.normalize(path.join(__dirname, p));
  if (!f.startsWith(__dirname + path.sep) && f !== __dirname) return send(res, 403, { error: "forbidden" });
  fs.readFile(f, (e, buf) => {
    if (e) return send(res, 404, { error: "not found" });
    res.writeHead(200, { "content-type": TYPES[path.extname(f).toLowerCase()] || "application/octet-stream", "cache-control": "no-store" });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const u = req.url || "/";
    if (u.startsWith("/api/")) {
      let body = {};
      if (req.method === "POST" || req.method === "PUT") {
        const raw = await readBody(req);
        if (raw.length > BODY_LIMIT) return send(res, 413, { error: "payload too large" });
        try { body = JSON.parse(raw || "{}"); } catch (e) { return send(res, 400, { error: "bad json" }); }
      }
      if (u === "/api/auth" && req.method === "POST") return await handleAuth(res, body);
      const phone = await authedPhone(req);
      if (!phone) return send(res, 401, { error: "Not signed in." });
      if (u === "/api/me" && req.method === "GET") return send(res, 200, { phone });
      if (u === "/api/logout" && req.method === "POST") {
        await pool.query("DELETE FROM sessions WHERE token = $1", [String(req.headers["x-auth-token"] || "").trim()]);
        return send(res, 200, { ok: true });
      }
      if (u === "/api/marks" && req.method === "GET") return await handleMarksGet(res, phone);
      if (u === "/api/marks" && req.method === "PUT") return await handleMarksPut(res, phone, body);
      return send(res, 404, { error: "unknown api" });
    }
    if (req.method === "GET") return serveStatic(u, res);
    return send(res, 405, { error: "method not allowed" });
  } catch (e) {
    console.error(e);
    try { send(res, 500, { error: "server error" }); } catch (_) { /* headers already sent */ }
  }
});
server.listen(PORT, "127.0.0.1", () => console.log(`Sommersemester Finder + sync API on http://localhost:${PORT}`));
