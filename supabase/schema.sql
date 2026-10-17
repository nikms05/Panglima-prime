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
