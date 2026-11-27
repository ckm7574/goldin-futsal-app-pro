-- =====================================================================
-- 선수 사진을 Supabase 파일 저장소(Storage)로 분리
-- (Supabase 대시보드 → SQL Editor → New query 에 붙여넣고 Run, 1회)
--
-- 이 SQL 이 하는 일
--  1) 'player-photos' 저장소(버킷) 생성 — 누구나 사진 보기 가능(지금과 동일)
--     · 사진 1장 최대 2MB, 이미지 파일(png/jpg/webp)만
--  2) 사진 올리기/지우기는 "현재 관리자"만 가능
--     · 관리자 토큰을 확인한 서버가 5분짜리 1회용 "업로드 허가(티켓)"를 발급
--     · 저장소는 티켓이 있는 파일 이름만 받아줌 (PIN 없이 올리기/덮어쓰기 불가)
--     · 지우기는 현재 기록에서 쓰지 않는 사진만 허용 (쓰는 사진은 못 지움)
--
-- admin_lock_and_pin.sql 을 먼저 실행한 상태여야 합니다.
-- 여러 번 실행해도 안전합니다. 기록 데이터(futsal_state)는 건드리지 않습니다.
-- =====================================================================

-- 1) 버킷
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('player-photos', 'player-photos', true, 2097152,
        array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 2) 티켓 (앱에서 직접 접근 불가)
create table if not exists public.photo_tickets (
  name       text not null,
  kind       text not null check (kind in ('upload', 'delete')),
  expires_at timestamptz not null,
  primary key (name, kind)
);
alter table public.photo_tickets enable row level security;
revoke all on public.photo_tickets from anon, authenticated;

-- 내부: 현재 관리자 토큰인지 확인 (+ 활동 시각 갱신)
create or replace function public._photo_is_holder(p_token uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare ok boolean;
begin
  update admin_lock set last_active_at = now()
   where id = 1 and p_token is not null and holder_token = p_token
     and last_active_at > now() - admin_idle_limit();
  get diagnostics ok = row_count;
  return ok;
end $$;
revoke all on function public._photo_is_holder(uuid) from public, anon, authenticated;

-- 업로드 허가: 서버가 파일 이름을 정해서 돌려줌 (추측 불가한 이름)
create or replace function public.photo_upload_ticket(p_token uuid, p_player_id text, p_ext text default 'png')
returns json language plpgsql security definer set search_path = public as $$
declare v_name text; v_ext text := lower(coalesce(p_ext, 'png'));
begin
  if not _photo_is_holder(p_token) then
    raise exception 'not_lock_holder' using hint = '관리자 권한이 없거나 만료되었습니다';
  end if;
  if p_player_id is null or p_player_id !~ '^[A-Za-z0-9_-]{1,64}$' then
    raise exception 'invalid_player_id';
  end if;
  if v_ext not in ('png', 'jpg', 'jpeg', 'webp') then
    raise exception 'invalid_ext';
  end if;
  delete from photo_tickets where expires_at < now();
  v_name := 'p/' || p_player_id || '_' || replace(gen_random_uuid()::text, '-', '') || '.' || v_ext;
  insert into photo_tickets (name, kind, expires_at) values (v_name, 'upload', now() + interval '5 minutes');
  return json_build_object('name', v_name);
end $$;

-- 삭제 허가: 현재 저장된 기록에서 쓰지 않는 사진만
create or replace function public.photo_delete_tickets(p_token uuid, p_names text[])
returns text[] language plpgsql security definer set search_path = public as $$
declare v_payload text; v_ok text[] := '{}'; n text;
begin
  if not _photo_is_holder(p_token) then
    raise exception 'not_lock_holder' using hint = '관리자 권한이 없거나 만료되었습니다';
  end if;
  select coalesce(payload::text, '') into v_payload from futsal_state where id = 1;
  delete from photo_tickets where expires_at < now();
  foreach n in array coalesce(p_names, '{}') loop
    if n ~ '^p/[A-Za-z0-9_-]+\.(png|jpg|jpeg|webp)$' and position(n in v_payload) = 0 then
      insert into photo_tickets (name, kind, expires_at) values (n, 'delete', now() + interval '5 minutes')
      on conflict (name, kind) do update set expires_at = excluded.expires_at;
      v_ok := v_ok || n;
    end if;
  end loop;
  return v_ok;
end $$;

-- 저장소 규칙에서 쓰는 티켓 확인 함수
create or replace function public.photo_ticket_ok(p_name text, p_kind text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from photo_tickets
                  where name = p_name and kind = p_kind and expires_at > now())
$$;

grant execute on function public.photo_upload_ticket(uuid, text, text) to anon, authenticated;
grant execute on function public.photo_delete_tickets(uuid, text[])    to anon, authenticated;
grant execute on function public.photo_ticket_ok(text, text)            to anon, authenticated;

-- 3) 저장소 규칙
drop policy if exists "player photos read"               on storage.objects;
drop policy if exists "player photos insert with ticket" on storage.objects;
drop policy if exists "player photos delete with ticket" on storage.objects;

create policy "player photos read" on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'player-photos');

create policy "player photos insert with ticket" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'player-photos' and public.photo_ticket_ok(name, 'upload'));

create policy "player photos delete with ticket" on storage.objects
  for delete to anon, authenticated
  using (bucket_id = 'player-photos' and public.photo_ticket_ok(name, 'delete'));

-- (덮어쓰기용 UPDATE 규칙은 일부러 만들지 않음 → 이미 올라간 사진은 바꿔치기 불가)

notify pgrst, 'reload schema';
