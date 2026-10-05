-- 数据表(方案 2.2)。PostgreSQL 16。W4 接网页时启用;命令行和回归评测目前把会话存成 JSON 文件。
-- 会话状态整体放 JSONB(引擎的 SessionState);对话、事件、模型调用拆成独立表,便于统计和回看。

create table users (
  id           bigserial primary key,
  phone        text unique,
  email        text unique,
  invite_code  text,
  created_at   timestamptz not null default now(),
  deleted_at   timestamptz,                       -- 用户要求删除对话时软删,定期物理清理
  check (phone is not null or email is not null)
);

create table sessions (
  id           text primary key,                  -- 引擎生成的 sessionId
  user_id      bigint not null references users(id),
  scenario_id  text not null,
  variant      text not null default 'A',
  state        jsonb not null,                    -- SessionState
  phase        text not null,
  status       text not null default 'active',    -- active / ended / abandoned
  started_at   timestamptz not null default now(),
  ended_at     timestamptz
);
create index sessions_user_idx on sessions(user_id, started_at desc);

-- 同一会话同一时刻只处理一个请求:处理用户输入前 select ... for update 锁住 sessions 行。

create table turns (
  session_id   text not null references sessions(id) on delete cascade,
  idx          int not null,
  speaker      text not null,                     -- user / npc / system
  role_id      text,
  text         text not null,
  gate_json    jsonb,
  directive_json jsonb,
  guard_flags  text[] not null default '{}',
  tokens_in    int,
  tokens_out   int,
  cost         numeric(10, 6),
  latency_ms   int,
  created_at   timestamptz not null default now(),
  primary key (session_id, idx)
);

create table events (
  id           bigserial primary key,
  session_id   text not null references sessions(id) on delete cascade,
  turn_idx     int not null,
  type         text not null,                     -- unlock / artifact_open / experiment / commitment / trust_change / trap / cap ...
  payload      jsonb not null default '{}',
  created_at   timestamptz not null default now()
);
create index events_session_idx on events(session_id, turn_idx);
create index events_type_idx on events(type);

create table reports (
  session_id   text primary key references sessions(id) on delete cascade,
  scores       jsonb not null,                    -- ScoreReport
  evidence     jsonb not null,                    -- 校验后的裁判输出
  debrief_md   text not null,
  judge_model  text,
  judge_run_id text,
  created_at   timestamptz not null default now()
);

create table llm_calls (
  id           bigserial primary key,
  session_id   text references sessions(id) on delete set null,
  stage        text not null,                     -- gate / actor / judge / debrief
  provider     text not null,
  model        text not null,
  tokens_in    int not null default 0,
  tokens_out   int not null default 0,
  cached_tokens int not null default 0,
  cost         numeric(10, 6),
  latency_ms   int,
  ok           boolean not null,
  error        text,
  created_at   timestamptz not null default now()
);
create index llm_calls_session_idx on llm_calls(session_id);

create table feedback (
  id           bigserial primary key,
  session_id   text not null references sessions(id) on delete cascade,
  rating       int check (rating between 0 and 10),
  text         text,
  dispute      jsonb,                             -- 对某条评分的申诉:{dimension, item, reason}
  created_at   timestamptz not null default now()
);

create table redeem_codes (
  code         text primary key,
  plan         text not null,
  used_by      bigint references users(id),
  used_at      timestamptz
);
