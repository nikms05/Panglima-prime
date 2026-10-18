// Staff order desk API — username + password login (accounts in the STAFF_USERS env var: "nik:pass1,staff:pass2").
// POST /api/staff {action:"login", username, password}   -> { token, user }   (5 wrong tries = 15-minute lock)
// GET  /api/staff?status=paid|shipped|refunded|all          -> { orders }       (Authorization: Bearer <token>)
// POST /api/staff {action:"ship", id, courier, tracking}    -> marks shipped + emails the customer their tracking
import crypto from "node:crypto";

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const ORDERS_SECRET = process.env.ORDERS_SECRET;
const STAFF_USERS = process.env.STAFF_USERS || "";
const RESEND_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || "Gear 4 <orders@gear4.my>";
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || "";
const TOKEN_DAYS = 30;
const MAX_FAILS = 5;

const COURIERS = ["J&T Express", "Pos Laju", "Ninja Van", "DHL eCommerce", "SPX Express", "City-Link", "Flash Express", "Lain-lain"];

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function users() {
  const m = new Map();
  for (const pair of STAFF_USERS.split(",")) {
    const i = pair.indexOf(":");
    if (i > 0) m.set(pair.slice(0, i).trim().toLowerCase(), pair.slice(i + 1).trim());
  }
  return m;
}
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
// Signing key changes whenever STAFF_USERS changes, so changing a password logs everyone out.
const signKey = () => crypto.createHash("sha256").update(`${ORDERS_SECRET}|${STAFF_USERS}`).digest();
const b64 = (buf) => Buffer.from(buf).toString("base64url");

function makeToken(user) {
  const body = b64(JSON.stringify({ u: user, exp: Date.now() + TOKEN_DAYS * 864e5 }));
  return `${body}.${b64(crypto.createHmac("sha256", signKey()).update(body).digest())}`;
}
function readToken(request) {
  const t = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const [body, sig] = t.split(".");
  if (!body || !sig) return null;
  if (!eq(sig, b64(crypto.createHmac("sha256", signKey()).update(body).digest()))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    if (!p.u || p.exp < Date.now() || !users().has(p.u)) return null;
    return p.u;
  } catch (_) { return null; }
}

async function rpc(fn, args) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_secret: ORDERS_SECRET, ...args }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(t);
  return t ? JSON.parse(t) : null;
}

async function login(b) {
  const username = String(b.username || "").trim().toLowerCase().slice(0, 40);
  const password = String(b.password || "");
  if (!username || !password) return json({ error: "missing_fields" }, 400);
  const fails = await rpc("panglima_login_attempt", { p_username: username, p_ok: null });
  if (fails >= MAX_FAILS) return json({ error: "locked" }, 429);
  const want = users().get(username);
  const ok = want != null && eq(password, want);
  await rpc("panglima_login_attempt", { p_username: username, p_ok: ok });
  if (!ok) { await sleep(600); return json({ error: "unauthorized", left: Math.max(0, MAX_FAILS - fails - 1) }, 401); }
  return json({ token: makeToken(username), user: username });
}

export async function GET(request) {
  const user = readToken(request);
  if (!user) return json({ error: "unauthorized" }, 401);
  const status = new URL(request.url).searchParams.get("status") || "paid";
  if (!["paid", "shipped", "refunded", "all"].includes(status)) return json({ error: "bad_status" }, 400);
  try {
    const orders = await rpc("panglima_list_orders", { p_status: status, p_limit: 300 });
    return json({ orders, couriers: COURIERS, user });
  } catch (e) {
    console.error("staff list failed", e.message);
    return json({ error: "server" }, 500);
  }
}

export async function POST(request) {
  let b = {};
  try { b = await request.json(); } catch (_) {}
  if (b.action === "login") {
    try { return await login(b); } catch (e) { console.error("login failed", e.message); return json({ error: "server" }, 500); }
  }
  const user = readToken(request);
  if (!user) return json({ error: "unauthorized" }, 401);
  const id = Number(b.id);
  const courier = String(b.courier || "").slice(0, 60).trim();
  const tracking = String(b.tracking || "").replace(/\s+/g, "").slice(0, 60);
  if (!id || !courier || tracking.length < 6) return json({ error: "missing_fields" }, 400);
  let r;
  try {
    r = await rpc("panglima_ship_order", { p_id: id, p_courier: courier, p_tracking: tracking, p_by: user });
  } catch (e) {
    const m = String(e.message || "");
    if (m.includes("not_shippable")) return json({ error: "not_shippable", detail: m.includes("refunded") ? "refunded" : "status" }, 409);
    if (m.includes("not_found")) return json({ error: "not_found" }, 404);
    console.error("mark shipped failed", m);
    return json({ error: "server" }, 500);
  }
  let emailed = false;
  if (r && r.notify && r.email && RESEND_KEY) emailed = await sendTrackingEmail(r);
  return json({ ok: true, emailed });
}

