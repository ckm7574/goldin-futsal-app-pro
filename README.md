# 골딘 풋살 리그 · 기록/집계 (Supabase 실시간 버전)

- React + Vite + TypeScript
- 실시간 공유: Supabase (Postgres + Realtime)
- 관리자 PIN / 보기 전용 링크
- 경기별 G/A/CS 입력, GK 자동 CS, 수비상(+2), 팀 보너스(4/2/1)
- 오늘의 개인 순위 + 누적 순위(평균)

## 로컬 실행
```bash
npm i
npm run dev
```

## Vercel 배포 설정
- Build Command: `npm run build`
- Output Directory: `dist`
- Node: 20.x

### 환경 변수
- `VITE_SUPABASE_URL` = Supabase Project URL
- `VITE_SUPABASE_ANON_KEY` = Supabase anon public key

## Supabase 초기 SQL
```sql
create table if not exists public.futsal_state (
  id int primary key,
  payload jsonb
);
insert into public.futsal_state (id, payload) values (1, '{}'::jsonb)
on conflict (id) do nothing;

alter table public.futsal_state enable row level security;
create policy if not exists "allow anon read" on public.futsal_state for select to anon using (true);
create policy if not exists "allow anon insert" on public.futsal_state for insert to anon with check (id = 1);
create policy if not exists "allow anon update" on public.futsal_state for update to anon using (id = 1);

alter publication supabase_realtime add table public.futsal_state;
```

## 데이터 보호 (필수 1회 설정)
기록이 기본값으로 덮어써지는 사고를 막기 위해, Supabase 대시보드 → SQL Editor에서
`supabase/protect_futsal_state.sql`을 한 번 실행하세요.
- 모든 변경 직전 값을 `futsal_state_history`에 자동 백업 (최근 500개)
- 경기 기록/선수가 대량으로 사라지는 저장은 DB가 거부
- 앱도 서버에서 불러오기에 성공하기 전에는 절대 저장하지 않습니다
