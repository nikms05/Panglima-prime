# Gear 4 (gear4.my): Landing Page + Checkout Kad

Sistem jualan lengkap menggunakan akaun yang anda **sudah ada**: GitHub, Vercel, Supabase, Resend dan Stripe. Tiada langganan baru.

```
Pembeli → Landing page (Vercel) → Stripe Checkout (kad, RM atau USD) → Duit masuk akaun Stripe Rimba (USD) → Mercury
                                              │
                                              └→ Webhook → Supabase (rekod order) + Resend (e-mel pembeli & anda)
```

## Fail dalam projek

| Fail | Fungsi |
|---|---|
| `index.html` | Landing page (EN/BM) |
| `policies.html` | Hubungi, Penghantaran, Pemulangan, Privasi, Terma |
| `success.html` | Page "Terima kasih" + event Purchase untuk pixel |
| `api/checkout.js` | Cipta sesi Stripe Checkout. **Harga sebenar ditetapkan di sini** |
| `api/stripe-webhook.js` | Terima order berbayar → simpan ke Supabase → hantar e-mel |
| `api/order.js` | Maklumat ringkas order untuk page terima kasih |
| `api/rate.js` | Kadar anggaran USD→RM untuk paparan harga |
| `supabase/schema.sql` | Jadual `orders` |

---

## Langkah 1: Stripe (akaun Rimba Botanicals)

1. Dalam Stripe, klik nama akaun di kiri atas → **New account** → Rimba Botanicals LLC.
2. Lengkapkan profil: EIN, Mercury, dan website (gunakan URL Vercel dari Langkah 3).
3. **Settings → Payments → Adaptive Pricing → On.** Ini membolehkan pembeli Malaysia bayar dalam RM, sementara anda tetap terima USD.
4. **Settings → Payment methods:** aktifkan Cards, Apple Pay, Google Pay dan Link.
5. **Settings → Public details:** isi nama "Panglima Prime" dan statement descriptor `PANGLIMA PRIME`.
6. Salin **Secret key** daripada Developers → API keys. Guna `sk_test_...` dulu untuk ujian.

## Langkah 2: Supabase

1. Buat projek baru (contoh: `panglima`). Plan percuma pun cukup.
2. **SQL Editor → New query** → tampal isi `supabase/schema.sql` → **Run**.
3. ✅ Sudah dibuat: projek **Panglima Prime**, jadual `panglima_orders`, dan fungsi tulis yang dilindungi rahsia.

## Langkah 3: GitHub + Vercel

1. Buat repo **private** baru di GitHub (contoh `panglima-prime`), kemudian upload semua fail dalam folder ini.
2. Vercel → **Add New → Project** → import repo itu → Framework: **Other** → Deploy.
3. **Settings → Environment Variables**, tambah:

| Nama | Nilai |
|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_...` (tukar ke `sk_live_...` bila live) |
| `STRIPE_WEBHOOK_SECRET` | dari Langkah 4 |
| `SUPABASE_URL` | `https://xxxx.supabase.co` |
| `SUPABASE_ANON_KEY` | anon key (awam; tulisan dilindungi oleh `ORDERS_SECRET`) |
| `ORDERS_SECRET` | rahsia dalam `private.app_secrets` (sudah diset) |
| `RESEND_API_KEY` | dari Langkah 5 |
| `EMAIL_FROM` | `Panglima Prime <orders@gear4.my>` |
| `ORDER_NOTIFY_EMAIL` | e-mel anda untuk notifikasi order baru |
| `SUPPORT_EMAIL` | e-mel support (pembeli boleh terus reply) |
| `SITE_URL` | `https://gear4.my` (atau URL vercel.app) |
| `PRODUCT_IMAGE_URL` | (pilihan) URL gambar kotak untuk paparan di checkout |

4. **Deployments → Redeploy** supaya variable baru digunakan.
5. (Pilihan) **Settings → Domains** untuk sambungkan domain sendiri.

## Langkah 4: Webhook Stripe

1. Stripe → **Developers → Webhooks → Add endpoint**.
2. URL: `https://gear4.my/api/stripe-webhook`
3. Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded`.
4. Salin **Signing secret** (`whsec_...`) → masukkan ke `STRIPE_WEBHOOK_SECRET` di Vercel → Redeploy.

## Langkah 5: Resend

1. **Domains → Add domain** → masukkan rekod DNS yang diberi supaya domain disahkan.
2. **API Keys → Create** → masukkan ke `RESEND_API_KEY`.

## Langkah 6: Uji (mod test)

1. Buka site → pilih pakej → bayar menggunakan kad ujian `4242 4242 4242 4242`, tarikh masa depan, dan CVC apa-apa.
2. Semak empat perkara:
   - Anda dibawa ke page Terima kasih.
   - Ada baris baru dalam jadual `panglima_orders` di Supabase.
   - E-mel pengesahan sampai kepada pembeli dan kepada anda.
   - Bayaran muncul dalam Stripe → Payments.
3. Bila semua lulus: tukar `STRIPE_SECRET_KEY` ke `sk_live_...`, buat webhook **live** (ulang Langkah 4 dalam mod live), kemudian Redeploy.

## Langkah 7: Pixel iklan

Dalam `index.html` **dan** `success.html`, isi:
```js
const META_PIXEL_ID = "...";
const TIKTOK_PIXEL_ID = "...";
```
Event yang dihantar: PageView, ViewContent (pelawat sampai ke bahagian harga), InitiateCheckout (klik pakej), Purchase (pembayaran berjaya, dengan nilai dalam USD).

Untuk iklan BM, gunakan link `https://gear4.my/?lang=ms`. UTM dan fbclid/ttclid direkod bersama setiap order.

---

## Operasi harian

- **Order baru:** e-mel masuk ke `ORDER_NOTIFY_EMAIL`, dan rekod ada dalam Supabase → Table editor → `panglima_orders`.
- **Selepas pos:** isi `tracking_number`, `courier` dan `shipped_at`, kemudian tukar `status` kepada `shipped`.
- **Refund:** buat di Stripe. Status dalam Supabase bertukar kepada `refunded` secara automatik.

## Tukar harga

Kemas kini di **dua** tempat:
1. `api/checkout.js` → `PACKS` (dalam sen: $19 = 1900). Ini harga sebenar yang dicaj.
2. `index.html` → paparan harga, `data-rm`, dan `PACKS` dalam script.
