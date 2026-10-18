// POST /api/checkout  { pack: 1|3|5, lang: "en"|"ms", utm?: {...} }  ->  { url }
// Creates a Stripe Checkout Session. Prices are defined HERE (server-side) so they can't be tampered with.
import Stripe from "stripe";

let _stripe = null;
function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  if (!_stripe) _stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return _stripe;
}

// ---- EDIT PRICES HERE (US cents) ----
const PACKS = {
  1: { boxes: 1, cents: 1900 },
  3: { boxes: 3, cents: 4500 },
  5: { boxes: 5, cents: 6900 },
};
const SHIPPING_CENTS = 995;      // shipping for orders under FREE_SHIP_FROM boxes
const FREE_SHIP_FROM = 3;
const PRODUCT_IMAGE = process.env.PRODUCT_IMAGE_URL || ""; // optional https URL of the box photo
// -------------------------------------

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export async function POST(request) {
  let body = {};
  try { body = await request.json(); } catch (_) {}
  const pack = PACKS[Number(body.pack)];
  if (!pack) return json({ error: "invalid_pack" }, 400);
  const stripe = getStripe();
  if (!stripe) return json({ error: "payments_not_configured" }, 503);

  const lang = body.lang === "ms" ? "ms" : "en";
  const ms = lang === "ms";
  const origin = (process.env.SITE_URL || new URL(request.url).origin).replace(/\/$/, "");
  const freeShip = pack.boxes >= FREE_SHIP_FROM;

  const utm = {};
  if (body.utm && typeof body.utm === "object") {
    for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "fbclid", "ttclid"]) {
      if (typeof body.utm[k] === "string") utm[k] = body.utm[k].slice(0, 120);
    }
  }

  const params = {
    mode: "payment",
    locale: ms ? "ms" : "en",
    line_items: [{
      quantity: 1,
      price_data: {
        currency: "usd",
        unit_amount: pack.cents,
        product_data: {
          name: ms
            ? `Gear 4 Oral Strip — ${pack.boxes} kotak (${pack.boxes * 2} strip)`
            : `Gear 4 Oral Strip — ${pack.boxes} box${pack.boxes > 1 ? "es" : ""} (${pack.boxes * 2} strips)`,
          ...(PRODUCT_IMAGE ? { images: [PRODUCT_IMAGE] } : {}),
        },
      },
    }],
    shipping_address_collection: { allowed_countries: ["MY"] },
    shipping_options: [{
      shipping_rate_data: {
        type: "fixed_amount",
        fixed_amount: { amount: freeShip ? 0 : SHIPPING_CENTS, currency: "usd" },
        display_name: freeShip
          ? (ms ? "Pos percuma (parcel rahsia)" : "Free shipping (discreet parcel)")
          : (ms ? "Pos standard (parcel rahsia)" : "Standard shipping (discreet parcel)"),
      },
    }],
    phone_number_collection: { enabled: true },
    billing_address_collection: "auto",
    custom_text: {
      submit: {
        message: ms
          ? "Parcel biasa tanpa nama produk. Jaminan wang dikembalikan 30 hari."
          : "Shipped in a plain parcel with no product name. 30-day money-back guarantee.",
      },
    },
    metadata: { pack: String(pack.boxes), lang, ...utm },
    payment_intent_data: { metadata: { pack: String(pack.boxes), lang } },
    success_url: `${origin}/success.html?session_id={CHECKOUT_SESSION_ID}&lang=${lang}`,
    cancel_url: `${origin}/?lang=${lang}#pricing`,
    adaptive_pricing: { enabled: true }, // lets Malaysian buyers pay in MYR; you still settle in USD
  };

  try {
    const session = await stripe.checkout.sessions.create(params);
    return json({ url: session.url });
  } catch (err) {
    // If the account can't use one of the optional settings, retry with the plain essentials.
    try {
      const { adaptive_pricing, payment_intent_data, ...basic } = params;
      const session = await stripe.checkout.sessions.create(basic);
      console.warn("checkout: retried without optional params:", err.message);
      return json({ url: session.url });
    } catch (err2) {
      console.error("checkout error:", err2.message);
      return json({ error: "checkout_failed" }, 500);
    }
  }
}
