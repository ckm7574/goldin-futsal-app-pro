-- =====================================================================
-- futsal_state 데이터 보호 (Supabase 대시보드 → SQL Editor 에서 1회 실행)
--
-- 1) 모든 변경 직전 값을 futsal_state_history 에 자동 백업 (최근 500개 유지)
-- 2) 경기 기록/선수가 대량으로 사라지는 UPDATE 는 DB 가 거부
--    → 옛날 버전 앱(캐시), 다른 기기, 직접 API 호출로도 덮어쓸 수 없음
-- 3) futsal_state 행 DELETE 금지
--
-- 의도적으로 대량 삭제가 필요하면, 같은 트랜잭션에서
--   set local app.allow_data_loss = 'on';
-- 를 먼저 실행한 뒤 UPDATE 하세요.
-- =====================================================================

create table if not exists public.futsal_state_history (
  hist_id     bigserial primary key,
  row_id      int         not null,
  payload     jsonb,
  match_count int,
  player_count int,
  saved_at    timestamptz not null default now()
);
create index if not exists futsal_state_history_saved_at_idx
  on public.futsal_state_history (saved_at desc);

-- 이력 테이블은 앱(anon)에서 읽기/쓰기 불가 (트리거만 기록)
alter table public.futsal_state_history enable row level security;
revoke all on public.futsal_state_history from anon, authenticated;

create or replace function public.futsal_count_matches(p jsonb)
returns int language sql immutable as $$
  select coalesce(sum(jsonb_array_length(
           case when jsonb_typeof(v->'matches') = 'array' then v->'matches' else '[]'::jsonb end
         )), 0)::int
  from jsonb_each(coalesce(p->'sessionsByDate', '{}'::jsonb)) as e(k, v)
$$;

create or replace function public.futsal_count_players(p jsonb)
returns int language sql immutable as $$
  select case when jsonb_typeof(p->'players') = 'array'
              then jsonb_array_length(p->'players') else 0 end
$$;

create or replace function public.futsal_state_protect()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  old_m int; new_m int; old_p int; new_p int;
  allow boolean := coalesce(current_setting('app.allow_data_loss', true), '') = 'on';
begin
  if tg_op = 'DELETE' then
    if allow then return old; end if;
    raise exception 'futsal_state 삭제는 금지되어 있습니다 (데이터 보호)';
  end if;

  old_m := public.futsal_count_matches(old.payload);
  new_m := public.futsal_count_matches(new.payload);
  old_p := public.futsal_count_players(old.payload);
  new_p := public.futsal_count_players(new.payload);

  if not allow then
    if new.payload is null or jsonb_typeof(new.payload) <> 'object' then
      raise exception '빈/잘못된 payload 로 덮어쓸 수 없습니다 (데이터 보호)';
    end if;
    if old_m > 0 and new_m = 0 then
      raise exception '경기 기록 %개가 모두 사라지는 저장을 거부했습니다 (데이터 보호)', old_m;
    end if;
    if old_m - new_m > 12 then
      raise exception '경기 기록이 %개 → %개로 급감하는 저장을 거부했습니다 (데이터 보호)', old_m, new_m;
    end if;
    if old_p > 0 and old_p - new_p > 3 then
      raise exception '선수가 %명 → %명으로 급감하는 저장을 거부했습니다 (데이터 보호)', old_p, new_p;
    end if;
  end if;

  -- 내용이 실제로 바뀔 때만 직전 값 백업
  if old.payload is distinct from new.payload then
    insert into public.futsal_state_history (row_id, payload, match_count, player_count)
    values (old.id, old.payload, old_m, old_p);
    delete from public.futsal_state_history
     where hist_id in (select hist_id from public.futsal_state_history
                       order by hist_id desc offset 500);
  end if;
  return new;
end $$;

drop trigger if exists futsal_state_protect_trg on public.futsal_state;
create trigger futsal_state_protect_trg
  before update or delete on public.futsal_state
  for each row execute function public.futsal_state_protect();

-- (선택) 앱에서 DELETE 권한 자체를 제거
revoke delete on public.futsal_state from anon, authenticated;

-- ---------------------------------------------------------------------
-- 복구 방법 예시
--   1) 이력 보기:
--      select hist_id, saved_at, match_count, player_count
--        from public.futsal_state_history order by hist_id desc limit 30;
--   2) 특정 시점으로 되돌리기 (hist_id 를 골라서):
--      begin;
--      set local app.allow_data_loss = 'on';
--      update public.futsal_state f set payload = h.payload
--        from public.futsal_state_history h
--       where f.id = 1 and h.hist_id = <골라둔 hist_id>;
--      commit;
-- ---------------------------------------------------------------------
