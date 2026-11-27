-- =====================================================================
-- 관리자 PIN 서버 확인 + "한 번에 한 명만 관리자" 잠금
-- (Supabase 대시보드 → SQL Editor 에서 1회 실행)
--
-- ⚠️ 실행 전에 아래 [1] 의 '여기에_새_PIN' 을 새 PIN 으로 바꾸세요.
--    (예전 PIN 8347 은 GitHub 에 공개되어 있으니 쓰지 마세요)
--
-- 이 SQL 이 하는 일
--  - PIN 은 서버에 bcrypt 해시로만 저장. 앱 코드에는 PIN 이 없음
--  - 잠금 해제에 성공한 1명에게만 "관리자 토큰" 발급
--  - 다른 사람은 그 관리자가 [잠금]을 누르거나 2분간 아무 동작이 없을 때까지 대기
--    (PIN 을 맞게 입력하면 확인창 후 가져오기 가능 → 기존 관리자는 즉시 보기 전용)
--  - futsal_state 저장은 관리자 토큰을 가진 사람만 가능 (futsal_save 함수로만)
--    → 앱(anon) 의 직접 INSERT/UPDATE/DELETE 권한 제거
--
-- protect_futsal_state.sql (이력 백업/대량삭제 거부 트리거) 와 함께 동작합니다.
-- 여러 번 실행해도 안전합니다. PIN 만 바꾸고 싶으면 맨 아래 "PIN 변경" 참고.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------- 설정/잠금 테이블 (앱에서 직접 접근 불가) ----------
create table if not exists public.admin_config (
  id        int primary key default 1 check (id = 1),
  pin_hash  text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.admin_lock (
  id             int primary key default 1 check (id = 1),
  holder_token   uuid,
  holder_label   text,
  acquired_at    timestamptz,
  last_active_at timestamptz
);
insert into public.admin_lock (id) values (1) on conflict (id) do nothing;

create table if not exists public.admin_pin_failures (
  id        bigserial primary key,
  failed_at timestamptz not null default now()
);

alter table public.admin_config       enable row level security;
alter table public.admin_lock         enable row level security;
alter table public.admin_pin_failures enable row level security;
revoke all on public.admin_config, public.admin_lock, public.admin_pin_failures from anon, authenticated;

-- ---------- [1] PIN 설정 ----------
do $$
declare new_pin text := '여기에_새_PIN';   -- ← 여기를 새 PIN 으로 바꾸세요
begin
  if new_pin = '여기에_새_PIN' then
    if not exists (select 1 from public.admin_config) then
      raise exception '[1] 의 새 PIN 을 입력한 뒤 다시 실행하세요';
    end if;
    -- 이미 PIN 이 설정돼 있으면(재실행) 기존 PIN 유지
  else
    if length(new_pin) < 4 then raise exception 'PIN 은 4자리 이상이어야 합니다'; end if;
    insert into public.admin_config (id, pin_hash)
    values (1, extensions.crypt(new_pin, extensions.gen_salt('bf', 10)))
    on conflict (id) do update set pin_hash = excluded.pin_hash, updated_at = now();
  end if;
end $$;

-- 관리자 자동 해제까지의 무동작 시간
create or replace function public.admin_idle_limit()
returns interval language sql immutable as $$ select interval '2 minutes' $$;

-- ---------- 내부: PIN 확인 (실패 시 지연 + 과도한 시도 차단) ----------
create or replace function public._admin_check_pin(p_pin text)
returns boolean language plpgsql security definer set search_path = public as $$
declare ok boolean; recent int;
begin
  select count(*) into recent from admin_pin_failures where failed_at > now() - interval '10 minutes';
  if recent >= 20 then
    raise exception 'too_many_attempts' using hint = 'PIN 오류가 너무 많습니다. 10분 뒤 다시 시도하세요.';
  end if;
  select extensions.crypt(coalesce(p_pin, ''), pin_hash) = pin_hash into ok from admin_config where id = 1;
  if not coalesce(ok, false) then
    insert into admin_pin_failures default values;
    delete from admin_pin_failures where failed_at < now() - interval '1 day';
    perform pg_sleep(1);
    return false;
  end if;
  return true;
end $$;

-- ---------- 현재 잠금 상태 (누구나 조회 가능, 토큰은 노출 안 함) ----------
create or replace function public.admin_lock_status()
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'locked', holder_token is not null and last_active_at > now() - admin_idle_limit(),
    'holder_label', holder_label,
    'acquired_at', acquired_at,
    'last_active_at', last_active_at,
    'expires_in_sec', greatest(0, extract(epoch from (last_active_at + admin_idle_limit() - now())))::int,
    'server_now', now()
  ) from admin_lock where id = 1
$$;

