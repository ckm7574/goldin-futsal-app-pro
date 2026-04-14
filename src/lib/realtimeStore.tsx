import { useEffect, useRef, useState } from "react";
import { supabase } from "./supabase";

type Opts = {
  table?: string;
  id?: string;
  debounceMs?: number;
  readonly?: boolean; // true면 Supabase에 절대 write하지 않음
};

/**
 * Keep a JSON state in sync with a single row in Supabase (table `futsal_state`).
 * - Reads once on mount
 * - Subscribes to realtime UPDATE/INSERT on the same row id
 * - Writes (UPSERT) with debounce whenever local state changes
 *   → readonly=true 이면 write 완전 차단 (비인증 접속자 보호)
 * - Falls back gracefully if Supabase is misconfigured (console.warn only)
 */
export function useRealtimeJsonState<T>(initial: T, opts: Opts = {}) {
  const table = opts.table ?? "futsal_state";
  const id = opts.id ?? "main";
  const debounceMs = opts.debounceMs ?? 500;
  const readonly = opts.readonly ?? false;

  const [value, setValue] = useState<T>(initial);
  const [ready, setReady] = useState(false);
  const skipNext = useRef(false);
  const timer = useRef<number | null>(null);

  // Load once
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const { data } = await supabase
          .from(table)
          .select("payload")
          .eq("id", id)
          .single();
        if (!cancelled && data?.payload) {
          skipNext.current = true;
          setValue(data.payload as T);
        }
      } catch (e) {
        console.warn("[realtime] load failed", e);
      } finally {
        if (!cancelled) setReady(true);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [table, id]);

  // Subscribe to realtime
  useEffect(() => {
    const ch = supabase
      .channel(`rt-${table}-${id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table, filter: `id=eq.${id}` },
        (payload: any) => {
          const rec = payload.new || payload.record;
          if (rec?.payload) {
            skipNext.current = true;
            setValue(rec.payload as T);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(ch);
    };
  }, [table, id]);

  // Debounced write on change — readonly=true면 완전 차단
  useEffect(() => {
    if (!ready) return;
    if (readonly) return;          // ← 비인증 상태면 upsert 절대 안 함
    if (skipNext.current) {
      skipNext.current = false;
      return;
    }
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      try {
        const { error } = await supabase
          .from(table)
          .upsert({ id, payload: value }, { onConflict: "id" });
        if (error) {
          console.warn("[realtime] upsert error", error);
        }
      } catch (e) {
        console.warn("[realtime] upsert failed", e);
      }
    }, debounceMs);
    return () => { if (timer.current) window.clearTimeout(timer.current); };
  }, [value, ready, readonly, table, id, debounceMs]);

  return { value, setValue, ready };
}
