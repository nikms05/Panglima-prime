// POST /api/stripe-webhook  — Stripe sends paid orders here.
// 1) verifies the Stripe signature  2) saves the order in Supabase  3) emails the customer + you via Resend.
import Stripe from "stripe";

let _stripe = null;
function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  if (!_stripe) _stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return _stripe;
}
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;          // public key; writes are guarded by ORDERS_SECRET
const ORDERS_SECRET = process.env.ORDERS_SECRET;
const RESEND_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || "Gear 4 <orders@gear4.my>";
const NOTIFY_TO = process.env.ORDER_NOTIFY_EMAIL || "";
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || "";

export async function POST(request) {
  const stripe = getStripe();
  if (!stripe || !WEBHOOK_SECRET) return new Response("not configured", { status: 503 });
  const raw = await request.text();
  const sig = request.headers.get("stripe-signature");
  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(raw, sig, WEBHOOK_SECRET);
  } catch (err) {
    console.error("webhook signature failed:", err.message);
    return new Response("bad signature", { status: 400 });
  }

  try {
    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
      const s = event.data.object;
      if (s.payment_status === "paid") await handlePaid(s);
    }
    if (event.type === "charge.refunded") {
      const ch = event.data.object;
      await rpc("panglima_mark_refunded", { p_secret: ORDERS_SECRET, p_payment_intent: ch.payment_intent });
      await handleRefund(stripe, ch, event.id);
    }
  } catch (err) {
    console.error("webhook handler error:", err.message);
    return new Response("error", { status: 500 }); // Stripe will retry
  }
  return new Response("ok", { status: 200 });
}

async function handlePaid(s) {
  const ship = (s.collected_information && s.collected_information.shipping_details) || s.shipping_details || {};
  const a = ship.address || {};
  const cd = s.customer_details || {};
  const piId = typeof s.payment_intent === "string" ? s.payment_intent : (s.payment_intent && s.payment_intent.id) || null;
  const order = {
    stripe_session_id: s.id,
    payment_intent: piId,
    status: "paid",
    pack_boxes: Number((s.metadata && s.metadata.pack) || 0),
    lang: (s.metadata && s.metadata.lang) || "en",
    amount_usd: await usdAmount(s, piId),
    amount_paid: s.amount_total / 100,
    currency_paid: (s.currency || "").toUpperCase(),
    customer_name: ship.name || cd.name || null,
    email: cd.email || null,
    phone: cd.phone || null,
    address_line1: a.line1 || null,
    address_line2: a.line2 || null,
    city: a.city || null,
    postcode: a.postal_code || null,
    state: a.state || null,
    country: a.country || null,
    utm: pickUtm(s.metadata || {}),
  };

  // insert; if Stripe retries the same event, the unique session id prevents a duplicate row
  const isNew = await rpc("panglima_record_order", { p_secret: ORDERS_SECRET, p_order: order });
  if (!isNew) return; // already processed — don't email twice

  await Promise.allSettled([
    order.email ? sendCustomerEmail(order) : null,
    NOTIFY_TO ? sendOwnerEmail(order) : null,
  ]);
}

