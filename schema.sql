-- Database schema for X Job Application Agent (v3.2)
-- Target: Neon Postgres

create extension if not exists "pgcrypto";

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  telegram_chat_id bigint unique not null,
  telegram_username text,
  display_name text,
  role text not null default 'user',             -- user | admin
  status text not null default 'pending',        -- pending | active | suspended | deleted
  consented_at timestamptz,
  consent_version text,
  gmail_address text,
  gmail_refresh_token_enc text,                  -- AES-256-GCM, never logged
  gmail_status text not null default 'disconnected', -- disconnected | connected | error
  gmail_connected_at timestamptz,
  last_inbox_scan_at timestamptz,
  last_summary_on date,
  created_at timestamptz default now()
);

create table if not exists invites (
  code text primary key,
  created_by uuid references users(id),
  max_uses int not null default 1,
  uses int not null default 0,
  expires_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists oauth_states (
  state text primary key,
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  used boolean not null default false
);

create table if not exists user_settings (
  user_id uuid primary key references users(id) on delete cascade,
  paused boolean not null default false,
  dry_run boolean not null default true,
  dry_run_drafts_shown int not null default 0,
  ramp_stage int not null default 0,             -- 0 = dry run, 1..5 per section 12
  ramp_stage_started_at timestamptz,
  current_cap int not null default 3,
  max_cap int not null default 20,               -- admin can lower per user
  daily_read_cap int not null default 50,        -- shared posts reviewed for this user per day
  max_reads_ceiling int not null default 100,    -- admin ceiling for /reads
  manual_daily_cap int not null default 5,       -- manual URL pastes per day
  fit_threshold int not null default 40,
  timezone text not null default 'UTC',
  send_window_start int not null default 9,      -- local hour, 0-23
  send_window_end int not null default 17,
  min_send_gap_seconds int not null default 120,
  last_raise_at timestamptz,
  availability_note text,                        -- optional, used by the reply drafter
  resume_mode text not null default 'generated'  -- generated | uploaded (section 8)
);

create table if not exists global_settings (
  key text primary key,
  value text not null
);

-- Insert default global settings if not existing
insert into global_settings (key, value)
values 
  ('global_paused', 'false'),
  ('x_daily_read_cap', '130'),
  ('x_daily_thread_cap', '15'),
  ('max_applications_per_job', '10')
on conflict (key) do nothing;

create table if not exists facts_versions (
  id serial primary key,
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz default now(),
  source text,                                   -- seed | telegram_upload | manual
  facts jsonb not null,
  diff_summary text,
  source_file_url text,                          -- original PDF, private Blob path (null for Word uploads and seeds)
  source_file_sha256 text,
  source_file_pages int,
  status text not null default 'pending'         -- pending | active | rejected | superseded
);
create index if not exists idx_facts_versions_user_status on facts_versions (user_id, status);

-- Shared: one row per post, extracted once.
create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  post_id text unique not null,
  post_url text not null,
  author_handle text,
  posted_at timestamptz,
  source text not null default 'search',         -- search | manual
  submitted_by uuid references users(id),        -- set for manual ingest
  raw_text text not null,
  raw_json jsonb,
  media_urls jsonb,                              -- image URLs from the post
  transcribed_text text,                         -- Gemini transcription of images
  conversation_id text,
  author_id text,
  thread_fetched boolean default false,
  thread_post_ids jsonb,
  thread_text text,                              -- author's own follow-up posts, joined

  -- extracted
  is_job boolean,
  is_software_role boolean,
  company text,
  role text,
  location text,
  remote boolean,
  relocation_required boolean,
  visa_sponsorship text,                         -- yes | no | unknown
  min_years int,
  salary text,                                   -- logged only, never filtered
  deadline date,
  requirements jsonb,
  apply_method text,                             -- email | form | dm | link | unknown
  contact_email text,                            -- from regex only
  address_source text,                           -- text | image
  address_mx_ok boolean,
  apply_link text,                               -- from X post entities, never from the model
  apply_link_domain text,
  scam_risk text,                                -- low | medium | high
  scam_reasons jsonb,
  dedupe_hash text,
  canonical_job_id uuid references jobs(id),     -- set when marked duplicate

  fanned_out_at timestamptz,
  status text not null default 'found',
  status_reason text,
  attempts int not null default 0,
  locked_at timestamptz,
  lock_owner text,
  claim_token uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_jobs_status on jobs (status);
create index if not exists idx_jobs_contact_email on jobs (contact_email);
create index if not exists idx_jobs_apply_link on jobs (apply_link);
create index if not exists idx_jobs_dedupe_hash on jobs (dedupe_hash);

-- Per user: one row per (user, job).
create table if not exists applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  job_id uuid references jobs(id),               -- null for imported past applications
  imported boolean not null default false,
  contact_email text,                            -- copied from the job at fan-out
  route text,                                    -- email | link

  fit_score int,
  gaps jsonb,
  years_gap boolean,
  facts_version_id int references facts_versions(id),
  resume_blob_url text,
  resume_source text,                            -- generated | uploaded
  email_subject text,
  email_body text,
  cover_note text,                               -- link route
  verify_result jsonb,

  gmail_message_id text,
  gmail_thread_id text,
  applied_at timestamptz,
  follow_up_at timestamptz,
  followup_draft_id text,
  reply_type text,                               -- interview | assessment | question | rejection | auto | other
  reply_draft_id text,
  last_reply_at timestamptz,
  link_notified_at timestamptz,                  -- when a link/form post was sent to the user

  status text not null default 'queued',
  status_reason text,
  attempts int not null default 0,
  locked_at timestamptz,
  lock_owner text,
  claim_token uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, job_id)
);

