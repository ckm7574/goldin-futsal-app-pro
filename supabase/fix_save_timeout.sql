-- =====================================================================
-- 저장 실패(시간 초과) 수정  — Supabase SQL Editor 에서 1회 실행
--
-- 원인: 데이터(선수 사진 포함)가 약 3.2MB 라서, 저장할 때마다
--       ① 본 데이터 3.2MB + ② 자동 백업(이력) 3.2MB 를 쓰느라
--       Supabase 기본 제한시간(3초)을 넘겨 저장이 취소됨
--       (오류: canceling statement due to statement timeout)
--
-- 수정:
--  1) 앱(anon) 요청 제한시간 3초 → 30초
--  2) 자동 백업(이력)에는 사진을 빼고 저장 (3.2MB → 약 0.15MB)
--     + 1분 안에 연속 저장되면 경기 수/선수 수가 바뀔 때만 백업
--     + 최근 300개만 보관 (DB 용량 보호)
--  3) 이미 쌓인 이력에서도 사진 제거 (용량 확보)
--
-- 여러 번 실행해도 안전합니다. 데이터(futsal_state)는 건드리지 않습니다.
-- =====================================================================

-- 1) 요청 제한시간 늘리기
alter role anon          set statement_timeout = '30s';
alter role authenticated set statement_timeout = '30s';
notify pgrst, 'reload config';

-- 2) 사진 제거 함수
create or replace function public.futsal_strip_photos(p jsonb)
returns jsonb language sql immutable as $$
  select case
    when jsonb_typeof(p->'players') = 'array' then
      jsonb_set(p, '{players}',
        coalesce((select jsonb_agg(x - 'photo') from jsonb_array_elements(p->'players') x), '[]'::jsonb))
    else p end
$$;

-- 보호 트리거 함수 교체 (대량 삭제 거부 규칙은 그대로, 백업 방식만 가볍게)
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

  -- 직전 값 백업 (사진 제외). 1분 안의 연속 저장은 경기 수/선수 수가 바뀔 때만
  if old.payload is distinct from new.payload
     and (old_m <> new_m or old_p <> new_p
          or not exists (select 1 from futsal_state_history
                          where saved_at > now() - interval '1 minute')) then
    insert into futsal_state_history (row_id, payload, match_count, player_count)
    values (old.id, public.futsal_strip_photos(old.payload), old_m, old_p);
    delete from futsal_state_history
     where hist_id in (select hist_id from futsal_state_history
                        order by hist_id desc offset 300);
  end if;
  return new;
end $$;

-- 3) 기존 이력에서 사진 제거 (용량 확보)
update public.futsal_state_history
   set payload = public.futsal_strip_photos(payload)
 where payload->'players' @? '$[*].photo';

-- ---------------------------------------------------------------------
-- 이력으로 되돌리기 (사진은 현재 데이터에서 선수 id 로 다시 붙임):
--   select hist_id, saved_at, match_count, player_count
--     from public.futsal_state_history order by hist_id desc limit 30;
--
--   begin;
--   set local app.allow_data_loss = 'on';
--   update public.futsal_state f
--      set payload = jsonb_set(h.payload, '{players}', (
--        select coalesce(jsonb_agg(
--                 case when c.photo is not null then hp || jsonb_build_object('photo', c.photo) else hp end), '[]'::jsonb)
--          from jsonb_array_elements(h.payload->'players') hp
--          left join lateral (
--            select cp->'photo' as photo from jsonb_array_elements(f.payload->'players') cp
--             where cp->>'id' = hp->>'id' limit 1) c on true))
--     from public.futsal_state_history h
--    where f.id = 1 and h.hist_id = <골라둔 hist_id>;
--   commit;
-- ---------------------------------------------------------------------
