-- Admin control endpoints use existing KYC, finance, users, orders, risk and audit tables.
-- This migration only adds operational indexes for control-center queries.
create index if not exists idx_kyc_status_submitted on kyc_cases(status,submitted_at desc);
create index if not exists idx_users_status_created on users(status,created_at desc);
