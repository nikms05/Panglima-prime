-- Panglima Prime — orders table (prefixed so it can live inside an existing Supabase project)
-- Run once in Supabase: SQL Editor → New query → paste → Run

create table if not exists public.panglima_orders (
  id               bigint generated always as identity primary key,
  created_at       timestamptz not null default now(),
  stripe_session_id text not null unique,
  payment_intent   text,
  status           text not null default 'paid',      -- paid | packed | shipped | delivered | refunded
  pack_boxes       int  not null,
  lang             text,
  amount_usd       numeric(10,2),                       -- what you receive (before Stripe fees)
  amount_paid      numeric(10,2),                       -- what the customer paid
  currency_paid    text,                                -- USD or MYR
  customer_name    text,
  email            text,
  phone            text,
  address_line1    text,
  address_line2    text,
  city             text,
  postcode         text,
  state            text,
  country          text,
  tracking_number  text,
  courier          text,
  shipped_at       timestamptz,
  notes            text,
  utm              jsonb default '{}'::jsonb
);

create index if not exists panglima_orders_created_idx on public.panglima_orders (created_at desc);
create index if not exists panglima_orders_status_idx  on public.panglima_orders (status);

-- Lock the table: only the server (service role key) can read/write. No public access.
alter table public.panglima_orders enable row level security;

-- ---------------------------------------------------------------------------
-- Writes go through two SECURITY DEFINER functions that check a shared secret
-- stored in private.app_secrets (not exposed via the API). The webhook calls them
-- with the public anon key + ORDERS_SECRET, so no service-role key is needed.
-- See migration "panglima_order_rpc" in the Supabase project for the full SQL:
--   public.panglima_record_order(p_secret text, p_order jsonb) -> boolean (true = new)
--   public.panglima_mark_refunded(p_secret text, p_payment_intent text)
-- Read the secret:  select value from private.app_secrets where name = 'webhook_secret';
