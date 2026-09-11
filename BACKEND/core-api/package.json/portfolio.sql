-- Derived portfolio controls. These tables never create positions/fills by themselves.
create table if not exists margin_reservations(
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references users(id),
 order_id uuid not null references orders(id),
 amount numeric(24,6) not null check(amount>=0),
 status varchar(20) not null default 'ACTIVE',
 created_at timestamptz not null default now(),
 released_at timestamptz
);
create unique index if not exists uq_margin_reservation_order on margin_reservations(order_id);
create index if not exists idx_margin_user_status on margin_reservations(user_id,status);

create table if not exists portfolio_marks(
 user_id uuid not null references users(id),
 instrument_id varchar(80) not null references instruments(id),
 ltp numeric(24,6),
 unrealized_pnl numeric(24,6),
 market_value numeric(24,6),
 marked_at timestamptz not null default now(),
 primary key(user_id,instrument_id)
);

create table if not exists reconciliation_runs(
 id uuid primary key default gen_random_uuid(),
 scope varchar(40) not null,
 status varchar(24) not null,
 checked_executions integer not null default 0,
 checked_positions integer not null default 0,
 checked_ledger_entries integer not null default 0,
 mismatch_count integer not null default 0,
 details jsonb,
 created_at timestamptz not null default now()
);
