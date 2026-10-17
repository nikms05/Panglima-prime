// GET /api/order?session_id=cs_...  -> minimal, non-personal info for the thank-you page + Purchase pixel
import Stripe from "stripe";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export async function GET(request) {
  const id = new URL(request.url).searchParams.get("session_id") || "";
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(id)) return Response.json({ ok: false }, { status: 400 });
  try {
    const s = await stripe.checkout.sessions.retrieve(id);
    const conv = s.currency_conversion;
    return Response.json({
      ok: s.payment_status === "paid",
      order: id.slice(-8).toUpperCase(),
      boxes: Number((s.metadata && s.metadata.pack) || 0),
      value_usd: conv ? conv.amount_total / 100 : s.amount_total / 100,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (_) {
    return Response.json({ ok: false }, { status: 404 });
  }
}
