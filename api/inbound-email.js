// POST /api/inbound-email — Resend "email.received" webhook.
// Forwards every email sent to *@gear4.my into your Gmail, with Reply-To set to the original sender,
// so pressing "Reply" in Gmail answers the customer directly.
import crypto from "node:crypto";

const RESEND_KEY = process.env.RESEND_API_KEY;
const SIGNING_SECRET = process.env.RESEND_INBOUND_SECRET;       // whsec_... from the Resend webhook page
const FORWARD_TO = (process.env.FORWARD_TO || "").split(",").map((s) => s.trim()).filter(Boolean);
const FORWARD_FROM = process.env.FORWARD_FROM || "Gear 4 Inbox <inbox@gear4.my>";

// Svix-style signature check (what Resend uses for webhooks)
function verify(raw, headers) {
  const id = headers.get("svix-id"), ts = headers.get("svix-timestamp"), sigHeader = headers.get("svix-signature");
  if (!id || !ts || !sigHeader || !SIGNING_SECRET) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // reject replays older than 5 min
  const key = Buffer.from(SIGNING_SECRET.replace(/^whsec_/, ""), "base64");
  const expected = crypto.createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest("base64");
  return sigHeader.split(" ").some((part) => {
    const sig = part.split(",")[1];
    if (!sig) return false;
    const a = Buffer.from(sig), b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

const esc = (v) => String(v == null ? "" : v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const addr = (v) => (Array.isArray(v) ? v.join(", ") : v || "");

export async function POST(request) {
  if (!RESEND_KEY || !SIGNING_SECRET || !FORWARD_TO.length) return new Response("not configured", { status: 503 });
  const raw = await request.text();
  if (!verify(raw, request.headers)) return new Response("bad signature", { status: 400 });

  let event;
  try { event = JSON.parse(raw); } catch (_) { return new Response("bad json", { status: 400 }); }
  if (event.type !== "email.received") return new Response("ignored", { status: 200 });

  const emailId = event.data && event.data.email_id;
  if (!emailId) return new Response("no id", { status: 200 });

  // Fetch the full message (webhooks only carry metadata)
  const r = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
    headers: { Authorization: `Bearer ${RESEND_KEY}` },
  });
  if (!r.ok) {
    console.error("inbound fetch failed", r.status, await r.text());
    return new Response("fetch failed", { status: 500 }); // Resend retries
  }
  const m = await r.json();

  const sender = m.from || (event.data && event.data.from) || "";
  const replyTo = (m.reply_to && m.reply_to.length ? m.reply_to : [sender]).filter(Boolean);
  const files = (m.attachments || []).map((a) => `${esc(a.filename)} (${Math.round((a.size || 0) / 1024)} KB)`);

  const banner = `<div style="font-family:Arial,sans-serif;font-size:13px;color:#555;background:#F3EBDD;border-left:4px solid #C79A3E;padding:10px 12px;margin-bottom:16px">
    <b>Gear 4 inbox</b> · From: ${esc(sender)} · To: ${esc(addr(m.to))}
    ${files.length ? `<br>Attachments (open in Resend → Emails → Received): ${files.join(", ")}` : ""}
    <br>Press <b>Reply</b> to answer the customer directly.</div>`;

  const send = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json", "Idempotency-Key": `fwd-${emailId}` },
    body: JSON.stringify({
      from: FORWARD_FROM,
      to: FORWARD_TO,
      reply_to: replyTo,
      subject: `[Gear 4] ${m.subject || "(no subject)"}`,
      html: banner + (m.html || `<pre style="white-space:pre-wrap;font-family:inherit">${esc(m.text || "")}</pre>`),
      text: `From: ${sender}\nTo: ${addr(m.to)}\n\n${m.text || ""}`,
    }),
  });
  if (!send.ok) {
    console.error("forward failed", send.status, await send.text());
    return new Response("forward failed", { status: 500 });
  }
  return new Response("ok", { status: 200 });
}
