import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "./supabase";

/**
 * 쓰기 직전 검사 함수.
 * - null 반환 → 그대로 저장
 * - 문자열 반환 → 위험한 변경. 사유(문자열)를 들고 저장을 보류
 */
export type WriteGuard<T> = (serverValue: T, nextValue: T) => string | null;

type Opts<T> = {
  table?: string;
  id?: string | number;
  debounceMs?: number;
  readonly?: boolean;              // true면 Supabase에 절대 write하지 않음
  guard?: WriteGuard<T>;           // 대량 삭제 등 위험한 덮어쓰기 차단
  onBlocked?: (reason: string, next: T) => boolean; // true 반환 시 사용자가 강제 저장 승인
  /** 저장 함수 (관리자 토큰 검증하는 서버 함수 futsal_save 사용). 없으면 직접 upsert */
  save?: (payload: T) => Promise<void>;
};

export type SyncStatus =
  | "loading"      // 서버에서 아직 못 불러옴 → 쓰기 금지
  | "ok"           // 서버 데이터 로드 완료 → 쓰기 허용
  | "load-error"   // 서버 로드 실패 → 쓰기 금지(재시도 중)
  | "save-error"   // 저장 실패 → 자동 재시도 중 (화면 변경은 아직 서버에 없음)
  | "blocked";     // 위험한 덮어쓰기를 막음

/**
 * 단일 row(JSON) 를 Supabase(`futsal_state`)와 동기화.
 *
 * ⚠️ 데이터 유실 방지 원칙
 *  1) 서버에서 "성공적으로" 불러오기 전에는 절대 쓰지 않는다.
 *     (로드 실패 시 초기값/기본값이 서버를 덮어쓰던 버그의 원인)
 *  2) 서버 row 가 있는데 payload 가 비어 있으면 = 비정상 → 쓰지 않는다.
 *  3) 저장 직전 guard 로 서버 마지막 값과 비교해, 경기기록/선수가 크게 줄면 차단.
 *  (서버 쪽 이력 백업/차단은 supabase/protect_futsal_state.sql 참고)
 */
