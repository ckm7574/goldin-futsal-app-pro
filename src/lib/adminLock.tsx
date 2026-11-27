import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "./supabase";

/**
 * "한 번에 한 명만 관리자" 잠금 (서버: supabase/admin_lock_and_pin.sql)
 *
 * - PIN 확인은 서버(admin_unlock)에서만. 앱에는 PIN/해시가 없음
 * - 잠금 해제 성공 시 받은 토큰을 sessionStorage 에 보관 (탭 닫으면 사라짐)
 * - 관리자는 10초마다 서버에 ping. 그 사이 화면 조작이 있었으면 활동으로 기록
 *   → 2분 동안 조작이 없으면 서버가 자동 해제
 * - 다른 사람이 PIN + 확인창으로 가져가면, broadcast 로 즉시 알려 보기 전용 전환
 */

const TOKEN_KEY = "goldin_admin_token";
const LABEL_KEY = "goldin_admin_label";
const PING_MS = 10_000;          // 관리자 상태 확인 주기
const STATUS_POLL_MS = 15_000;   // 비관리자 화면의 잠금 상태 갱신 주기
const CHANNEL = "goldin-admin-lock";

export type LockStatus = {
  locked: boolean;
  holder_label: string | null;
  acquired_at: string | null;
  last_active_at: string | null;
  expires_in_sec: number;
};

export type UnlockResult =
  | { status: "ok" }
  | { status: "invalid_pin" }
  | { status: "busy"; holder_label: string | null; expires_in_sec: number }
  | { status: "error"; message: string };

export type LostReason = "takeover" | "idle" | "released";

function readToken(): string | null {
  try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
}
function writeToken(t: string | null) {
  try { t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY); } catch {}
}

/** 서버 함수가 아직 없을 때(SQL 미실행) 알아보기 쉬운 메시지로 */
function explain(err: any): string {
  const msg = String(err?.message ?? err ?? "");
  if (/could not find the function|PGRST202|404/i.test(msg))
    return "서버 설정이 필요합니다 (supabase/admin_lock_and_pin.sql 을 Supabase SQL Editor 에서 실행해 주세요)";
  if (/too_many_attempts/.test(msg)) return "PIN 오류가 너무 많습니다. 10분 뒤 다시 시도하세요.";
  return msg || "알 수 없는 오류";
}

