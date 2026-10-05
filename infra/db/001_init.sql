-- 数据表(方案 2.2)。PostgreSQL 16。本文件是冻结契约,与 packages/contracts/src/store.ts 的 Store 接口一一对应。
-- 对话、事件、承诺账本都在 sessions.state(engine 的 SessionState)里,整体存 JSONB;
-- 需要做统计时直接查 JSONB,量大了再拆表。

create table if not exists schema_migrations (
  name        text primary key,
  applied_at  timestamptz not null default now()
);

create table if not exists users (
  id          text primary key,
  email       text not null unique,          -- 统一小写
  created_at  timestamptz not null,
  consent_at  timestamptz
);

create table if not exists invite_codes (
  code        text primary key,
  max_uses    int not null default 1 check (max_uses > 0),
  used        int not null default 0 check (used >= 0),
  note        text,
  created_at  timestamptz not null default now(),
  check (used <= max_uses)
);

create table if not exists login_codes (
  email       text primary key,
  code_hash   text not null,
  expires_at  timestamptz not null,
  attempts    int not null default 0
);

create table if not exists auth_tokens (
  token_hash  text primary key,
  user_id     text not null references users(id) on delete cascade,
  expires_at  timestamptz not null
);
create index if not exists auth_tokens_user_idx on auth_tokens(user_id);

create table if not exists sessions (
  id          text primary key,
  user_id     text not null references users(id) on delete cascade,
  scenario_id text not null,
  state       jsonb not null,
  status      text not null default 'active' check (status in ('active', 'ended')),
  started_at  timestamptz not null,
  ended_at    timestamptz,
  version     int not null default 1
);
create index if not exists sessions_user_idx on sessions(user_id, started_at desc);
create index if not exists sessions_started_idx on sessions(started_at desc);

create table if not exists reports (
  session_id  text primary key references sessions(id) on delete cascade,
  report      jsonb not null,               -- engine 的 SessionReport
  created_at  timestamptz not null
);

create table if not exists feedback (
  id          bigserial primary key,
  session_id  text not null references sessions(id) on delete cascade,
  user_id     text not null references users(id) on delete cascade,
  rating      int check (rating between 0 and 10),
  text        text,
  dispute     jsonb,                        -- {dimension, reason}
  created_at  timestamptz not null
);
create index if not exists feedback_session_idx on feedback(session_id);

create table if not exists llm_calls (
  id            bigserial primary key,
  session_id    text references sessions(id) on delete cascade,
  at            timestamptz not null,
  stage         text not null,
  provider      text not null,
  model         text not null,
  tokens_in     int not null default 0,
  tokens_out    int not null default 0,
  cached_tokens int not null default 0,
  cost_yuan     numeric(12, 6),
  latency_ms    int not null default 0,
  ok            boolean not null,
  error         text
);
create index if not exists llm_calls_session_idx on llm_calls(session_id);
