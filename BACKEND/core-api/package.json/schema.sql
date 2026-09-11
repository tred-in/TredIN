create extension if not exists pgcrypto;
create table if not exists users(id uuid primary key default gen_random_uuid(),user_id varchar(64) unique not null,role varchar(32) not null default 'CUSTOMER',status varchar(24) not null default 'ACTIVE',password_hash text,full_name varchar(160),mobile varchar(20),email varchar(180),created_at timestamptz not null default now(),updated_at timestamptz not null default now());
create table if not exists instruments(id varchar(80) primary key,symbol varchar(120) not null,exchange varchar(20),segment varchar(30),truedata_symbol varchar(160),enabled boolean not null default true,created_at timestamptz not null default now(),updated_at timestamptz not null default now());
create table if not exists orders(id uuid primary key default gen_random_uuid(),user_id uuid not null references users(id),instrument_id varchar(80) not null references instruments(id),side varchar(4) not null,order_type varchar(8) not null,quantity numeric(20,6) not null,limit_price numeric(20,6),trigger_price numeric(20,6),status varchar(32) not null,client_order_id varchar(100),broker_order_id varchar(160),created_at timestamptz not null default now(),updated_at timestamptz not null default now());
create table if not exists executions(id uuid primary key default gen_random_uuid(),order_id uuid not null references orders(id),fill_qty numeric(20,6) not null,fill_price numeric(20,6) not null,executed_at timestamptz not null default now(),broker_execution_id varchar(160));
create table if not exists positions(user_id uuid not null references users(id),instrument_id varchar(80) not null references instruments(id),quantity numeric(20,6) not null default 0,average_price numeric(20,6),realized_pnl numeric(24,6) not null default 0,updated_at timestamptz not null default now(),primary key(user_id,instrument_id));
create table if not exists ledger_entries(id uuid primary key default gen_random_uuid(),user_id uuid not null references users(id),entry_type varchar(40) not null,amount numeric(24,6) not null,reference_id varchar(160),status varchar(24) not null,created_at timestamptz not null default now());
create table if not exists risk_limits(user_id uuid primary key references users(id),max_order_value numeric(24,6),max_open_orders integer,max_daily_loss numeric(24,6),margin_multiplier numeric(12,4),broker_funding_limit numeric(24,6),enabled boolean not null default true,updated_at timestamptz not null default now());
create table if not exists kyc_cases(id uuid primary key default gen_random_uuid(),user_id uuid unique not null references users(id),status varchar(24) not null default 'PENDING',submitted_at timestamptz,reviewed_at timestamptz,reviewed_by uuid references users(id));
create table if not exists audit_log(id uuid primary key default gen_random_uuid(),actor_user_id uuid references users(id),action varchar(120) not null,entity_type varchar(60),entity_id varchar(160),request_id varchar(160),payload jsonb,created_at timestamptz not null default now());
create index if not exists idx_orders_user_created on orders(user_id,created_at desc);
create index if not exists idx_ledger_user_created on ledger_entries(user_id,created_at desc);
create index if not exists idx_audit_created on audit_log(created_at desc);

alter table orders add column if not exists time_in_force varchar(8) not null default 'DAY';
alter table orders add column if not exists rejection_code varchar(80);
alter table orders add column if not exists rms_status varchar(24) not null default 'PENDING';
alter table orders add column if not exists version integer not null default 1;
alter table executions add column if not exists source varchar(32) not null default 'VENUE';
alter table ledger_entries add column if not exists balance_after numeric(24,6);
create unique index if not exists uq_orders_client_order on orders(user_id,client_order_id) where client_order_id is not null;
create index if not exists idx_orders_status_created on orders(status,created_at desc);
create index if not exists idx_executions_order_time on executions(order_id,executed_at desc);

create table if not exists kyc_documents(id uuid primary key default gen_random_uuid(),case_id uuid not null references kyc_cases(id) on delete cascade,document_type varchar(60) not null,document_ref varchar(240),status varchar(24) not null default 'SUBMITTED',original_name varchar(180),mime_type varchar(120),size_bytes integer,content bytea,created_at timestamptz not null default now());
create table if not exists finance_requests(id uuid primary key default gen_random_uuid(),user_id uuid not null references users(id),request_type varchar(16) not null,amount numeric(24,6) not null,reference varchar(160),status varchar(24) not null default 'PENDING',reviewed_by uuid references users(id),reviewed_at timestamptz,created_at timestamptz not null default now());
create index if not exists idx_kyc_docs_case on kyc_documents(case_id,created_at desc);
create index if not exists idx_finance_requests_user on finance_requests(user_id,created_at desc);
create index if not exists idx_finance_requests_status on finance_requests(status,created_at desc);

alter table users add column if not exists full_name varchar(160);
alter table users add column if not exists mobile varchar(20);
alter table users add column if not exists email varchar(180);
create unique index if not exists uq_users_email on users(lower(email)) where email is not null;
create unique index if not exists uq_users_mobile on users(mobile) where mobile is not null;
alter table kyc_documents add column if not exists original_name varchar(180);
alter table kyc_documents add column if not exists mime_type varchar(120);
alter table kyc_documents add column if not exists size_bytes integer;
alter table kyc_documents add column if not exists content bytea;
