// GET /api/health — temporary setup check. Returns only true/false flags, never secret values.
import Stripe from "stripe";

export async function GET() {
  const env = process.env;
  const out = {
    stripe_key_set: !!env.STRIPE_SECRET_KEY,
    stripe_key_mode: env.STRIPE_SECRET_KEY ? (/_live_/.test(env.STRIPE_SECRET_KEY) ? "live" : "test") : null,
    webhook_secret_ok: /^whsec_/.test(env.STRIPE_WEBHOOK_SECRET || ""),
    resend_key_set: !!env.RESEND_API_KEY,
    order_notify_set: !!env.ORDER_NOTIFY_EMAIL,
    supabase_set: !!(env.SUPABASE_URL && env.SUPABASE_ANON_KEY && env.ORDERS_SECRET),
  };
  try {
    const stripe = new Stripe(env.STRIPE_SECRET_KEY);
    const acct = await stripe.accounts.retrieve().catch(() => null);
    if (acct) {
      out.account_name = (acct.business_profile && acct.business_profile.name) || (acct.settings && acct.settings.dashboard && acct.settings.dashboard.display_name) || null;
      out.charges_enabled = acct.charges_enabled;
      out.payouts_enabled = acct.payouts_enabled;
      out.descriptor = acct.settings && acct.settings.payments && acct.settings.payments.statement_descriptor;
      out.requirements_due = (acct.requirements && acct.requirements.currently_due || []).length;
    }
    const bal = await stripe.balance.retrieve();
    out.stripe_auth_ok = !!bal;
  } catch (e) {
    out.stripe_auth_ok = false;
    out.stripe_error = e && e.type;
  }
  return Response.json(out, { headers: { "Cache-Control": "no-store" } });
}
