-- 第三轮(docs/dev-spec-r3-2026-10-05.md):手机号登录、候补名单、事件、兑换码、"想玩下一个场景"。
-- 只增不改 001_init.sql 的语义;对应 packages/contracts/src/store.ts 里标了「第三轮」的部分。

-- 手机号用户:email 可以为空,但 email 与 phone 至少有一个
alter table users alter column email drop not null;
alter table users add column phone text unique;           -- "+86" 开头的 E.164
alter table users add constraint users_email_or_phone check (email is not null or phone is not null);

-- 验证码按"地址"存:统一小写的邮箱,或 "+86…" 手机号
alter table login_codes rename column email to address;

alter table feedback add column want_next boolean;

create table waitlist (
  email        text primary key,                       -- 统一小写
  role         text,
  note         text,
  source       text,
  created_at   timestamptz not null,
  invited_at   timestamptz,
  invite_code  text
);
create index waitlist_created_idx on waitlist(created_at, email);

create table events (
  id          bigserial primary key,
  at          timestamptz not null,
  type        text not null,
  user_id     text references users(id) on delete set null,
  session_id  text references sessions(id) on delete cascade,
  visitor_id  text,
  props       jsonb not null default '{}'::jsonb
);
create index events_at_idx on events(at);
create index events_type_at_idx on events(type, at);
create index events_session_idx on events(session_id);
create index events_user_idx on events(user_id);
create index events_visitor_idx on events(visitor_id);

create table redeem_codes (
  code         text primary key,                       -- XXXX-XXXX-XXXX
  product_id   text not null,
  note         text,
  created_at   timestamptz not null,
  redeemed_by  text references users(id) on delete set null,
  redeemed_at  timestamptz,
  check (redeemed_by is null or redeemed_at is not null)  -- 兑换人被删除后码仍然算用过(看 redeemed_at)
);
create index redeem_codes_product_idx on redeem_codes(product_id, created_at desc);
create index redeem_codes_user_idx on redeem_codes(redeemed_by);