export function useAdminLock(opts: { onLost?: (reason: LostReason) => void } = {}) {
  const [token, setTokenState] = useState<string | null>(() => readToken());
  const [status, setStatus] = useState<LockStatus | null>(null);
  const [checking, setChecking] = useState<boolean>(() => !!readToken()); // 저장된 토큰 확인 중
  const [label, setLabelState] = useState<string>(() => {
    try { return localStorage.getItem(LABEL_KEY) || ""; } catch { return ""; }
  });

  const tokenRef = useRef(token);
  const activeRef = useRef(false);        // 마지막 ping 이후 화면 조작 여부
  const onLostRef = useRef(opts.onLost);
  onLostRef.current = opts.onLost;
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  const setToken = useCallback((t: string | null) => {
    tokenRef.current = t;
    writeToken(t);
    setTokenState(t);
  }, []);

  const setLabel = useCallback((v: string) => {
    setLabelState(v);
    try { localStorage.setItem(LABEL_KEY, v); } catch {}
  }, []);

  const notifyChanged = useCallback(() => {
    try { channelRef.current?.send({ type: "broadcast", event: "changed", payload: {} }); } catch {}
  }, []);

  /** 내가 관리자 권한을 잃었을 때 (가져감 / 2분 무동작) */
  const lose = useCallback((reason: LostReason) => {
    if (!tokenRef.current) return;
    setToken(null);
    onLostRef.current?.(reason);
  }, [setToken]);

  const refreshStatus = useCallback(async () => {
    try {
      const { data, error } = await supabase.rpc("admin_lock_status");
      if (!error && data) setStatus(data as LockStatus);
    } catch {}
  }, []);

  /** 관리자: 서버에 활동 보고 + 아직 내가 관리자인지 확인 */
  const ping = useCallback(async () => {
    const t = tokenRef.current;
    if (!t) return;
    const active = activeRef.current;
    activeRef.current = false;
    try {
      const { data, error } = await supabase.rpc("admin_ping", { p_token: t, p_active: active });
      if (error) { if (active) activeRef.current = true; return; } // 네트워크 오류 → 다음에 재시도
      setStatus(data as LockStatus);
      if (!(data as any)?.holder && tokenRef.current === t) {
        // 다른 사람이 잡고 있으면 가져간 것, 아니면 무동작 만료
        lose((data as any)?.locked ? "takeover" : "idle");
      }
    } catch { if (active) activeRef.current = true; }
    finally { setChecking(false); }
  }, [lose]);

  // ---- 화면 조작 감지 (관리자일 때만 의미 있음) ----
  useEffect(() => {
    const mark = () => { activeRef.current = true; };
    const evs = ["pointerdown", "keydown", "input", "change", "wheel", "touchstart"];
    evs.forEach(e => window.addEventListener(e, mark, { passive: true, capture: true }));
    return () => evs.forEach(e => window.removeEventListener(e, mark, { capture: true } as any));
  }, []);

  // ---- 주기적 확인 ----
  useEffect(() => {
    if (token) {
      ping();
      const id = window.setInterval(ping, PING_MS);
      return () => window.clearInterval(id);
    }
    setChecking(false);
    refreshStatus();
    const id = window.setInterval(refreshStatus, STATUS_POLL_MS);
    return () => window.clearInterval(id);
  }, [token, ping, refreshStatus]);

  // ---- 탭으로 돌아오면 즉시 확인 ----
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === "visible") (tokenRef.current ? ping() : refreshStatus()); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [ping, refreshStatus]);

  // ---- 다른 기기의 잠금 변경 즉시 반영 (broadcast) ----
  useEffect(() => {
    const ch = supabase.channel(CHANNEL, { config: { broadcast: { self: false } } })
      .on("broadcast", { event: "changed" }, () => { tokenRef.current ? ping() : refreshStatus(); })
      .subscribe();
    channelRef.current = ch;
    return () => { supabase.removeChannel(ch); channelRef.current = null; };
  }, [ping, refreshStatus]);

  /** 잠금 해제 시도. force=true 면 현재 관리자를 밀어내고 가져옴 */
  const unlock = useCallback(async (pin: string, force = false): Promise<UnlockResult> => {
    try {
      const { data, error } = await supabase.rpc("admin_unlock", {
        p_pin: pin, p_label: label || null, p_force: force,
      });
      if (error) return { status: "error", message: explain(error) };
      const r = data as any;
      if (r?.status === "ok" && r.token) {
        activeRef.current = false;
        setToken(String(r.token));
        notifyChanged();
        refreshStatus();
        return { status: "ok" };
      }
      if (r?.status === "busy") {
        setStatus(prev => ({ ...(prev ?? {} as LockStatus), ...r, locked: true }));
        return { status: "busy", holder_label: r.holder_label ?? null, expires_in_sec: Number(r.expires_in_sec ?? 0) };
      }
      if (r?.status === "invalid_pin") return { status: "invalid_pin" };
      return { status: "error", message: "예상하지 못한 응답" };
    } catch (e) {
      return { status: "error", message: explain(e) };
    }
  }, [label, setToken, notifyChanged, refreshStatus]);

  /** 잠금 (관리자 내려놓기) */
  const release = useCallback(async () => {
    const t = tokenRef.current;
    setToken(null);
    if (t) {
      try { await supabase.rpc("admin_release", { p_token: t }); } catch {}
      notifyChanged();
    }
    refreshStatus();
  }, [setToken, notifyChanged, refreshStatus]);

  /** futsal_state 저장 (관리자 토큰 필수). 권한을 잃었으면 즉시 보기 전용 전환 */
  const save = useCallback(async (payload: unknown) => {
    const t = tokenRef.current;
    if (!t) throw new Error("not_lock_holder");
    const { error } = await supabase.rpc("futsal_save", { p_token: t, p_payload: payload });
    if (error) {
      if (/not_lock_holder/.test(error.message || "")) {
        // 바로 직전 상태 확인해서 사유 판단
        await ping();
        lose("takeover");
      }
      throw new Error(explain(error));
    }
    activeRef.current = false; // 저장 자체가 서버 활동 갱신
  }, [ping, lose]);

  /** 현재 관리자 토큰 (사진 올리기/정리용). 관리자가 아니면 null */
  const getToken = useCallback(() => tokenRef.current, []);

  return {
    isHolder: !!token,
    getToken,
    checking,
    status,
    label,
    setLabel,
    unlock,
    release,
    save,
  };
}