export function useRealtimeJsonState<T>(initial: T, opts: Opts<T> = {}) {
  const table = opts.table ?? "futsal_state";
  const id = opts.id ?? "main";
  const debounceMs = opts.debounceMs ?? 500;
  const readonly = opts.readonly ?? false;

  const [value, setValueRaw] = useState<T>(initial);
  const [status, setStatus] = useState<SyncStatus>("loading");
  const [ready, setReady] = useState(false);       // 서버 로드 성공 여부 (= 쓰기 가능)
  const [lastError, setLastError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [saveRetryTick, setSaveRetryTick] = useState(0);
  const saveFailCountRef = useRef(0);
  const saveRetryTimer = useRef<number | null>(null);
  const prevReadonlyRef = useRef(readonly);

  // 보기 전용 → 관리자로 바뀔 때: 화면 데이터가 오래됐을 수 있으니 서버에서 다시 불러온 뒤에만 저장 허용
  useEffect(() => {
    const was = prevReadonlyRef.current;
    prevReadonlyRef.current = readonly;
    if (was && !readonly) {
      loadedRef.current = false;
      dirtyRef.current = false;
      setReady(false);
      setStatus("loading");
      setReloadTick(t => t + 1);
    }
  }, [readonly]);

  // 서버에 마지막으로 존재한다고 확인된 값 (로드/실시간/저장 성공 시 갱신)
  const serverRef = useRef<T | null>(null);
  const loadedRef = useRef(false);
  // 사용자가 직접 바꾼 값만 저장하도록: 외부(서버)에서 온 값은 dirty=false
  const dirtyRef = useRef(false);
  const timer = useRef<number | null>(null);
  const guardRef = useRef(opts.guard);
  const onBlockedRef = useRef(opts.onBlocked);
  const saveRef = useRef(opts.save);
  guardRef.current = opts.guard;
  onBlockedRef.current = opts.onBlocked;
  saveRef.current = opts.save;

  /** 앱에서 호출하는 setter — 사용자 변경으로 간주 */
  const setValue = useCallback((next: T) => {
    dirtyRef.current = true;
    setValueRaw(next);
  }, []);

  // ---- Load (실패 시 재시도, 성공 전까지 쓰기 금지) ----
  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | null = null;
    let attempt = 0;

    async function load() {
      try {
        const { data, error } = await supabase
          .from(table)
          .select("payload")
          .eq("id", id)
          .maybeSingle();
        if (cancelled) return;
        if (error) throw error;

        if (data && data.payload && typeof data.payload === "object") {
          serverRef.current = data.payload as T;
          dirtyRef.current = false;
          setValueRaw(data.payload as T);
        } else if (data) {
          // row 는 있는데 payload 가 비어 있음 → 비정상. 덮어쓰지 않도록 쓰기 금지 유지
          throw new Error("서버 데이터(payload)가 비어 있습니다");
        } else {
          // row 자체가 안 보임 → 권한(RLS) 문제나 일시 오류일 수 있음.
          // 기본값으로 서버를 덮어쓰지 않도록 쓰기 금지 유지.
          // (완전 신규 설치라면 Supabase에서 row 를 먼저 만들어 주세요: README 참고)
          throw new Error("서버에 데이터 row(id=" + id + ")가 없습니다");
        }
        loadedRef.current = true;
        setLastError(null);
        setStatus("ok");
        setReady(true);
      } catch (e: any) {
        if (cancelled) return;
        console.warn("[realtime] load failed — 쓰기 차단, 재시도 예정", e);
        setLastError(String(e?.message ?? e));
        setStatus("load-error");
        attempt += 1;
        const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
        retryTimer = window.setTimeout(load, delay);
      }
    }
    load();
    return () => { cancelled = true; if (retryTimer) window.clearTimeout(retryTimer); };
  }, [table, id, reloadTick]);

  // ---- Realtime 구독 ----
  useEffect(() => {
    const ch = supabase
      .channel(`rt-${table}-${id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table, filter: `id=eq.${id}` },
        (payload: any) => {
          const rec = payload.new || payload.record;
          if (rec?.payload && typeof rec.payload === "object") {
            serverRef.current = rec.payload as T;
            dirtyRef.current = false;
            setValueRaw(rec.payload as T);
          }
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [table, id]);

  // ---- Debounced write (가드 통과 시에만) ----
  useEffect(() => {
    if (!ready || !loadedRef.current) return;   // 서버 로드 성공 전 절대 쓰지 않음
    if (readonly) { dirtyRef.current = false; return; } // 보기 전용: 쓰지 않고, 나중에 관리자가 돼도 묵은 변경을 쓰지 않음
    if (!dirtyRef.current) return;               // 서버에서 온 값은 다시 쓰지 않음

    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      const next = value;
      const server = serverRef.current;

      if (server && guardRef.current) {
        const reason = guardRef.current(server, next);
        if (reason) {
          const force = onBlockedRef.current?.(reason, next) ?? false;
          if (!force) {
            console.warn("[realtime] 위험한 저장 차단:", reason);
            setStatus("blocked");
            setLastError(reason);
            return;
          }
        }
      }

      try {
        if (saveRef.current) {
          await saveRef.current(next);
        } else {
          const { error } = await supabase
            .from(table)
            .upsert({ id, payload: next }, { onConflict: "id" });
          if (error) throw error;
        }
        serverRef.current = next;
        dirtyRef.current = false;
        saveFailCountRef.current = 0;
        setStatus("ok");
        setLastError(null);
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        console.warn("[realtime] save failed", e);
        setLastError(msg);
        // 권한을 잃은 경우는 보기 전용으로 전환되므로 재시도하지 않음
        if (/not_lock_holder|관리자 권한/.test(msg)) return;
        setStatus("save-error");
        // 변경 내용은 그대로 두고(dirty 유지) 자동 재시도: 3s, 6s, 12s ... 최대 30s
        saveFailCountRef.current += 1;
        const delay = Math.min(30000, 3000 * 2 ** Math.min(saveFailCountRef.current - 1, 4));
        if (saveRetryTimer.current) window.clearTimeout(saveRetryTimer.current);
        saveRetryTimer.current = window.setTimeout(() => setSaveRetryTick(t => t + 1), delay);
      }
    }, debounceMs);
    return () => { if (timer.current) window.clearTimeout(timer.current); };
  }, [value, ready, readonly, table, id, debounceMs, saveRetryTick]);

  // 저장 안 된 변경이 있으면 창 닫기/새로고침 전에 경고
  useEffect(() => {
    const onBeforeUnload = (ev: BeforeUnloadEvent) => {
      if (!readonly && dirtyRef.current && loadedRef.current) {
        ev.preventDefault();
        ev.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [readonly]);

  return { value, setValue, ready, status, lastError };
}
