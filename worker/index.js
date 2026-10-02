/* Cloudflare Worker: /api/* for the Sommersemester Finder.
   Serves the static app through the ASSETS binding and keeps per-phone
   shortlists in Neon over its HTTP driver (Workers cannot open TCP).
   PINs: PBKDF2-SHA256, 150k iterations, per-user random salt — WebCrypto
   has no scrypt, so rows created by the old Node server keep scheme
   'scrypt'; server.js upgrades such a row to pbkdf2 the next time the
   owner signs in locally with the right PIN (the Worker itself rejects
   those rows with 409 + a hint until then).
   DATABASE_URL is a wrangler secret, never a file in this repo. */
import { neon } from "@neondatabase/serverless";

const MAX_FAILS = 5;        // wrong-PIN tries before lock
const LOCK_MINUTES = 15;    // lock duration
const SESSION_DAYS = 30;    // login validity
const BODY_LIMIT = 200000;  // ~200 KB per request
const MARKS_LIMIT = 150000; // JSON size cap for a user's marks blob
const PBKDF2_ITER = 150000;

/* ---------------- crypto helpers ---------------- */
const hexToBuf = h => { const b = new Uint8Array(h.length / 2); for (let i = 0; i < b.length; i++) b[i] = parseInt(h.substr(i * 2, 2), 16); return b; };
const bufToHex = a => [...new Uint8Array(a)].map(x => x.toString(16).padStart(2, "0")).join("");
const makeSalt = () => bufToHex(crypto.getRandomValues(new Uint8Array(16)));
const newToken = () => bufToHex(crypto.getRandomValues(new Uint8Array(24)));
async function hashPin(pin, saltHex) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: hexToBuf(saltHex), iterations: PBKDF2_ITER, hash: "SHA-256" }, key, 256);
  return bufToHex(bits);
}
/* constant-time-ish compare of two hex strings */
function constEq(a, b) {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/* ---------------- request helpers ---------------- */
const send = (code, obj) => new Response(JSON.stringify(obj),
  { status: code, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const cleanPhone = p => String(p || "").replace(/\D/g, "");
const validPin = p => /^\d{4}$/.test(String(p || ""));

async function authedPhone(req, sql) {
  const token = String(req.headers.get("x-auth-token") || "").trim();
  if (!/^[0-9a-f]{48}$/.test(token)) return null;
  const rows = await sql`SELECT phone FROM sessions WHERE token = ${token} AND expires_at > now()`;
  return rows[0] ? rows[0].phone : null;
}
async function createSession(sql, phone) {
  const token = newToken();
  await sql`INSERT INTO sessions (token, phone, expires_at)
            VALUES (${token}, ${phone}, now() + make_interval(days => ${SESSION_DAYS}))`;
  await sql`UPDATE users SET last_login_at = now() WHERE phone = ${phone}`;
  return token;
}

/* ---------------- endpoints ---------------- */
async function handleAuth(sql, body) {
  const phone = cleanPhone(body.phone), pin = String(body.pin || "");
  if (!/^\d{6,15}$/.test(phone)) return send(400, { error: "Enter a full phone number (digits only)." });
  if (!validPin(pin)) return send(400, { error: "The PIN must be exactly 4 digits." });

  const u = await sql`SELECT pin_salt, pin_hash, pin_scheme, failed_count, locked_until FROM users WHERE phone = ${phone}`;

  if (!u.length) { // create-or-login: new number => new account
    const salt = makeSalt();
    const hash = await hashPin(pin, salt);
    try {
      await sql`INSERT INTO users (phone, pin_salt, pin_hash, pin_scheme) VALUES (${phone}, ${salt}, ${hash}, 'pbkdf2')`;
    } catch (e) { if (!/duplicate key|23505/.test(String(e && e.message))) throw e; } // race: loser falls through
    const token = await createSession(sql, phone);
    return send(200, { token, phone, created: true });
  }

  const row = u[0];
  if (row.locked_until && new Date(row.locked_until) > new Date()) {
    const mins = Math.max(1, Math.ceil((new Date(row.locked_until) - Date.now()) / 60000));
    return send(429, { error: `Too many attempts — try again in ${mins} min.` });
  }
  let ok = false;
  if (row.pin_scheme === "pbkdf2") {
    ok = constEq(await hashPin(pin, row.pin_salt), String(row.pin_hash));
  } else {
    /* scrypt row: this runtime cannot verify it — reject with a hint instead
       of silently failing. The owner signs in once at http://localhost:8321
       (node server.js), which upgrades the row on a correct PIN. */
    return send(409, { error: "This account still uses the old PIN format — sign in once on the local server (run `node server.js`, open http://localhost:8321), then use this site again." });
  }
  if (!ok) {
    const fails = (row.failed_count || 0) + 1;
    /* explicit ::int casts: reused $n parameters in a CASE otherwise make
       Postgres infer conflicting types (42P08) and the lockout dies. */
    await sql`UPDATE users SET failed_count = ${fails}::int,
        locked_until = CASE WHEN ${fails}::int >= ${MAX_FAILS}::int
                            THEN now() + make_interval(mins => ${LOCK_MINUTES}::int)
                            ELSE NULL END
      WHERE phone = ${phone}`;
    return send(401, { error: fails >= MAX_FAILS
      ? `Wrong PIN — locked for ${LOCK_MINUTES} minutes.`
      : `Wrong PIN (${MAX_FAILS - fails} ${MAX_FAILS - fails === 1 ? "try" : "tries"} left).` });
  }
  await sql`UPDATE users SET failed_count = 0, locked_until = NULL WHERE phone = ${phone}`;
  const token = await createSession(sql, phone);
  return send(200, { token, phone, created: false });
}

async function handleMarksGet(sql, phone) {
  const r = await sql`SELECT data, updated_at FROM marks WHERE phone = ${phone}`;
  return send(200, { data: r[0] ? r[0].data : null, updatedAt: r[0] ? r[0].updated_at : null });
}
async function handleMarksPut(sql, phone, body) {
  const d = body && body.data;
  if (!d || typeof d !== "object") return send(400, { error: "Expected {data:{...}}." });
  const json = JSON.stringify(d);
  if (json.length > MARKS_LIMIT) return send(413, { error: "Data too large." });
  await sql`INSERT INTO marks (phone, data, updated_at) VALUES (${phone}, ${json}::jsonb, now())
            ON CONFLICT (phone) DO UPDATE SET data = ${json}::jsonb, updated_at = now()`;
  return send(200, { ok: true });
}

/* ---------------- entry point ---------------- */
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    try {
      const sql = neon(env.DATABASE_URL);
      let body = {};
      if (req.method === "POST" || req.method === "PUT") {
        const raw = await req.text();
        if (raw.length > BODY_LIMIT) return send(413, { error: "payload too large" });
        try { body = JSON.parse(raw || "{}"); } catch (e) { return send(400, { error: "bad json" }); }
      }
      if (url.pathname === "/api/auth" && req.method === "POST") return await handleAuth(sql, body);
      const phone = await authedPhone(req, sql);
      if (!phone) return send(401, { error: "Not signed in." });
      if (url.pathname === "/api/me" && req.method === "GET") return send(200, { phone });
      if (url.pathname === "/api/logout" && req.method === "POST") {
        await sql`DELETE FROM sessions WHERE token = ${String(req.headers.get("x-auth-token") || "").trim()}`;
        return send(200, { ok: true });
      }
      if (url.pathname === "/api/marks" && req.method === "GET") return await handleMarksGet(sql, phone);
      if (url.pathname === "/api/marks" && req.method === "PUT") return await handleMarksPut(sql, phone, body);
      return send(404, { error: "unknown api" });
    } catch (e) {
      console.error(e);
      return send(500, { error: "server error" });
    }
  }
};
