-- TredIN Step 10: server-authoritative notifications and support
create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  type varchar(64) not null default 'SYSTEM',
  title varchar(200) not null,
  message text not null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_notifications_user_created on notifications(user_id, created_at desc);

create table if not exists support_tickets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  subject varchar(200) not null,
  category varchar(64) not null default 'GENERAL',
  priority varchar(16) not null default 'NORMAL',
  status varchar(32) not null default 'OPEN',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz
);
create index if not exists idx_support_tickets_user_updated on support_tickets(user_id, updated_at desc);
create index if not exists idx_support_tickets_status_updated on support_tickets(status, updated_at desc);

create table if not exists support_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references support_tickets(id) on delete cascade,
  sender_user_id uuid not null references users(id),
  message text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_support_messages_ticket_created on support_messages(ticket_id, created_at asc);