create index if not exists idx_applications_user_status on applications (user_id, status);
create index if not exists idx_applications_status on applications (status);
create index if not exists idx_applications_user_contact_email on applications (user_id, contact_email);
create index if not exists idx_applications_gmail_thread_id on applications (gmail_thread_id);

-- One row per user: the serialization point for sending.
create table if not exists send_state (
  user_id uuid primary key references users(id) on delete cascade,
  active_attempt_id uuid,                        -- the one attempt in reserved or sending state, if any
  next_send_at timestamptz not null default now(),
  updated_at timestamptz default now()
);

-- Durable record of every send, written before Gmail is called.
create table if not exists send_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  application_id uuid not null references applications(id),
  state text not null default 'reserved',        -- reserved | sending | sent | failed | send_unknown | released
  recipient text not null,
  recipient_domain text not null,
  rfc_message_id text not null,                  -- stable RFC Message-ID sent in the MIME headers
  subject text not null,
  body_hash text not null,                       -- hash of the exact body sent
  resume_blob_url text not null,
  resume_sha256 text not null,
  reserved_at timestamptz not null default now(),
  started_at timestamptz,                        -- set just before the Gmail call
  finished_at timestamptz,
  gmail_message_id text,
  gmail_thread_id text,
  error text,
  reconcile_checks int not null default 0,
  last_reconcile_at timestamptz,
  resolved_by text                               -- auto | user | admin
);

create unique index if not exists send_attempts_one_active_per_user
  on send_attempts (user_id) where state in ('reserved', 'sending');

create unique index if not exists send_attempts_one_live_per_application
  on send_attempts (application_id) where state in ('reserved', 'sending', 'send_unknown');

create index if not exists idx_send_attempts_user_reserved on send_attempts (user_id, reserved_at);

create table if not exists spend (
  day date primary key,
  x_reads int default 0,
  x_cost_est numeric default 0,
  llm_calls int default 0
);

create table if not exists user_spend (
  user_id uuid references users(id) on delete cascade,
  day date,
  reviewed int default 0,                        -- applications created for this user today
  manual_reads int default 0,
  llm_calls int default 0,
  primary key (user_id, day)
);

create table if not exists events (
  id bigserial primary key,
  user_id uuid references users(id) on delete cascade,
  job_id uuid references jobs(id),
  application_id uuid references applications(id),
  at timestamptz default now(),
  type text,
  detail jsonb
);
