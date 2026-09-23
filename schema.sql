create extension if not exists pgcrypto;
create table if not exists users (
 id uuid primary key default gen_random_uuid(),
 name text not null,
 phone text not null unique,
 email text unique,
 password_hash text not null,
 status text not null default 'active' check(status in ('active','blocked','pending')),
 role text not null default 'user' check(role in ('user','admin')),
 created_at timestamptz not null default now()
);
create table if not exists kyc_cases (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references users(id) on delete cascade,
 status text not null default 'pending' check(status in ('pending','approved','rejected')),
 document_type text not null,
 document_ref text not null,
 submitted_at timestamptz,
 reviewed_at timestamptz,
 review_note text,
 created_at timestamptz not null default now()
);
create table if not exists instruments (
 id uuid primary key default gen_random_uuid(),
 symbol text not null unique,
 name text not null,
 exchange text not null default 'PAPER',
 last_price numeric(20,8) not null default 100,
 tick_size numeric(20,8) not null default 0.05,
 status text not null default 'active',
 updated_at timestamptz not null default now()
);
create table if not exists fund_requests (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references users(id) on delete cascade,
 type text not null check(type in ('deposit','withdrawal')),
 amount numeric(20,2) not null check(amount > 0),
 reference text,
 status text not null default 'pending' check(status in ('pending','approved','rejected')),
 reviewed_by uuid references users(id),
 reviewed_at timestamptz,
 created_at timestamptz not null default now()
);
create table if not exists fund_ledger (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references users(id) on delete cascade,
 type text not null,
 direction text not null check(direction in ('credit','debit')),
 amount numeric(20,2) not null check(amount > 0),
 reference text,
 status text not null default 'posted' check(status in ('posted','void')),
 created_at timestamptz not null default now()
);
create table if not exists orders (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references users(id) on delete cascade,
 instrument_id uuid not null references instruments(id),
 side text not null check(side in ('buy','sell')),
 order_type text not null check(order_type in ('market','limit')),
 quantity numeric(20,8) not null check(quantity > 0),
 limit_price numeric(20,8),
 status text not null default 'open',
 filled_quantity numeric(20,8) not null default 0,
 avg_fill_price numeric(20,8),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create table if not exists executions (
 id uuid primary key default gen_random_uuid(),
 order_id uuid not null references orders(id) on delete cascade,
 user_id uuid not null references users(id) on delete cascade,
 instrument_id uuid not null references instruments(id),
 side text not null check(side in ('buy','sell')),
 quantity numeric(20,8) not null,
 price numeric(20,8) not null,
 value numeric(20,2) not null,
 executed_at timestamptz not null default now()
);
create table if not exists positions (
 user_id uuid not null references users(id) on delete cascade,
 instrument_id uuid not null references instruments(id),
 quantity numeric(20,8) not null default 0,
 avg_price numeric(20,8) not null default 0,
 realized_pnl numeric(20,2) not null default 0,
 updated_at timestamptz not null default now(),
 primary key(user_id,instrument_id)
);
create table if not exists audit_log (
 id uuid primary key default gen_random_uuid(),
 actor_user_id uuid references users(id),
 action text not null,
 entity_type text not null,
 entity_id uuid,
 metadata jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now()
);
insert into instruments(symbol,name,exchange,last_price,tick_size)
values
 ('TREDIN100','TredIN Demo Index','PAPER',100,0.05),
 ('TREDINBANK','TredIN Demo Bank','PAPER',250,0.05),
 ('TREDIN50','TredIN Demo 50','PAPER',500,0.05)
on conflict(symbol) do nothing;