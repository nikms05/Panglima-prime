// GET /api/rate -> { rate } approximate USD→MYR, cached at the edge for 6 hours.
// Display only. Stripe shows the exact Ringgit amount at checkout.
export async function GET() {
  try {
    const r = await fetch("https://api.frankfurter.app/latest?from=USD&to=MYR", { headers: { Accept: "application/json" } });
    const j = await r.json();
    const rate = j && j.rates && j.rates.MYR;
    if (!rate) throw new Error("no rate");
    return new Response(JSON.stringify({ rate, date: j.date }), {
      headers: { "Content-Type": "application/json", "Cache-Control": "public, s-maxage=21600, stale-while-revalidate=86400" },
    });
  } catch (_) {
    return new Response(JSON.stringify({ rate: null }), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "s-maxage=600" } });
  }
}