// Refund: tell the team NOT to ship, and confirm the refund to the customer.
async function handleRefund(stripe, ch, eventId) {
  const pi = typeof ch.payment_intent === "string" ? ch.payment_intent : ch.payment_intent && ch.payment_intent.id;
  let sess = null;
  try {
    const list = await stripe.checkout.sessions.list({ payment_intent: pi, limit: 1 });
    sess = list.data[0] || null;
  } catch (e) { console.error("refund: session lookup failed", e.message); }
  const ship = (sess && ((sess.collected_information && sess.collected_information.shipping_details) || sess.shipping_details)) || {};
  const cd = (sess && sess.customer_details) || {};
  const r = {
    id: sess ? sess.id.slice(-8).toUpperCase() : (pi || "").slice(-8).toUpperCase(),
    lang: (sess && sess.metadata && sess.metadata.lang) || "en",
    boxes: Number((sess && sess.metadata && sess.metadata.pack) || 0),
    name: ship.name || cd.name || (ch.billing_details && ch.billing_details.name) || "",
    email: cd.email || (ch.billing_details && ch.billing_details.email) || ch.receipt_email || "",
    full: !!ch.refunded,
    refunded: fmt(ch.currency, ch.amount_refunded),
    paid: fmt(ch.currency, ch.amount),
  };
  const jobs = [];
  if (NOTIFY_TO) {
    const title = r.full ? `🔴 REFUNDED #${r.id} — JANGAN POS / DO NOT SHIP` : `🟠 PARTIAL REFUND #${r.id} — semak sebelum pos`;
    const html = `<div style="font-family:Arial;font-size:15px">
<p style="background:${r.full ? "#B42318" : "#B54708"};color:#fff;padding:12px 14px;border-radius:8px;font-weight:bold">${esc(title)}</p>
<table cellpadding="6" style="font-size:14px;border-collapse:collapse">
<tr><td style="color:#666">Order</td><td><b>#${esc(r.id)}</b></td></tr>
<tr><td style="color:#666">Package</td><td><b>${r.boxes || "-"} box(es)</b></td></tr>
<tr><td style="color:#666">Paid</td><td><b>${esc(r.paid)}</b></td></tr>
<tr><td style="color:#666">Refunded</td><td><b>${esc(r.refunded)}</b></td></tr>
<tr><td style="color:#666">Name</td><td><b>${esc(r.name)}</b></td></tr>
<tr><td style="color:#666">Email</td><td><b>${esc(r.email)}</b></td></tr></table>
<p>${r.full ? "Pesanan ini telah dibatalkan dan dipulangkan sepenuhnya. Kalau belum dipos, <b>jangan bungkus</b>. Kalau sudah dipos, maklumkan pemilik." : "Sebahagian bayaran dipulangkan. Semak dengan pemilik sebelum pos."}</p></div>`;
    jobs.push(resend({ from: EMAIL_FROM, to: NOTIFY_TO.split(",").map((x) => x.trim()), subject: title, html }, `refund-owner-${eventId}`));
  }
  if (r.email) {
    const ms = r.lang === "ms";
    const subject = ms ? `Bayaran balik diproses — #${r.id}` : `Refund processed — #${r.id}`;
    const body = ms
      ? `Bayaran balik sebanyak <b>${esc(r.refunded)}</b> untuk pesanan <b>#${esc(r.id)}</b> telah diproses${r.full ? " dan pesanan anda dibatalkan" : ""}. Wang akan masuk semula ke kad anda dalam 5–10 hari bekerja, bergantung pada bank anda.`
      : `A refund of <b>${esc(r.refunded)}</b> for order <b>#${esc(r.id)}</b> has been processed${r.full ? " and your order has been cancelled" : ""}. It will appear on your card within 5–10 business days, depending on your bank.`;
    const html = `<!doctype html><html><body style="margin:0;background:#F3EBDD;font-family:Arial,Helvetica,sans-serif;color:#15120E">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#fff;border:1px solid #DCCFB8;border-radius:14px">
<tr><td style="background:#15120E;color:#F3EBDD;padding:20px 28px;border-radius:14px 14px 0 0;font-size:22px;font-weight:900;letter-spacing:1px">GEAR <span style="color:#E3B85C">4</span></td></tr>
<tr><td style="padding:28px;font-size:15px;line-height:1.6">
<p style="font-size:18px;margin:0 0 10px"><b>${ms ? "Hai" : "Hi"}${r.name ? " " + esc(r.name.split(" ")[0]) : ""},</b></p>
<p style="margin:0 0 16px;color:#4A4034">${body}</p>
<p style="margin:0;color:#6B5F4F;font-size:14px">${ms ? "Ada soalan? Balas e-mel ini." : "Questions? Just reply to this email."}</p>
</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #EFE6D6;font-size:12px;color:#8A7F6E">Rimba Botanicals LLC · 30 N Gould St Ste R, Sheridan, WY 82801, USA</td></tr>
</table></td></tr></table></body></html>`;
    jobs.push(resend({ from: EMAIL_FROM, to: [r.email], subject, html, ...(SUPPORT_EMAIL ? { reply_to: SUPPORT_EMAIL } : {}) }, `refund-cust-${eventId}`));
  }
  await Promise.allSettled(jobs);
}