-- ---------- 잠금 해제(=관리자 되기) ----------
-- 반환: {status:'ok', token} | {status:'busy', holder_label, ...} | {status:'invalid_pin'}
create or replace function public.admin_unlock(p_pin text, p_label text default null, p_force boolean default false)
returns json language plpgsql security definer set search_path = public as $$
declare l admin_lock; tok uuid;
begin
  if not _admin_check_pin(p_pin) then
    return json_build_object('status', 'invalid_pin');
  end if;

  select * into l from admin_lock where id = 1 for update;   -- 동시 요청 직렬화

  if l.holder_token is not null
     and l.last_active_at > now() - admin_idle_limit()
     and not coalesce(p_force, false) then
    return json_build_object(
      'status', 'busy',
      'holder_label', l.holder_label,
      'acquired_at', l.acquired_at,
      'last_active_at', l.last_active_at,
      'expires_in_sec', greatest(0, extract(epoch from (l.last_active_at + admin_idle_limit() - now())))::int
    );
  end if;

  tok := extensions.gen_random_uuid();
  update admin_lock
     set holder_token = tok,
         holder_label = left(coalesce(nullif(trim(p_label), ''), '관리자'), 60),
         acquired_at = now(),
         last_active_at = now()
   where id = 1;
  return json_build_object('status', 'ok', 'token', tok, 'idle_limit_sec', extract(epoch from admin_idle_limit())::int);
end $$;

-- ---------- 관리자 상태 확인/활동 갱신 ----------
-- p_active=true 이면 마지막 활동 시각 갱신. 반환 {holder:true|false, ...status}
create or replace function public.admin_ping(p_token uuid, p_active boolean default false)
returns json language plpgsql security definer set search_path = public as $$
declare l admin_lock; is_holder boolean;
begin
  select * into l from admin_lock where id = 1 for update;
  is_holder := p_token is not null
               and l.holder_token = p_token
               and l.last_active_at > now() - admin_idle_limit();
  if is_holder and coalesce(p_active, false) then
    update admin_lock set last_active_at = now() where id = 1;
  elsif not is_holder and l.holder_token = p_token then
    -- 내 토큰이지만 만료됨 → 정리
    update admin_lock set holder_token = null, holder_label = null where id = 1;
  end if;
  return (select json_build_object('holder', is_holder) ::jsonb || admin_lock_status()::jsonb)::json;
end $$;

-- ---------- 잠금 (관리자 내려놓기) ----------
create or replace function public.admin_release(p_token uuid)
returns void language sql security definer set search_path = public as $$
  update admin_lock set holder_token = null, holder_label = null, acquired_at = null
   where id = 1 and holder_token = p_token
$$;

-- ---------- 저장 (관리자 토큰 필수) ----------
create or replace function public.futsal_save(p_token uuid, p_payload jsonb)
returns json language plpgsql security definer set search_path = public as $$
declare l admin_lock;
begin
  select * into l from admin_lock where id = 1 for update;
  if p_token is null or l.holder_token is distinct from p_token
     or l.last_active_at <= now() - admin_idle_limit() then
    raise exception 'not_lock_holder' using hint = '관리자 권한이 없거나 만료되었습니다';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'invalid_payload';
  end if;
  -- (protect_futsal_state.sql 의 트리거가 대량 삭제를 한 번 더 거부)
  update futsal_state set payload = p_payload where id = 1;
  if not found then
    insert into futsal_state (id, payload) values (1, p_payload);
  end if;
  update admin_lock set last_active_at = now() where id = 1;
  return json_build_object('ok', true, 'saved_at', now());
end $$;

-- ---------- 권한: 함수만 공개, 테이블 직접 쓰기는 차단 ----------
revoke all on function public._admin_check_pin(text) from public, anon, authenticated;
grant execute on function public.admin_lock_status()                to anon, authenticated;
grant execute on function public.admin_unlock(text, text, boolean)  to anon, authenticated;
grant execute on function public.admin_ping(uuid, boolean)          to anon, authenticated;
grant execute on function public.admin_release(uuid)                to anon, authenticated;
grant execute on function public.futsal_save(uuid, jsonb)           to anon, authenticated;

-- futsal_state: 읽기만 허용 (실시간 동기화용), 쓰기는 futsal_save 로만
revoke insert, update, delete on public.futsal_state from anon, authenticated;
drop policy if exists "allow anon insert" on public.futsal_state;
drop policy if exists "allow anon update" on public.futsal_state;

-- 예전 app_state 테이블도 앱에서 쓰지 못하게 (현재 앱은 사용 안 함)
do $$ begin
  if to_regclass('public.app_state') is not null then
    execute 'revoke insert, update, delete on public.app_state from anon, authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- PIN 변경 (나중에 필요할 때 이 3줄만 실행):
--   update public.admin_config
--      set pin_hash = extensions.crypt('새PIN', extensions.gen_salt('bf', 10)), updated_at = now()
--    where id = 1;
--
-- 관리자 강제 해제 (모두 보기 전용으로):
--   update public.admin_lock set holder_token = null, holder_label = null where id = 1;
-- ---------------------------------------------------------------------