const esc = (v) => String(v == null ? "" : v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function sendTrackingEmail(o) {
  const ms = o.lang === "ms";
  const url = `https://t.17track.net/en#nums=${encodeURIComponent(o.tracking_number)}`;
  const first = o.customer_name ? " " + esc(String(o.customer_name).split(" ")[0]) : "";
  const t = ms ? {
    subject: `Pesanan anda telah dipos — #${o.order_no}`,
    hi: `Hai${first},`,
    body: "Pesanan anda telah dipos dalam parcel biasa tanpa nama produk. Anda boleh jejak penghantaran menggunakan nombor di bawah.",
    courier: "Kurier", tn: "No. tracking", btn: "Jejak parcel", eta: "Anggaran tiba: 2–5 hari bekerja (Semenanjung), 4–7 hari bekerja (Sabah & Sarawak).",
    help: "Ada soalan? Balas e-mel ini.",
  } : {
    subject: `Your order has shipped — #${o.order_no}`,
    hi: `Hi${first},`,
    body: "Your order is on its way in a plain parcel with no product name. You can track it with the number below.",
    courier: "Courier", tn: "Tracking no.", btn: "Track parcel", eta: "Estimated arrival: 2–5 business days (Peninsular), 4–7 business days (Sabah & Sarawak).",
    help: "Questions? Just reply to this email.",
  };
  const html = `<!doctype html><html><body style="margin:0;background:#F3EBDD;font-family:Arial,Helvetica,sans-serif;color:#15120E">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#fff;border:1px solid #DCCFB8;border-radius:14px">
<tr><td style="background:#15120E;color:#F3EBDD;padding:20px 28px;border-radius:14px 14px 0 0;font-size:22px;font-weight:900;letter-spacing:1px">GEAR <span style="color:#E3B85C">4</span></td></tr>
<tr><td style="padding:28px;font-size:15px;line-height:1.6">
<p style="font-size:18px;margin:0 0 10px"><b>${t.hi}</b></p>
<p style="margin:0 0 18px;color:#4A4034">${t.body}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:15px;background:#F8F3EA;border-radius:10px">
<tr><td style="padding:12px 16px;color:#6B5F4F">${t.courier}</td><td align="right" style="padding:12px 16px"><b>${esc(o.courier)}</b></td></tr>
<tr><td style="padding:12px 16px;color:#6B5F4F;border-top:1px solid #EFE6D6">${t.tn}</td><td align="right" style="padding:12px 16px;border-top:1px solid #EFE6D6;font-family:monospace;font-size:16px"><b>${esc(o.tracking_number)}</b></td></tr>
</table>
<p style="margin:22px 0"><a href="${url}" style="display:inline-block;background:#15120E;color:#F2D387;text-decoration:none;font-weight:bold;padding:13px 26px;border-radius:999px">${t.btn} →</a></p>
<p style="margin:0 0 10px;color:#6B5F4F;font-size:14px">${t.eta}</p>
<p style="margin:0;color:#6B5F4F;font-size:14px">${t.help}</p>
</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #EFE6D6;font-size:12px;color:#8A7F6E">Rimba Botanicals LLC · 30 N Gould St Ste R, Sheridan, WY 82801, USA</td></tr>
</table></td></tr></table></body></html>`;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json", "Idempotency-Key": `ship-${o.id}-${o.tracking_number}` },
    body: JSON.stringify({ from: EMAIL_FROM, to: [o.email], subject: t.subject, html, ...(SUPPORT_EMAIL ? { reply_to: SUPPORT_EMAIL } : {}) }),
  });
  if (!r.ok) console.error("tracking email failed", r.status, await r.text());
  return r.ok;
}