// What Stripe actually settles in USD (the order is charged in RM and converted by Stripe).
async function usdAmount(s, piId) {
  if (s.currency === "usd") return s.amount_total / 100;
  try {
    const pi = await getStripe().paymentIntents.retrieve(piId, { expand: ["latest_charge.balance_transaction"] });
    const bt = pi.latest_charge && pi.latest_charge.balance_transaction;
    if (bt && bt.currency === "usd") return bt.amount / 100;
  } catch (e) { console.warn("usd amount lookup failed:", e.message); }
  return null;
}

const fmt = (cur, cents) => { const c = (cur || "").toUpperCase(); const v = (cents / 100).toFixed(2); return c === "MYR" ? `RM${v}` : c === "USD" ? `US$${v}` : `${c} ${v}`; };

function pickUtm(m) {
  const out = {};
  for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "fbclid", "ttclid"]) if (m[k]) out[k] = m[k];
  return out;
}

// Calls a Postgres function in Supabase. The function checks ORDERS_SECRET before writing.
async function rpc(fn, args) {
  if (!SUPABASE_URL || !SUPABASE_KEY || !ORDERS_SECRET) { console.warn("Supabase not configured"); return true; }
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`supabase ${fn} ${r.status}: ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

async function resend(payload, idemKey) {
  if (!RESEND_KEY) { console.warn("Resend not configured"); return; }
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json", ...(idemKey ? { "Idempotency-Key": idemKey } : {}) },
    body: JSON.stringify(payload),
  });
  if (!r.ok) console.error("resend error", r.status, await r.text());
}

const esc = (v) => String(v == null ? "" : v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const money = (o) => fmt(o.currency_paid || "usd", Math.round(o.amount_paid * 100));
const shortId = (o) => o.stripe_session_id.slice(-8).toUpperCase();

function sendCustomerEmail(o) {
  const ms = o.lang === "ms";
  const t = ms ? {
    subject: `Pesanan anda diterima — #${shortId(o)}`,
    hi: `Terima kasih${o.customer_name ? ", " + esc(o.customer_name.split(" ")[0]) : ""}.`,
    body: "Pembayaran anda telah diterima. Kami akan pos pesanan anda dalam parcel biasa tanpa nama produk, dan hantar nombor tracking melalui e-mel sebaik sahaja dipos.",
    order: "Pesanan", pkg: "Pakej", paid: "Dibayar", to: "Dihantar ke",
    boxes: `${o.pack_boxes} kotak (${o.pack_boxes * 2} strip)`,
    use: "Cara guna: letak 1 strip di lidah kira-kira 15 minit sebelum dan biar larut. Ikut arahan pada kotak. Untuk dewasa 18 tahun ke atas.",
    help: "Ada soalan? Balas e-mel ini.",
  } : {
    subject: `Order confirmed — #${shortId(o)}`,
    hi: `Thank you${o.customer_name ? ", " + esc(o.customer_name.split(" ")[0]) : ""}.`,
    body: "Your payment has been received. We'll ship your order in a plain parcel with no product name and email your tracking number as soon as it ships.",
    order: "Order", pkg: "Package", paid: "Paid", to: "Shipping to",
    boxes: `${o.pack_boxes} box${o.pack_boxes > 1 ? "es" : ""} (${o.pack_boxes * 2} strips)`,
    use: "How to use: place 1 strip on your tongue about 15 minutes before and let it dissolve. Follow the directions on the box. For adults 18 and over.",
    help: "Questions? Just reply to this email.",
  };
  const addr = [o.address_line1, o.address_line2, [o.postcode, o.city].filter(Boolean).join(" "), o.state].filter(Boolean).map(esc).join("<br>");
  const html = `<!doctype html><html><body style="margin:0;background:#F3EBDD;font-family:Arial,Helvetica,sans-serif;color:#15120E">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3EBDD;padding:24px 0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid #DCCFB8;border-radius:14px">
<tr><td style="background:#15120E;color:#F3EBDD;padding:20px 28px;border-radius:14px 14px 0 0;font-size:22px;font-weight:900;letter-spacing:1px">GEAR <span style="color:#E3B85C">4</span></td></tr>
<tr><td style="padding:28px">
<p style="font-size:18px;margin:0 0 10px"><b>${t.hi}</b></p>
<p style="font-size:15px;line-height:1.6;color:#6B5F4F;margin:0 0 22px">${t.body}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:15px">
<tr><td style="padding:8px 0;color:#6B5F4F">${t.order}</td><td align="right" style="padding:8px 0"><b>#${shortId(o)}</b></td></tr>
<tr><td style="padding:8px 0;color:#6B5F4F;border-top:1px solid #EFE6D6">${t.pkg}</td><td align="right" style="padding:8px 0;border-top:1px solid #EFE6D6">${t.boxes}</td></tr>
<tr><td style="padding:8px 0;color:#6B5F4F;border-top:1px solid #EFE6D6">${t.paid}</td><td align="right" style="padding:8px 0;border-top:1px solid #EFE6D6"><b>${money(o)}</b></td></tr>
<tr><td style="padding:8px 0;color:#6B5F4F;border-top:1px solid #EFE6D6;vertical-align:top">${t.to}</td><td align="right" style="padding:8px 0;border-top:1px solid #EFE6D6">${addr}</td></tr>
</table>
<p style="font-size:14px;line-height:1.6;color:#6B5F4F;background:#F8F3EA;border-radius:10px;padding:14px 16px;margin:22px 0 0">${t.use}</p>
<p style="font-size:14px;color:#6B5F4F;margin:18px 0 0">${t.help}</p>
</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #EFE6D6;font-size:12px;color:#8A7F6E">Rimba Botanicals LLC · 30 N Gould St Ste R, Sheridan, WY 82801, USA</td></tr>
</table></td></tr></table></body></html>`;
  return resend({ from: EMAIL_FROM, to: [o.email], subject: t.subject, html, ...(SUPPORT_EMAIL ? { reply_to: SUPPORT_EMAIL } : {}) });
}

function sendOwnerEmail(o) {
  const rows = [
    ["Order", "#" + shortId(o)], ["Package", `${o.pack_boxes} box(es)`], ["Paid", money(o)],
    ["Settles (USD)", o.amount_usd != null ? "$" + o.amount_usd.toFixed(2) : "-"],
    ["Name", o.customer_name], ["Phone", o.phone], ["Email", o.email],
    ["Address", [o.address_line1, o.address_line2, o.postcode, o.city, o.state, o.country].filter(Boolean).join(", ")],
    ["Source", Object.entries(o.utm || {}).map(([k, v]) => `${k}=${v}`).join(" ") || "-"],
  ];
  const html = `<table cellpadding="6" style="font-family:Arial;font-size:14px;border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="color:#666">${esc(k)}</td><td><b>${esc(v)}</b></td></tr>`).join("")}</table>`;
  return resend({ from: EMAIL_FROM, to: NOTIFY_TO.split(",").map((x) => x.trim()), subject: `🟢 New order #${shortId(o)} — ${o.pack_boxes} box(es), ${money(o)}`, html });
}
