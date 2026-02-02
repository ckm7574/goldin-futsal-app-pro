
function getActiveTeamsSafe(maybeCur?: any): TeamId[] {
  const enabled = !!(maybeCur && typeof maybeCur === "object" && "hasTeamD" in maybeCur && maybeCur.hasTeamD);
  return getActiveTeams(enabled);
}
/* App.tsx — 팀별 조끼 색 포메이션 미리보기 + 랭킹 보드 개선 포함 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useRealtimeJsonState } from "./lib/realtimeStore";
import FifaSection from "./components/FifaSection.supabase";

// ---- Uniform SVG icon (round neck) ----
    const UniformIcon: React.FC<{ fill: string; size: number; stroke?: string }> = ({ fill, size, stroke = "#111" }) => (
      <svg viewBox="0 0 100 100" x={-(size*1.25)/2} y={-(size)/2} width={size * 1.25} height={size} aria-hidden>
        <path d="M8 26 L28 12 L42 20 L58 20 L72 12 L92 26 L84 38 L72 32 L72 90 L28 90 L28 32 L16 38 Z"
              fill={fill} stroke={stroke} strokeWidth="2" />
        <circle cx="50" cy="22" r="6" fill="#111" />
      </svg>
    );
const tail3 = (name: string) => name.slice(Math.max(0, name.length - 3));

import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  LineChart, Line, CartesianGrid
} from "recharts";

/* ====== 공통 타입/유틸 ====== */
const TEAM_IDS = ["A","B","C","D"] as const;
// helper: active teams based on hasTeamD
function getActiveTeams(hasTeamD: boolean): TeamId[] {
  return hasTeamD ? (["A","B","C","D"] as TeamId[]) : (["A","B","C"] as TeamId[]);
}

type TeamId = typeof TEAM_IDS[number];
type FormationKey = "1-2-1" | "2-2" | "3-1" | "2-2-2";

type Player = { id: string; name: string; active: boolean; pos: "필드" | "GK" };
type Match = {
  id: string;
  seq: number;
  home: TeamId;
  away: TeamId;
  hg: number;
  ag: number;
  gkHome?: string | null;
  gkAway?: string | null;
};
type MatchStats = Record<string, { goals: number; assists: number; cleansheets?: number }>;
type Session = {
  rosters: Record<TeamId, string[]>;
  matches: Match[];
  matchStats: Record<string, MatchStats>;
  defAwards: Record<TeamId, string | null>;
  teamNames?: Record<TeamId, string>;
  notes: string;
  hasTeamD?: boolean;
  rosterViewConfirmed?: Record<TeamId, boolean>;
  formations?: Record<TeamId, FormationKey>; /* ✅ 팀별 포메이션 */
  posOverrides?: Record<string, Player['pos']>; /* ✅ 날짜별 포지션(오늘만) */
};
type PersistShape = {
  players: Player[];
  cardPrefs?: Record<string, { style?: string }>;
  teamNames: Record<TeamId, string>;
  sessionsByDate: Record<string, Session>;
  sessionDate: string;
};

const DEFAULT_PLAYERS = [
  { name: "강민성", pos: "필드" },
  { name: "이용범", pos: "GK" },
  { name: "이호준", pos: "필드" },
  { name: "최광민", pos: "필드" },
  { name: "성은호", pos: "필드" },
  { name: "배호성", pos: "필드" },
  { name: "강종혁", pos: "필드" },
  { name: "이창주", pos: "필드" },
  { name: "주경범", pos: "필드" },
  { name: "최우현", pos: "필드" },
  { name: "최준형", pos: "GK" },
  { name: "김한진", pos: "GK" },
  { name: "장지영", pos: "필드" },
  { name: "최준혁", pos: "필드" },
  { name: "정민창", pos: "필드" },
  { name: "김규연", pos: "필드" },
  { name: "김병준", pos: "필드" },
  { name: "윤호석", pos: "필드" },
  { name: "이세형", pos: "필드" },
  { name: "정제윈", pos: "필드" },
  { name: "한형진", pos: "필드" },
] as const;

const uid = () => Math.random().toString(36).slice(2, 9);
const DAY_MS = 24 * 60 * 60 * 1000;
const toISO = (d: Date) => {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), da = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${da}`;
};
const ensureSunday = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    const t = new Date(); const add = (7 - t.getDay()) % 7;
    return toISO(new Date(t.getTime() + add * DAY_MS));
  }
  const add = (7 - d.getDay()) % 7;
  return toISO(new Date(d.getTime() + add * DAY_MS));
};
const asArray = <T = any,>(v: any, def: T[] = []) => (Array.isArray(v) ? (v as T[]) : def);
const asNumber = (v: any, def = 0) => { const n = Number(v); return Number.isFinite(n) ? n : def; };
const isTeamId = (v: any): v is TeamId => v === "A" || v === "B" || v === "C" || v === "D";

const LS_KEY = "goldin_futsal_app_main_v15";

// ---- URL-based mode detection ----
function detectAdminFromURL(): boolean {
  try {
    const loc = window.location;
    const s = (loc.search + loc.hash + loc.pathname + loc.hostname).toLowerCase();
    // supports ?admin=1, #admin, /admin path, admin subdomain
    return s.includes("admin=1") || s.includes("#admin") || s.includes("/admin") || s.includes("admin.");
  } catch { return false; }
}
function detectViewerFromURL(): boolean {
  try {
    const loc = window.location;
    const s = (loc.search + loc.hash + loc.pathname + loc.hostname).toLowerCase();
    // supports ?view=1, #view, /view path, view subdomain
    return s.includes("view=1") || s.includes("#view") || s.includes("/view") || s.includes("view.");
  } catch { return false; }
}

// ===== Unified Supabase persistence (app_state JSON; no login required if RLS allows) =====
const APP_STATE_ID = "default";
type AppPersist = PersistShape;

async function loadSupabaseClient(): Promise<any | null> {
  const w: any = globalThis as any;
  if (w?.supabase) return w.supabase;
  const candidates = [
    "./supabaseClient", "../supabaseClient", "../../supabaseClient", "../../../supabaseClient",
    "./lib/supabaseClient", "../lib/supabaseClient", "../../lib/supabaseClient"
  ];
  for (const c of candidates) {
    try {
      const mod: any = await import(/* @vite-ignore */ c);
      const sb = mod?.supabase || mod?.default || mod;
      if (sb) return sb;
    } catch {}
  }
  return null;
}

function isBlankPersist(s: AppPersist | null | undefined): boolean {
  try {
    const noPlayers = !Array.isArray(s?.players) || s!.players.length === 0;
    const sess = (s as any)?.sessionsByDate || {};
    const noSessions = !sess || Object.keys(sess).length === 0;
    return noPlayers && noSessions;
  } catch { return false; }
}

async function loadPersistFromSupabase(): Promise<AppPersist | null> {
  try {
    const sb = await loadSupabaseClient(); if (!sb) return null;
    const { data, error } = await sb.from("app_state").select("state").eq("id", APP_STATE_ID).maybeSingle();
    if (error) return null;
// Upload changes only when authed (debounced)
useEffect(() => {
  if (!authed) return;
  const nextState = { players, teamNames: globalTeamNames, sessionsByDate, sessionDate };
  if (debTimerRef.current) clearTimeout(debTimerRef.current);
  debTimerRef.current = setTimeout(async () => {
    await savePersistToSupabase(nextState);
    if (typeof setCloud === 'function') setCloud(nextState);
  }, 500);
}, [authed, players, globalTeamNames, sessionsByDate, sessionDate]);
    return (data?.state as AppPersist) ?? null;
  } catch { return null; }
}

async function savePersistToSupabase(state: AppPersist): Promise<void> {
  try {
    const sb = await loadSupabaseClient(); if (!sb) return;
    if (isBlankPersist(state)) return;
    await sb.from("app_state").upsert({ id: APP_STATE_ID, state, updated_at: new Date().toISOString() }, { onConflict: "id" });
  } catch {}
}
const SS_PIN_AUTHED = "goldin_futsal_admin_authed";
const FIXED_PIN_HASH = "350c94d619f6aba3379500ff11bfcca6e58b0afe5b3624d0ad56fa607845e38c"; // sha256("8347")

/* 팀별 조끼 색 (필요시 여기만 변경) */
const TEAM_PINNIES: Record<TeamId, "red" | "yellow" | "green" | "white" > = { A: "red", B: "yellow", C: "green", D: "white" };

const TEAM_LABELS: Record<TeamId, string> = { A: "빨강 팀", B: "노랑 팀", C: "초록 팀", D: "흰색 팀" };
const TEAM_SWATCH_HEX: Record<TeamId, string> = { A: "#d32f2f", B: "#f1c40f", C: "#2ecc71", D: "#eaeaea" };

const TeamSwatch: React.FC<{ team: TeamId; size?: number; rounded?: number }> = ({ team, size = 14, rounded = 4 }) => (
  <span
    style={{
      display: "inline-block",
      width: size,
      height: size,
      borderRadius: rounded,
      background: TEAM_SWATCH_HEX[team],
      border: "1px solid rgba(0,0,0,0.2)",
      verticalAlign: "middle"
    }}
  />
);

const TeamPicker: React.FC<{
  value: TeamId;
  teams: TeamId[];
  disabled?: boolean;
  onChange: (v: TeamId) => void;
}> = ({ value, teams, disabled = false, onChange }) => {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement | null>(null);
  const btnRef = React.useRef<HTMLButtonElement | null>(null);
  const [menuPos, setMenuPos] = React.useState<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 0 });

  const syncPos = React.useCallback(() => {
    const btn = btnRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    // Use fixed positioning so it won't be clipped by overflow/stacking contexts (mobile Safari issue)
    setMenuPos({
      top: Math.round(r.bottom + 6),
      left: Math.round(r.left),
      width: Math.round(r.width),
    });
  }, []);

  React.useEffect(() => {
    if (!open) return;
    syncPos();

    const onDoc = (e: MouseEvent) => {
      const root = ref.current;
      if (!root) return;
      if (!root.contains(e.target as Node)) setOpen(false);
    };

    const onScroll = () => syncPos();
    const onResize = () => syncPos();

    document.addEventListener("mousedown", onDoc);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);

    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, syncPos]);

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <button
        ref={btnRef}
        type="button"
        className="team-select"
        disabled={disabled}
        onClick={() => setOpen(o => !o)}
        style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <span>{TEAM_LABELS[value]}</span>
          <TeamSwatch team={value} />
        </span>
        <span className="subtle" style={{ marginLeft: 6 }}>▾</span>
      </button>

      {open && (
        <div
          role="listbox"
          style={{
            position: "fixed",
            top: menuPos.top,
            left: menuPos.left,
            width: menuPos.width,
            zIndex: 9999,
            border: "1px solid rgba(255,255,255,0.12)",
            background: "rgba(18,18,18,0.98)",
            borderRadius: 12,
            padding: 6,
            boxShadow: "0 10px 24px rgba(0,0,0,0.35)",
            maxHeight: 260,
            overflowY: "auto",
          }}
        >
          {teams.map(tid => (
            <button
              key={tid}
              type="button"
              role="option"
              aria-selected={tid === value}
              onClick={() => {
                onChange(tid);
                setOpen(false);
              }}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                padding: "10px 10px",
                borderRadius: 10,
                border: "none",
                background: tid === value ? "rgba(255,255,255,0.08)" : "transparent",
                color: "inherit",
                cursor: "pointer",
              }}
            >
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <span>{TEAM_LABELS[tid]}</span>
                <TeamSwatch team={tid} />
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};


/* ====== 세션 초기화/로드 ====== */
function emptySession(): Session {
  return {
    rosters: { A: [], B: [], C: [], D: [] },
    matches: [],
    matchStats: {},
    defAwards: { A: null, B: null, C: null, D: null },
    teamNames: undefined,
    notes: "",
    hasTeamD: false,
    rosterViewConfirmed: { A: false, B: false, C: false, D: false },
    formations: { A: "1-2-1", B: "1-2-1", C: "1-2-1", D: "1-2-1" },
    posOverrides: {},
  };
}

function normalizeLoaded(data: any): PersistShape {
  const today = ensureSunday(toISO(new Date()));
  let players = asArray<any>(data?.players, []).map((p: any) => ({
    id: p?.id || uid(), name: String(p?.name || "?"), active: p?.active !== false, pos: p?.pos === "GK" ? "GK" : "필드"
  })) as Player[];
  if (players.length === 0) players = DEFAULT_PLAYERS.map(p => ({ id: uid(), name: p.name, active: true, pos: p.pos as any }));

  const globalTeamNames: Record<TeamId, string> = {
    A: String(data?.teamNames?.A || "팀 A"),
    B: String(data?.teamNames?.B || "팀 B"),
    C: String(data?.teamNames?.C || "팀 C"),
    D: String(data?.teamNames?.D || "팀 D")
  };

  let sessionsByDate: Record<string, Session> = {};
  if (data?.sessionsByDate && typeof data.sessionsByDate === "object") {
    for (const [k, v] of Object.entries<any>(data.sessionsByDate)) {
      const s = v || {};
      const rosters = { A: asArray<string>(s?.rosters?.A, []), B: asArray<string>(s?.rosters?.B, []), C: asArray<string>(s?.rosters?.C, []), D: asArray<string>(s?.rosters?.D, []) };
      const matches = asArray<any>(s?.matches, []).map((m: any) => ({
        id: String(m?.id || uid()), seq: asNumber(m?.seq, 0),
        home: isTeamId(m?.home) ? m.home : "A", away: isTeamId(m?.away) ? m.away : "B",
        hg: asNumber(m?.hg, 0), ag: asNumber(m?.ag, 0),
        gkHome: (m?.gkHome || "") || null, gkAway: (m?.gkAway || "") || null
      })) as Match[];
      const rawMS = typeof s?.matchStats === "object" && s?.matchStats ? s.matchStats : {};
      const matchStats: Record<string, MatchStats> = {};
      Object.keys(rawMS).forEach(mid => {
        const row = rawMS[mid] || {};
        const safe: MatchStats = {} as any;
        Object.keys(row).forEach(pid => {
          const v = row[pid] || {};
          safe[pid] = { goals: asNumber(v.goals, 0), assists: asNumber(v.assists, 0), cleansheets: asNumber(v.cleansheets, 0) };
        });
        matchStats[mid] = safe;
      });
      const defAwards: Record<TeamId, string | null> = {
        A: typeof s?.defAwards?.A === "string" ? s.defAwards.A : null,
        B: typeof s?.defAwards?.B === "string" ? s.defAwards.B : null,
        C: typeof s?.defAwards?.C === "string" ? s.defAwards.C : null,
        D: typeof s?.defAwards?.D === "string" ? s.defAwards.D : null
      };
      const notes = String(s?.notes || "");
      
      const hasTeamD: boolean = Boolean(s?.hasTeamD);
const teamNames = (s?.teamNames && typeof s.teamNames === "object")
        ? ({ A: String(s.teamNames.A || globalTeamNames.A), B: String(s.teamNames.B || globalTeamNames.B), C: String(s.teamNames.C || globalTeamNames.C) })
        : undefined;
      const rosterViewConfirmed: Record<TeamId, boolean> = {
        A: Boolean(s?.rosterViewConfirmed?.A),
        B: Boolean(s?.rosterViewConfirmed?.B),
        C: Boolean(s?.rosterViewConfirmed?.C),
      };
      const formations: Record<TeamId, FormationKey> = {
        A: (s?.formations?.A as FormationKey) || "1-2-1",
        B: (s?.formations?.B as FormationKey) || "1-2-1",
        C: (s?.formations?.C as FormationKey) || "1-2-1",
      };

            const posOverrides: Record<string, Player['pos']> = (s?.posOverrides && typeof s.posOverrides === "object") ? (Object.fromEntries(Object.entries<any>(s.posOverrides).map(([pid, pos]) => [String(pid), (pos === "GK" ? "GK" : "필드")])) as any) : {};
      sessionsByDate[ensureSunday(k)] = { rosters, matches, matchStats, defAwards, teamNames, notes, rosterViewConfirmed, formations, posOverrides };
    }
  } else {
    sessionsByDate[today] = emptySession();
  }

  const sessionDate = ensureSunday(String(data?.sessionDate || today));
  if (!sessionsByDate[sessionDate]) sessionsByDate[sessionDate] = emptySession();

  Object.values(sessionsByDate).forEach(sess => {
    const list = asArray(sess.matches, []);
    let seq = 1; for (const m of list) { if (!m.seq || m.seq <= 0) m.seq = seq; seq++; }
    if (!sess.rosterViewConfirmed) sess.rosterViewConfirmed = { A: false, B: false, C: false };
    if (!sess.formations) sess.formations = { A: "1-2-1", B: "1-2-1", C: "1-2-1" };
    if (!sess.posOverrides) sess.posOverrides = {};

  });

  return { players, teamNames: globalTeamNames, sessionsByDate, sessionDate };
}

function loadLocal(): PersistShape | null {
  try { const raw = localStorage.getItem(LS_KEY); return raw ? normalizeLoaded(JSON.parse(raw)) : null; } catch { return null; }
}
function saveLocal(s: PersistShape) { try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch {} }

function getQueryFlag(...keys: string[]) {
  const q = new URLSearchParams(window.location.search);
  return keys.some(k => q.get(k) === "1" || q.get(k) === "true" || q.has(k));
}

const pickState = (x: any) => ({
  players: x?.players, teamNames: x?.teamNames, sessionsByDate: x?.sessionsByDate, sessionDate: x?.sessionDate,
});

/* ====== 순위 계산 유틸 ====== */
type StandingRow = { team: TeamId; pts: number; gf: number; ga: number; gd: number; w: number; d: number; l: number };
function computeStandings(matchesInput: Match[] | null | undefined): StandingRow[] {
  const matches = asArray<Match>(matchesInput, []);
  const t: Record<TeamId, StandingRow> = {
    A: { team: "A", pts: 0, gf: 0, ga: 0, gd: 0, w: 0, d: 0, l: 0 },
    B: { team: "B", pts: 0, gf: 0, ga: 0, gd: 0, w: 0, d: 0, l: 0 },
    C: { team: "C", pts: 0, gf: 0, ga: 0, gd: 0, w: 0, d: 0, l: 0 },
    D: { team: "D", pts: 0, gf: 0, ga: 0, gd: 0, w: 0, d: 0, l: 0 }
  };
  
  const seen = new Set<TeamId>();
for (const m of matches) {
        seen.add(m.home as TeamId);
    seen.add(m.away as TeamId);
const HG = asNumber(m.hg, 0), AG = asNumber(m.ag, 0);
    t[m.home].gf += HG; t[m.home].ga += AG; t[m.away].gf += AG; t[m.away].ga += HG;
    if (HG > AG) { t[m.home].pts += 3; t[m.home].w++; t[m.away].l++; }
    else if (HG < AG) { t[m.away].pts += 3; t[m.away].w++; t[m.home].l++; }
    else { t[m.home].pts++; t[m.away].pts++; t[m.home].d++; t[m.away].d++; }
  }
  for (const k of TEAM_IDS) t[k].gd = t[k].gf - t[k].ga;
  return Object.values(t).sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || a.team.localeCompare(b.team));
}
function computeTeamBonus(st: StandingRow[], hasTeamD: boolean): Record<TeamId, number> {
  const order = st.map(s => s.team);
  const map: { [k in TeamId]: number } = { A: 0, B: 0, C: 0, D: 0 };
  if (hasTeamD) {
    order.forEach((tid, i) => { map[tid] = i === 0 ? 4 : i === 1 ? 3 : i === 2 ? 2 : 1; });
  } else {
    // up to 3 teams -> 4,2,1 (with 2 teams => 4,2)
    order.forEach((tid, i) => { map[tid] = i === 0 ? 4 : i === 1 ? 2 : 1; });
  }
  return map;
}
/* ====== 포메이션 컴포넌트 ====== */
const FORMATION_POINTS: Record<FormationKey, { x: number; y: number; label: string }[]> = {
  /* 좌우 0~100, 상단 상대 진영 */
  "1-2-1": [
    { x: 50, y: 92, label: "GK" },
    { x: 50, y: 100, label: "DF" },
    { x: 30, y: 70, label: "MF" }, { x: 70, y: 70, label: "MF" },
    { x: 50, y: 40, label: "FW" },
  ],
  "2-2": [
    { x: 50, y: 92, label: "GK" },
    { x: 30, y: 90, label: "DF" }, { x: 70, y: 90, label: "DF" },
    { x: 30, y: 50, label: "FW" }, { x: 70, y: 50, label: "FW" },
  ],
  "3-1": [
    { x: 50, y: 92, label: "GK" },
    { x: 20, y: 90, label: "DF" }, { x: 50, y: 90, label: "DF" }, { x: 80, y: 90, label: "DF" },
    { x: 50, y: 50, label: "FW" },
  ],
    "2-2-2": [
    { x: 50, y: 92, label: "GK" },
    { x: 30, y: 100, label: "DF" }, { x: 70, y: 100, label: "DF" },
    { x: 30, y: 70, label: "MF" }, { x: 70, y: 70, label: "MF" },
    { x: 30, y: 40, label: "FW" }, { x: 70, y: 40, label: "FW" },
  ],
"2-2-1": [
  { x: 50, y: 92, label: "GK" },
  { x: 30, y: 100, label: "DF" }, { x: 70, y: 100, label: "DF" },
  { x: 30, y: 70, label: "MF" }, { x: 70, y: 70, label: "MF" },
  { x: 50, y: 40, label: "FW" },
]};

function initials(name: string) {
  const t = name.trim();
  if (!t) return "?";
  const parts = t.split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return t.slice(0, 2).toUpperCase();
}


function FormationPreview({
  team, roster, players, teamName, formation, color, posOverrides
}: {
  team: TeamId;
  roster: string[];
  players: Player[];
  teamName: string;
  formation: FormationKey;
  color: "red" | "yellow" | "green" | "white";
  posOverrides?: Record<string, Player['pos']>;
}) {
  // --- Selection (FORMATION = fields only; GK separate) ---
  const effPos = (id: string): Player['pos'] => (posOverrides?.[id] || (players.find(p => p.id === id)?.pos) || "필드");
  const gkIds = roster.filter(id => effPos(id) === "GK");
  const singleGK = gkIds.length === 1 ? gkIds[0] : null;
  const fields = roster.filter(id => effPos(id) !== "GK");

  // points: [0]=GK, others=field slots
  const formationUsed: FormationKey = (fields.length >= 6 ? "2-2-2" : formation);
  const pts = FORMATION_POINTS[formationUsed];
  const coordsFields = pts.slice(1);
  const chosenFields = fields.slice(0, coordsFields.length);

  const jerseyFill =
    color === "red" ? "var(--jersey-red)" :
    color === "yellow" ? "var(--jersey-yellow)" :
    color === "green" ? "var(--jersey-green)" : "var(--jersey-white)";

  return (
    <div className="formation-card">
      <div className="formation-title">{teamName} <span className="subtle">({team}) · {formation}</span></div>
      <svg viewBox="0 0 100 140" className="pitch">
        <rect x="1" y="1" width="98" height="138" rx="4" className="pitch-bg" />
        <rect x="1" y="1" width="98" height="138" rx="4" className="pitch-line" fill="none" />
        <line x1="1" y1="70" x2="99" y2="70" className="pitch-line" />
        <circle cx="50" cy="70" r="9" className="pitch-circle" />
        <rect x="18" y="1" width="64" height="20" className="pitch-line" fill="none" />
        <rect x="18" y="119" width="64" height="20" className="pitch-line" fill="none" />

        {coordsFields.map((pt, i) => {
          const pid = chosenFields[i] || null;
          const name = pid ? (players.find(p => p.id === pid)?.name || "?") : "";
          const initialsTxt = pid ? tail3(name) : "용병";
          return (
            <g key={i} transform={`translate(${pt.x}, ${pt.y})`} textAnchor="middle">
              <UniformIcon fill={jerseyFill} size={20} stroke="var(--jersey-stroke)" />
              <text className="player-initials" dominantBaseline="middle" dy="0.3em">{initialsTxt}</text>
            </g>
          );
        })}

        {/* GK: exactly one GK shows at goal center (bottom) */}
        {singleGK && (
          <g transform={`translate(${50}, ${129})`} textAnchor="middle">
            <UniformIcon fill={jerseyFill} size={20} stroke="var(--jersey-stroke)" />
            <text className="player-initials" dominantBaseline="middle" dy="0.3em">
              {tail3(players.find(p => p.id === singleGK)?.name || "?")}
            </text>
          </g>
        )}
      </svg>

      {null}
    </div>
  );
}

/* ====== MatchRow (기존) ====== */
function MatchRow({
  m, readonly, updateMatch, deleteMatch, rosterA, rosterB, players, values, onChange, teamNames
}: {
  m: Match; readonly: boolean; updateMatch: (id: string, patch: Partial<Match>, opts?: { reevalGK?: boolean }) => void; deleteMatch: (id: string) => void;
  rosterA: string[]; rosterB: string[]; players: Player[]; values: MatchStats;
  onChange: (pid: string, field: "goals" | "assists", value: number) => void;
  teamNames: Record<TeamId, string>;
}) {
  const [open, setOpen] = useState(false);
  const collate = useMemo(() => new Intl.Collator("ko-KR", { sensitivity: "base", numeric: true, ignorePunctuation: true }).compare, []);
  const name = (pid: string) => players.find(p => p.id === pid)?.name || "?";
  const pos = (pid: string) => players.find(p => p.id === pid)?.pos || "필드";

  const sortRoster = (ids: string[]) => {
    const list = ids.map(id => players.find(p => p.id === id)).filter(Boolean) as Player[];
    const field = list.filter(p => p.pos !== "GK").sort((a, b) => collate(a.name, b.name));
    const gks = list.filter(p => p.pos === "GK").sort((a, b) => collate(a.name, b.name));
    return [...field, ...gks].map(p => p.id);
  };
  const rosterA_sorted = sortRoster(asArray(rosterA, []));
  const rosterB_sorted = sortRoster(asArray(rosterB, []));

  const render09 = () => Array.from({ length: 10 }).map((_, i) => <option key={i} value={i}>{i}</option>);

  return (
    <div className="card">
      <div className="match-head">
        <div className="seq">{m.seq}경기</div>

        <div className="scoreline">
          <TeamPicker
            value={m.home}
            teams={getActiveTeamsSafe(typeof cur !== "undefined" ? cur : undefined)}
            disabled={readonly}
            onChange={(v) => updateMatch(m.id, { home: v }, { reevalGK: true })}
          />

          <select
            className="score-input"
            value={m.hg}
            onChange={e => updateMatch(m.id, { hg: +e.target.value })}
            disabled={readonly}
          >
            {render09()}
          </select>

          <div className="colon">:</div>

          <select
            className="score-input"
            value={m.ag}
            onChange={e => updateMatch(m.id, { ag: +e.target.value })}
            disabled={readonly}
          >
            {render09()}
          </select>

          <TeamPicker
            value={m.away}
            teams={getActiveTeamsSafe(typeof cur !== "undefined" ? cur : undefined)}
            disabled={readonly}
            onChange={(v) => updateMatch(m.id, { away: v }, { reevalGK: true })}
          />
        </div>

        <div className="head-actions">
          <button onClick={() => setOpen(v => !v)}>{open ? "기록 닫기" : "기록"}</button>
          <button onClick={() => deleteMatch(m.id)} className="danger" disabled={readonly}>삭제</button>
        </div>
      </div>

      <div className="gk-row">
        <div><div className="subtle">홈 GK</div>
          <select value={m.gkHome || ""} onChange={e => updateMatch(m.id, { gkHome: e.target.value })} disabled={readonly}>
            <option value="">선택 안 함</option>
            {asArray(rosterA_sorted, []).filter(pid => getEffectivePos(pid) === "GK").map(pid => (
              <option key={pid} value={pid}>{name(pid)}</option>
            ))}
          </select>
        </div>
        <div><div className="subtle">원정 GK</div>
          <select value={m.gkAway || ""} onChange={e => updateMatch(m.id, { gkAway: e.target.value })} disabled={readonly}>
            <option value="">선택 안 함</option>
            {asArray(rosterB_sorted, []).filter(pid => getEffectivePos(pid) === "GK").map(pid => (
              <option key={pid} value={pid}>{name(pid)}</option>
            ))}
          </select>
        </div>
      </div>

      {open && (
        <div className="record-grid">
          <div className="team-col">
            <div className="team-col-head">{teamNames[m.home]} <span className="subtle">({m.home})</span></div>
            <div className="players-grid">
              {asArray(rosterA_sorted, []).map(pid => {
                const v = values[pid] || { goals: 0, assists: 0 };
                return (
                  <div key={pid} className="player-card">
                    <div className="player-name">{name(pid)} <span className="pos">({pos(pid)})</span></div>
                    <div className="stat">
                      <label className="stat-label">G</label>
                      <select
                        className="stat-input select"
                        value={v.goals}
                        onChange={e => onChange(pid, "goals", +e.target.value)}
                        disabled={readonly}
                      >
                        {render09()}
                      </select>
                    </div>
                    <div className="stat">
                      <label className="stat-label">A</label>
                      <select
                        className="stat-input select"
                        value={v.assists}
                        onChange={e => onChange(pid, "assists", +e.target.value)}
                        disabled={readonly}
                      >
                        {render09()}
                      </select>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="team-col">
            <div className="team-col-head">{teamNames[m.away]} <span className="subtle">({m.away})</span></div>
            <div className="players-grid">
              {asArray(rosterB_sorted, []).map(pid => {
                const v = values[pid] || { goals: 0, assists: 0 };
                return (
                  <div key={pid} className="player-card">
                    <div className="player-name">{name(pid)} <span className="pos">({pos(pid)})</span></div>
                    <div className="stat">
                      <label className="stat-label">G</label>
                      <select
                        className="stat-input select"
                        value={v.goals}
                        onChange={e => onChange(pid, "goals", +e.target.value)}
                        disabled={readonly}
                      >
                        {render09()}
                      </select>
                    </div>
                    <div className="stat">
                      <label className="stat-label">A</label>
                      <select
                        className="stat-input select"
                        value={v.assists}
                        onChange={e => onChange(pid, "assists", +e.target.value)}
                        disabled={readonly}
                      >
                        {render09()}
                      </select>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ====== 메인 App ====== */
export default function App() {
  // 데이터 내보내기(JSON)
  function exportData() {
    try {
      const dump = {
        players,
        teamNames: globalTeamNames,
        sessionsByDate,
        sessionDate,
      };
      const blob = new Blob([JSON.stringify(dump, null, 2)], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `goldin-export-${sessionDate}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert("내보내기 중 오류가 발생했습니다.");
      console.error(e);
    }
  }

  const today = ensureSunday(toISO(new Date()));
  const local0 = loadLocal() ?? {
    players: DEFAULT_PLAYERS.map(p => ({ id: uid(), name: p.name, active: true, pos: p.pos as any })),
    teamNames: { A: TEAM_LABELS.A, B: TEAM_LABELS.B, C: TEAM_LABELS.C, D: TEAM_LABELS.D },
    sessionsByDate: { [today]: emptySession() },
    sessionDate: today
  };

  const [players, setPlayers] = useState<Player[]>(local0.players);
  const [globalTeamNames, setGlobalTeamNames] = useState<Record<TeamId, string>>(local0.teamNames);
  const [sessionDate, setSessionDate] = useState<string>(local0.sessionDate);
  const [sessionsByDate, setSessionsByDate] = useState<Record<string, Session>>(local0.sessionsByDate);
  // Mode flags derived from URL
  const [adminMode] = useState<boolean>(() => detectAdminFromURL());
  const [viewerMode] = useState<boolean>(() => detectViewerFromURL());

  
  // ---- Hydrate from Supabase on mount ----
useEffect(() => { (async () => {
  try {
    const server = await loadPersistFromSupabase();
    if (server && !isBlankPersist(server)) {
      setPlayers(server.players);
      setGlobalTeamNames(server.teamNames);
      setSessionsByDate(server.sessionsByDate);
      setSessionDate(ensureSunday(server.sessionDate));
    }
  } catch {}
})(); }, []);
const [page, setPage] = useState<1 | 2 | 3 | 4 | 5>(2);
  // ===== 전체 순위/랭킹 보드 필터(시즌/기간) & 정렬 =====
  type StatsFilterMode = "all" | "season" | "range";

  const getCurrentSeasonId = (d: Date = new Date()): string => {
    const y = d.getFullYear();
    const m = d.getMonth() + 1; // 1-12
    return m <= 6 ? `${y}-1` : `${y}-2`;
  };

  // 새로 접속/새로고침 시에는 항상 "현재 시즌"이 기본값(= 상태를 별도 저장/복원하지 않음)
  const [statsFilterMode, setStatsFilterMode] = useState<StatsFilterMode>("season");
  const [statsSeason, setStatsSeason] = useState<string>(() => getCurrentSeasonId()); // e.g., "2025-2"
 // e.g., "2025-2"
  const [statsRangeStart, setStatsRangeStart] = useState<string>("");
  const [statsRangeEnd, setStatsRangeEnd] = useState<string>("");

  type OverallSortKey = "total" | "average" | "days" | "goals" | "assists" | "cleansheets" | "def" | "teamBonus";
  const [overallSortKey, setOverallSortKey] = useState<OverallSortKey>("total");
  const [overallSortDir, setOverallSortDir] = useState<"desc" | "asc">("desc");

  const seasonIdFromISO = (iso: string): string => {
    // iso: YYYY-MM-DD
    const y = Number(String(iso).slice(0, 4));
    const m = Number(String(iso).slice(5, 7));
    if (!Number.isFinite(y) || !Number.isFinite(m)) return "";
    return m <= 6 ? `${y}-1` : `${y}-2`;
  };


  const syncLockRef = useRef(false);
  const debTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hydratedRef = useRef(false);

  const collate = useMemo(() => new Intl.Collator("ko-KR", { sensitivity: "base", numeric: true, ignorePunctuation: true }).compare, []);
  const playersSorted = useMemo(() => {
    const field = [...players].filter(p => p.pos !== "GK").sort((a, b) => collate(a.name, b.name));
    const gks = [...players].filter(p => p.pos === "GK").sort((a, b) => collate(a.name, b.name));
    return [...field, ...gks];
  }, [players, collate]);
  const activePlayersSorted = useMemo(() => playersSorted.filter(p => p.active), [playersSorted]);

  const initialCloud = useMemo(() => ({ players, teamNames: globalTeamNames, sessionsByDate, sessionDate }), []);
  const { value: cloud, setValue: setCloud, ready } =
    useRealtimeJsonState<typeof initialCloud>(initialCloud, { id: 1 } as any);
useEffect(() => {
  if (!ready || !cloud) return;
  setPlayers(cloud.players);
  setGlobalTeamNames(cloud.teamNames);
  setSessionsByDate(cloud.sessionsByDate);
  setSessionDate(ensureSunday(cloud.sessionDate));
}, [ready, cloud]);

  useEffect(() => {
    if (!ready || !cloud) return;
    const next = cloud;
    if (JSON.stringify(pickState(next)) !== JSON.stringify(pickState({ players, teamNames: globalTeamNames, sessionsByDate, sessionDate }))) {
      syncLockRef.current = true;
      setPlayers(next.players);
      setGlobalTeamNames(next.teamNames);
      setSessionsByDate(next.sessionsByDate);
      setSessionDate(ensureSunday(next.sessionDate));
      setTimeout(() => { syncLockRef.current = false; hydratedRef.current = true; }, 50);
    } else {
      hydratedRef.current = true;
    }
  }, [cloud, ready]); // eslint-disable-line

  useEffect(() => {
    const s = { players, teamNames: globalTeamNames, sessionsByDate, sessionDate: ensureSunday(sessionDate) };
    saveLocal(s);
    if (!ready || !hydratedRef.current || syncLockRef.current) return;
    if (debTimerRef.current) clearTimeout(debTimerRef.current);
    debTimerRef.current = setTimeout(() => {
      if (JSON.stringify(pickState(cloud)) !== JSON.stringify(pickState(s))) setCloud(s);
    }, 150);
  }, [players, globalTeamNames, sessionsByDate, sessionDate, ready]); // eslint-disable-line

  useEffect(() => {
    const key = ensureSunday(sessionDate);
    setSessionsByDate(prev => {
      const base = prev[key] ?? emptySession();
      if (base.teamNames && base.teamNames.A && base.teamNames.B && base.teamNames.C) return prev;
      let donor: Record<TeamId, string> | null = null;
      const keys = Object.keys(prev).sort();
      const tgt = new Date(key).getTime();
      for (let i = keys.length - 1; i >= 0; i--) {
        const k = keys[i]; const t = new Date(k).getTime(); if (t === tgt) continue;
        const tn = prev[k]?.teamNames;
        if (tn && tn.A && tn.B && tn.C) { donor = tn as any; break; }
      }
      const useTN = donor || globalTeamNames;
      return { ...prev, [key]: { ...base, teamNames: { A: useTN.A, B: useTN.B, C: useTN.C } } };
    });
  }, [sessionDate]); // eslint-disable-line

  useEffect(() => {
    const key = ensureSunday(sessionDate);
    setSessionsByDate(prev => {
      const base = prev[key] ?? emptySession();
      const matches = asArray(base.matches, []);
      let changed = false;

      const pickOneGK = (tid: TeamId): string | null => {
        const ids = asArray(base.rosters[tid], []);
                  const gkIds = ids.filter(pid => getEffectivePos(pid) === "GK");
        return gkIds.length === 1 ? gkIds[0] : null;
      };

      const nextMatches = matches.map(m => {
        let gkH = m.gkHome ?? null;
        let gkA = m.gkAway ?? null;
        const oneHome = pickOneGK(m.home);
        const oneAway = pickOneGK(m.away);

        if (gkH == null && oneHome) { gkH = oneHome; changed = true; }
        if (gkA == null && oneAway) { gkA = oneAway; changed = true; }

        if (gkH === m.gkHome && gkA === m.gkAway) return m;
        return { ...m, gkHome: gkH, gkAway: gkA };
      });

      if (!changed) return prev;
      return { ...prev, [key]: { ...base, matches: nextMatches } };
    });
  }, [players, sessionsByDate, sessionDate]);

  const viewerFlag = getQueryFlag("viewer", "view", "readonly");
  const [authed, setAuthed] = useState<boolean>(() => sessionStorage.getItem(SS_PIN_AUTHED) === "1");
  const readonly = !authed;
  const [pinInput, setPinInput] = useState("");

  async function sha256Hex(input: string): Promise<string> {
    const enc = new TextEncoder();
    const w: any = globalThis as any;
    if (!w.crypto?.subtle) return `plain:${input}`;
    const buf = await w.crypto.subtle.digest("SHA-256", enc.encode(input));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
  }

  async function unlock() {
    if (!pinInput) return alert("PIN을 입력하세요");
    const h = await sha256Hex(pinInput);
    if (h === FIXED_PIN_HASH) { sessionStorage.setItem(SS_PIN_AUTHED, "1"); setAuthed(true); setPinInput(""); }
    else alert("PIN 불일치");
  }
  function lock() { sessionStorage.removeItem(SS_PIN_AUTHED); setAuthed(false); }
  function copyViewerLink() { const url = new URL(window.location.href); url.searchParams.set("viewer", "1"); navigator.clipboard?.writeText(url.toString()); alert("보기 전용 링크가 복사되었습니다"); }

  const cur: Session = useMemo(() => sessionsByDate[ensureSunday(sessionDate)] ?? emptySession(), [sessionsByDate, sessionDate]);
  const effectiveTeamNames: Record<TeamId, string> = TEAM_LABELS;

  // ✅ 날짜별 포지션(오늘만) 오버라이드: players.pos(전체) + cur.posOverrides(해당 날짜만)
  const getBasePos = (pid: string): Player['pos'] => (players.find(p => p.id === pid)?.pos || "필드");
  const getEffectivePos = (pid: string): Player['pos'] => (cur.posOverrides?.[pid] || getBasePos(pid));

  const patchSession = (patch: Partial<Session>) => {
    if (readonly) return;
    setSessionsByDate(prev => {
      const key = ensureSunday(sessionDate);
      const base = prev[key] ?? emptySession();
      const next: Session = { ...base, ...patch };
      if (JSON.stringify(base) === JSON.stringify(next)) return prev;
      return { ...prev, [key]: next };
    });
  };

  const setPosOverride = (pid: string, pos: Player['pos'] | null) => {
    if (readonly) return;
    const next = { ...(cur.posOverrides || {}) };
    if (!pos) delete next[pid];
    else next[pid] = pos;
    patchSession({ posOverrides: next });
  };

  const addPlayer = (name: string) => {
    if (readonly) return;
    const nm = name.trim(); if (!nm) return;
    if (players.some(p => p.name === nm)) return alert("이미 있는 이름입니다");
    setPlayers(prev => [...prev, { id: uid(), name: nm, active: true, pos: "필드" }].sort((a, b) => collate(a.name, b.name)));
  };
  const updateTeamName = (tid: TeamId, nm: string) => patchSession({ teamNames: { ...(cur.teamNames || effectiveTeamNames), [tid]: nm } as any });
  const toggleRoster = (tid: TeamId, pid: string) => patchSession({
    rosters: (() => {
      const r = { ...(cur.rosters || { A: [], B: [], C: [] }) };
      const list = asArray(r[tid], []);
      r[tid] = list.includes(pid) ? list.filter(id => id !== pid) : [...list, pid];
      return r;
    })()
  });
  const setFormation = (tid: TeamId, f: FormationKey) =>
    patchSession({ formations: { ...(cur.formations || { A: "1-2-1", B: "1-2-1", C: "1-2-1" }), [tid]: f } });

  const toggleConfirmTeamView = (tid: TeamId) => {
    if (readonly) return;
    const curr = cur.rosterViewConfirmed?.[tid] ?? false;
    patchSession({ rosterViewConfirmed: { ...(cur.rosterViewConfirmed || { A: false, B: false, C: false }), [tid]: !curr } });
  };

  const updateMatch = (id: string, patch: Partial<Match>, opts?: { reevalGK?: boolean }) => {
    if (readonly) return;
    patchSession({
      matches: asArray(cur.matches, []).map(m => {
        if (m.id !== id) return m;

        const teamChangedHome = Object.prototype.hasOwnProperty.call(patch, "home");
        const teamChangedAway = Object.prototype.hasOwnProperty.call(patch, "away");

        const nextHome = (teamChangedHome ? (patch.home as TeamId) : m.home);
        const nextAway = (teamChangedAway ? (patch.away as TeamId) : m.away);

        let nextGKHome = (Object.prototype.hasOwnProperty.call(patch, "gkHome") ? (patch.gkHome ?? null) : m.gkHome ?? null);
        let nextGKAway = (Object.prototype.hasOwnProperty.call(patch, "gkAway") ? (patch.gkAway ?? null) : m.gkAway ?? null);

        const pickOneGK = (tid: TeamId): string | null => {
          const ids = asArray(cur.rosters[tid], []);
                    const gkIds = ids.filter(pid => getEffectivePos(pid) === "GK");
          return gkIds.length === 1 ? gkIds[0] : null;
        };

        if (opts?.reevalGK && teamChangedHome && nextGKHome !== "") {
          const auto = pickOneGK(nextHome);
          const rosterHome = asArray(cur.rosters[nextHome], []);
                    const isCurrentValid = nextGKHome ? rosterHome.includes(nextGKHome) && (getEffectivePos(nextGKHome) === "GK") : false;
          if (auto) nextGKHome = auto;
          else if (!isCurrentValid) nextGKHome = null;
        }

        if (opts?.reevalGK && teamChangedAway && nextGKAway !== "") {
          const auto = pickOneGK(nextAway);
          const rosterAway = asArray(cur.rosters[nextAway], []);
                    const isCurrentValid = nextGKAway ? rosterAway.includes(nextGKAway) && (getEffectivePos(nextGKAway) === "GK") : false;
          if (auto) nextGKAway = auto;
          else if (!isCurrentValid) nextGKAway = null;
        }

        return { ...m, ...patch, home: nextHome, away: nextAway, gkHome: nextGKHome, gkAway: nextGKAway };
      })
    });
  };

  const addMatch = () => {
    let maxSeq = 0; asArray(cur.matches, []).forEach(m => { if (m.seq && m.seq > maxSeq) maxSeq = m.seq; });
    const nextSeq = maxSeq + 1;

    let home: TeamId = "A";
    let away: TeamId = "B";

    if (nextSeq >= 4 && nextSeq <= 9) {
      const baseSeq: number = ((nextSeq - 1) % 3) + 1;
      const baseMatch = asArray(cur.matches, []).find(m => m.seq === baseSeq);
      if (baseMatch) {
        home = baseMatch.home;
        away = baseMatch.away;
      }
    }

    patchSession({ matches: [...asArray(cur.matches, []), { id: uid(), seq: nextSeq, home, away, hg: 0, ag: 0, gkHome: null, gkAway: null }] });
  };

  const deleteMatch = (id: string) => patchSession({ matches: asArray(cur.matches, []).filter(m => m.id !== id) });
  const setDef = (tid: TeamId, pid: string | null) => patchSession({ defAwards: { ...(cur.defAwards || { A: null, B: null, C: null }), [tid]: pid } });
  const setMatchStat = (mid: string, pid: string, field: "goals" | "assists", value: number) => {
    if (readonly) return;
    const row = { ...(cur.matchStats?.[mid] || {}) } as MatchStats;
    const curv = row[pid] || { goals: 0, assists: 0 };
    row[pid] = { ...curv, [field]: value } as any;
    patchSession({ matchStats: { ...cur.matchStats, [mid]: row } });
  };

  function calcScores(session: Session) {
    const out: Record<string, any> = {};
    const teamNamesUse = TEAM_LABELS;

    const teamOf = (pid: string): TeamId | "-" =>
      (session.rosters.A || []).includes(pid) ? "A" :
      (session.rosters.B || []).includes(pid) ? "B" :
      (session.rosters.C || []).includes(pid) ? "C" : "-";

    const standings = computeStandings(session.matches);
    const teamBonusByTeam = computeTeamBonus(standings.filter(r => getActiveTeamsSafe(typeof cur !== "undefined" ? cur : undefined).includes(r.team)), (session as any)?.hasTeamD || false);
    const hasMatches = Array.isArray(session.matches) && session.matches.length > 0;

    const gkWins: Record<string, number> = {};
    asArray(session.matches, []).forEach(m => {
      const hg = asNumber(m.hg, 0), ag = asNumber(m.ag, 0);
      if (hg > ag && m.gkHome) gkWins[m.gkHome] = (gkWins[m.gkHome] || 0) + 1;
      if (ag > hg && m.gkAway) gkWins[m.gkAway] = (gkWins[m.gkAway] || 0) + 1;
    });

    const teamGKs: Record<TeamId, string[]> = { A: [], B: [], C: [] };
    TEAM_IDS.forEach(tid => {
            teamGKs[tid] = asArray(session.rosters[tid], []).filter(pid => ((session.posOverrides?.[pid] || (players.find(p => p.id === pid)?.pos) || "필드") === "GK"));
    });

    asArray(session.matches, []).forEach(m => {
      const ms = session.matchStats?.[m.id] || {};
      Object.entries(ms).forEach(([pid, s]) => {
        const base = out[pid] || { goals: 0, assists: 0, cleansheets: 0 };
        out[pid] = { goals: base.goals + asNumber((s as any).goals, 0), assists: base.assists + asNumber((s as any).assists, 0), cleansheets: base.cleansheets };
      });
      if (asNumber(m.ag, 0) === 0 && m.gkHome) {
        const b = out[m.gkHome] || { goals: 0, assists: 0, cleansheets: 0 };
        out[m.gkHome] = { ...b, cleansheets: (b.cleansheets || 0) + 1 };
      }
      if (asNumber(m.hg, 0) === 0 && m.gkAway) {
        const b = out[m.gkAway] || { goals: 0, assists: 0, cleansheets: 0 };
        out[m.gkAway] = { ...b, cleansheets: (b.cleansheets || 0) + 1 };
      }
    });

    TEAM_IDS.forEach(tid => asArray(session.rosters[tid], []).forEach(pid => { if (!out[pid]) out[pid] = { goals: 0, assists: 0, cleansheets: 0 }; }));

    const collator = new Intl.Collator("ko-KR", { sensitivity: "base", numeric: true });
    Object.keys(out).forEach(pid => {
      const team = teamOf(pid);
      const isGK = players.find(p => p.id === pid)?.pos === "GK";
      const def = team !== "-" && (session.defAwards?.[team] || null) === pid ? 2 : 0;

      let teamBonus = 0;
      if (team !== "-" && hasMatches) {
        if (isGK) {
          const gks = teamGKs[team];
          if (gks.length <= 1) {
            teamBonus = teamBonusByTeam[team] || 0;
          } else {
            // ✅ GK 2명일 때: 승리 횟수 -> 클린시트 -> 이름 순(동률이면 둘 다 4점)
            const gkWinsCount = (Object as any).fromEntries(gks.map((id: string) => [id, gkWins[id] || 0]));
            const gkCSCount = (Object as any).fromEntries(gks.map((id: string) => [id, asNumber(out[id]?.cleansheets, 0)]));
            const sortedByWins = [...gks].sort((a, b) =>
              (gkWinsCount[b] - gkWinsCount[a]) ||
              (gkCSCount[b] - gkCSCount[a]) ||
              collator.compare(players.find(p => p.id === a)?.name || "", players.find(p => p.id === b)?.name || "")
            );

            const top = sortedByWins[0];
            const second = sortedByWins[1];
            const topWins = gkWinsCount[top] || 0;
            const secWins = gkWinsCount[second] || 0;
            const topCS = gkCSCount[top] || 0;
            const secCS = gkCSCount[second] || 0;

            const tieWins = topWins === secWins;
            const tieCS = topCS === secCS;
            if (tieWins && tieCS) {
              teamBonus = (pid === top || pid === second) ? 4 : 0;
            } else {
              teamBonus = top === pid ? 4 : second === pid ? 2 : 0;
            }
          }
        } else {
          teamBonus = teamBonusByTeam[team] || 0;
        }
      }

      const total = out[pid].goals + out[pid].assists + out[pid].cleansheets + def + teamBonus;
      out[pid] = {
        ...out[pid],
        def, teamBonus, total,
        name: players.find(p => p.id === pid)?.name || "?",
        team,
        teamName: team === "-" ? "-" : teamNamesUse[team]
      };
    });
    return out;
  }

  const dailyScores = useMemo(() => calcScores(cur), [cur, players, globalTeamNames]);
  const sortedDaily = useMemo(
    () => Object.entries(dailyScores).map(([pid, v]: any) => ({ id: pid, ...v })).sort((a, b) => b.total - a.total || collate(a.name, b.name)),
    [dailyScores, collate]
  );

  // ✅ 팀에 GK가 2명 이상인 경우: '오늘의 개인 순위'에서 GK는 팀명을 숨김
  const hideTeamNameForGKIds = useMemo(() => {
    const hidden = new Set<string>();
    try {
      const activeTeams = getActiveTeamsSafe(typeof cur !== "undefined" ? cur : undefined);
      activeTeams.forEach((tid: TeamId) => {
        const roster = asArray(cur.rosters?.[tid], []);
                const gkIds = roster.filter(pid => getBasePos(pid) === "GK");
        if (gkIds.length >= 2) gkIds.forEach(id => hidden.add(id));
      });
    } catch {}
    return hidden;
  }, [cur, players]);

  // ===== 시즌/기간 선택(전체 순위/랭킹 보드용) =====
  const allSessionKeysSorted = useMemo(() => Object.keys(sessionsByDate).sort((a, b) => a.localeCompare(b)), [sessionsByDate]);

  const availableSeasons = useMemo(() => {
    const set = new Set<string>();
    allSessionKeysSorted.forEach(k => {
      const sid = seasonIdFromISO(k);
      if (sid) set.add(sid);
    });
    // 최신 시즌이 위로 오도록 정렬: 연도 내 2가 1보다 최신
    const list = Array.from(set);
    list.sort((a, b) => {
      const [ay, ah] = a.split("-").map(Number);
      const [by, bh] = b.split("-").map(Number);
      return (by - ay) || (bh - ah);
    });
    return list;
  }, [allSessionKeysSorted]);

  useEffect(() => {
    // 시즌 기본값: 가장 최신 시즌
    if (!statsSeason && availableSeasons.length > 0) setStatsSeason(availableSeasons[0]);
  }, [availableSeasons]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // 기간 기본값: 전체 기간
    if (allSessionKeysSorted.length === 0) return;
    const minK = allSessionKeysSorted[0];
    const maxK = allSessionKeysSorted[allSessionKeysSorted.length - 1];
    if (!statsRangeStart) setStatsRangeStart(minK);
    if (!statsRangeEnd) setStatsRangeEnd(maxK);
  }, [allSessionKeysSorted]); // eslint-disable-line react-hooks/exhaustive-deps

  const filteredSessionEntries = useMemo(() => {
    const entries = Object.entries(sessionsByDate) as [string, Session][];
    if (statsFilterMode === "season") {
      const sid = statsSeason || (availableSeasons[0] || "");
      if (!sid) return entries;
      return entries.filter(([k]) => seasonIdFromISO(k) === sid);
    }
    if (statsFilterMode === "range") {
      const start = statsRangeStart || (allSessionKeysSorted[0] || "0000-01-01");
      const end = statsRangeEnd || (allSessionKeysSorted[allSessionKeysSorted.length - 1] || "9999-12-31");
      const s = start <= end ? start : end;
      const e = start <= end ? end : start;
      return entries.filter(([k]) => k >= s && k <= e);
    }
    return entries;
  }, [sessionsByDate, statsFilterMode, statsSeason, statsRangeStart, statsRangeEnd, availableSeasons, allSessionKeysSorted]);

  const filterLabel = useMemo(() => {
    if (statsFilterMode === "season") return statsSeason || (availableSeasons[0] || "");
    if (statsFilterMode === "range") {
      const start = statsRangeStart || (allSessionKeysSorted[0] || "");
      const end = statsRangeEnd || (allSessionKeysSorted[allSessionKeysSorted.length - 1] || "");
      return start && end ? `${start} ~ ${end}` : "";
    }
    return "전체";
  }, [statsFilterMode, statsSeason, statsRangeStart, statsRangeEnd, availableSeasons, allSessionKeysSorted]);


  const cumulativeScores = useMemo(() => {
    const agg: Record<string, any> = {};
    Object.entries(sessionsByDate).forEach(([dateKey, s]) => {
      const sc = calcScores(s);
      const present = new Set<string>();
      TEAM_IDS.forEach(t => asArray(s.rosters[t], []).forEach(pid => present.add(pid)));
      Object.entries(sc).forEach(([pid, v]: any) => {
        const b = agg[pid] || { goals: 0, assists: 0, cleansheets: 0, def: 0, teamBonus: 0, total: 0, days: 0, name: v.name, teamName: v.teamName, _dates: [] as string[] };
        agg[pid] = {
          ...b,
          goals: b.goals + v.goals, assists: b.assists + v.assists, cleansheets: b.cleansheets + v.cleansheets,
          def: b.def + v.def, teamBonus: b.teamBonus + v.teamBonus, total: b.total + v.total,
          days: b.days + (present.has(pid) ? 1 : 0),
          _dates: [...b._dates, dateKey]
        };
      });
      present.forEach(pid => { if (!agg[pid]) agg[pid] = { goals: 0, assists: 0, def: 0, teamBonus: 0, total: 0, days: 1, name: "?", teamName: "", _dates: [dateKey] }; });
    });
    return agg;
  }, [sessionsByDate, players, globalTeamNames]);

  const sortedCumulative = useMemo(
    () => Object.entries(cumulativeScores).map(([pid, v]: any) => ({
        id: pid, ...v, average: v.days > 0 ? Math.round((v.total / v.days) * 100) / 100 : 0
      }))
      .sort((a, b) => b.total - a.total || collate(a.name, b.name)),
    [cumulativeScores, collate]
  );

  // ===== 필터 적용 누적 집계(전체 순위/랭킹 보드 전용) =====
  const cumulativeScoresFiltered = useMemo(() => {
    const agg: Record<string, any> = {};
    filteredSessionEntries.forEach(([dateKey, s]) => {
      const sc = calcScores(s);
      const present = new Set<string>();
      TEAM_IDS.forEach(t => asArray(s.rosters[t], []).forEach(pid => present.add(pid)));
      Object.entries(sc).forEach(([pid, v]: any) => {
        const b = agg[pid] || { goals: 0, assists: 0, cleansheets: 0, def: 0, teamBonus: 0, total: 0, days: 0, name: v.name, teamName: v.teamName, _dates: [] as string[] };
        agg[pid] = {
          ...b,
          goals: b.goals + v.goals, assists: b.assists + v.assists, cleansheets: b.cleansheets + v.cleansheets,
          def: b.def + v.def, teamBonus: b.teamBonus + v.teamBonus, total: b.total + v.total,
          days: b.days + (present.has(pid) ? 1 : 0),
          _dates: [...b._dates, dateKey]
        };
      });
      present.forEach(pid => { if (!agg[pid]) agg[pid] = { goals: 0, assists: 0, def: 0, teamBonus: 0, total: 0, days: 1, name: "?", teamName: "", _dates: [dateKey] }; });
    });
    return agg;
  }, [filteredSessionEntries, players, globalTeamNames]);

  const sortedCumulativeFiltered = useMemo(
    () => Object.entries(cumulativeScoresFiltered).map(([pid, v]: any) => ({
        id: pid, ...v, average: v.days > 0 ? Math.round((v.total / v.days) * 100) / 100 : 0
      }))
      .sort((a, b) => b.total - a.total || collate(a.name, b.name)),
    [cumulativeScoresFiltered, collate]
  );

  const sortedCumulativeFilteredSorted = useMemo(() => {
    const key = overallSortKey;
    const dir = overallSortDir;
    const list = [...sortedCumulativeFiltered];
    list.sort((a: any, b: any) => {
      const av = asNumber(a[key], 0);
      const bv = asNumber(b[key], 0);
      if (av === bv) return collate(a.name, b.name);
      return dir === "desc" ? (bv - av) : (av - bv);
    });
    return list;
  }, [sortedCumulativeFiltered, overallSortKey, overallSortDir, collate]);


  const matchesSorted = useMemo(() => [...asArray(cur.matches, [])].sort((a, b) => (b.seq || 0) - (a.seq || 0)), [cur.matches]);

  function top5RankingFrom(baseList: any[], type: "goals" | "assists" | "def" | "cleansheets" | "teamBonus" | "total") {
    let sorted = [...baseList];

    if (type === "cleansheets") {
      sorted = sorted.filter(p => players.find(pl => pl.id === p.id)?.pos === "GK");
    }

    // ✅ 0점(또는 0기록) 선수는 랭킹 보드에서 제외
    sorted = sorted.filter(p => asNumber(p[type], 0) > 0);
    sorted.sort((a, b) => (b[type] || 0) - (a[type] || 0));
    if (sorted.length === 0) return [];

    const ranked: any[] = [];
    let currentRank = 1;
    let prevScore: number | null = null;
    let count = 0;

    for (let i = 0; i < sorted.length; i++) {
      const score = sorted[i][type] || 0;
      count++;
      if (prevScore === null) currentRank = 1;
      else if (score < prevScore) currentRank = count;
      ranked.push({ ...sorted[i], rank: currentRank });
      prevScore = score;
    }
    return ranked.filter(r => r.rank <= 5);
  }

  function top5Ranking(type: "goals" | "assists" | "def" | "cleansheets" | "teamBonus" | "total") {
    // 랭킹 보드에서는 필터(시즌/기간) 적용된 누적 집계 기준으로 Top5 산출
    return top5RankingFrom(sortedCumulativeFiltered, type);
  }


  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(null);
  const selectedPlayerData = selectedPlayerId
    ? sortedCumulative.find(p => p.id === selectedPlayerId)
    : null;

  const radarData = selectedPlayerData
    ? [
        { stat: "Goals", value: selectedPlayerData.goals },
        { stat: "Assists", value: selectedPlayerData.assists },
        { stat: "Defense", value: selectedPlayerData.def },
        { stat: "CS", value: selectedPlayerData.cleansheets },
        { stat: "Team", value: selectedPlayerData.teamBonus },
      ]
    : [];

  const sparklineData = useMemo(() => {
    if (!selectedPlayerId) return [];
    const entries = Object.entries(sessionsByDate).sort(([a], [b]) => a.localeCompare(b));
    return entries.map(([dateKey, s]) => {
      const sc = calcScores(s);
      const row = sc[selectedPlayerId] || { total: 0 };
      return { date: dateKey.slice(5), total: row.total };
    });
  }, [sessionsByDate, selectedPlayerId]);

  const globalMaxValue = useMemo(() => {
    if (sortedCumulative.length === 0) return 10;
    return Math.max(
      ...sortedCumulative.flatMap(p => [
        p.goals, p.assists, p.def, p.teamBonus, p.cleansheets
      ])
    );
  }, [sortedCumulative]);

  return (
    <div className="wrap">
      <h1 className="title">골딘 풋살 리그 · 기록/집계</h1>

      <div className="panel">
        {viewerFlag && <span className="badge-view">보기 전용 링크</span>}
        {authed ? <>
          <span className="ok">관리자 모드</span>
          <button onClick={lock}>잠금</button>
          <button onClick={copyViewerLink}>보기 전용 링크 복사</button>
          <button onClick={exportData}>데이터 내보내기</button>
        </> : <>
          <span className="label-strong">관리자 PIN:</span>
          <input type="password" value={pinInput} onChange={e => setPinInput(e.target.value)} placeholder="PIN 입력" />
          <button onClick={unlock}>잠금 해제</button>
          <button onClick={copyViewerLink}>보기 전용 링크 복사</button>
        </>}
      </div>

      <div className="tabs">
        <button className={page === 1 ? "tab active" : "tab"} onClick={() => setPage(1)}>선수 관리</button>
        <button className={page === 2 ? "tab active" : "tab"} onClick={() => setPage(2)}>일자별 경기 기록</button>
        <button className={page === 3 ? "tab active" : "tab"} onClick={() => setPage(3)}>전체 순위</button>
        <button className={page === 4 ? "tab active" : "tab"} onClick={() => setPage(4)}>선수 분석</button>
        <button className={page === 5 ? "tab active" : "tab"} onClick={() => setPage(5)}>랭킹 보드</button>
      </div>

      {page === 2 && (
        <div className="row">
          <label className="label-strong">날짜:</label>
          <input type="date" value={ensureSunday(sessionDate)} onChange={e => setSessionDate(ensureSunday(e.target.value))} />
          <span className="hint">일요일로 자동 보정</span>
        </div>
      )}

      {page === 1 && (
        <section className="box">
          <h3>선수 관리</h3>
                    <AddPlayer onAdd={(nm) => addPlayer(nm)} disabled={readonly} />
          <div className="hint">선수 명단은 모든 날짜에 공통 적용됩니다.</div>
          <div className="list-scroll players-admin-grid">
            {playersSorted.map(p => (
            
              <div key={p.id} className="player-admin-item">
                <input
                  className="player-name-input"
                  value={p.name}
                  onChange={e => readonly ? null : setPlayers(prev => prev.map(x => x.id === p.id ? { ...x, name: e.target.value } : x))}
                  disabled={readonly}
                />
                <select
                  value={p.pos}
                  onChange={e => readonly ? null : setPlayers(prev => prev.map(x => x.id === p.id ? { ...x, pos: (e.target.value as Player['pos']) } : x))}
                  disabled={readonly}
                >
                  <option value="필드">필드</option><option value="GK">GK</option>
                </select>
                <button
                  onClick={() => readonly ? null : setPlayers(prev => prev.map(x => x.id === p.id ? { ...x, active: !x.active } : x))}
                  disabled={readonly}
                >
                  {p.active ? "활성" : "비활성"}
                </button>
              </div>
            ))}
          </div>
          <div className="box" style={{ marginTop: 16 }}>
            <h4>선수 스탯 입력</h4>
            <FifaSection
              players={playersSorted.map(p => ({ id: p.id, name: p.name }))}
            />
          </div>
        </section>
      )}

      {page === 2 && (
        <>
          <section className="box">
            <h3>팀 구성</h3>
            {!(typeof cur !== "undefined" ? (cur as any)?.hasTeamD : false) && (
              <button className="btn add-team" onClick={() => {
                setState(prev => {
                  const s = { ...prev } as any;
                  const key = sessionDate;
                  const base = s.sessionsByDate[key] || emptySession();
                  // mark team D enabled
                  base.hasTeamD = true;
                  // ensure structures for D
                  base.rosters = { ...base.rosters, D: base.rosters?.D || [] };
                  base.defAwards = { ...base.defAwards, D: base.defAwards?.D || null };
                  base.rosterViewConfirmed = { ...base.rosterViewConfirmed, D: false };
                  base.formations = { ...base.formations, D: "1-2-1" };
                  s.sessionsByDate[key] = base;
                  return s;
                });
              }}>+ 팀 추가</button>
            )}
            <div className="teams-grid">
              {getActiveTeamsSafe(typeof cur !== "undefined" ? cur : undefined).map(tid => {
                const isConfirmed = Boolean(cur.rosterViewConfirmed?.[tid]);
                const sourceList = isConfirmed
                  ? activePlayersSorted.filter(p => asArray(cur.rosters[tid], []).includes(p.id))
                  : activePlayersSorted;
                const requested = (cur.formations?.[tid] as FormationKey) || null;
                const currentRoster = asArray(cur.rosters?.[tid], []);
                const fieldCount = currentRoster.filter(pid => (players.find(p => p.id === pid)?.pos) !== "GK").length;
                const byCount = (fieldCount >= 5 ? "2-2-1" : (fieldCount === 4 ? "1-2-1" : (fieldCount === 3 ? "1-2" : "1-2-1"))) as FormationKey;
                const formation = (fieldCount >= 5 ? "2-2-1" as FormationKey : (requested ?? byCount) as FormationKey);

                return (
                  <div key={tid} className="team-card">
                    <div className="row">
                      <div style={{ fontWeight: 700 }}>{effectiveTeamNames[tid]}</div>
                      <span className="team-id">{tid}</span>
                    </div>

                    <div className="row">
                      <label>포메이션:</label>
                      <select
                        value={formation}
                        onChange={e => setFormation(tid, e.target.value as FormationKey)}
                        disabled={readonly}
                      >
                        <option value="1-2-1">1-2-1</option>
                        <option value="2-2">2-2</option>
                        <option value="3-1">3-1</option>
                        <option value="2-2-1">2-2-1</option>
                      </select>
                      <span className="hint">조끼색: {TEAM_PINNIES[tid] === "red" ? "빨강" : TEAM_PINNIES[tid] === "yellow" ? "노랑" : "초록"}</span>
                    </div>

                    <div className="list-scroll small">
                      {sourceList.map(p => (
                        <label key={p.id} className="checkline">
                          <input
                            type="checkbox"
                            checked={asArray(cur.rosters[tid], []).includes(p.id)}
                            onChange={() => toggleRoster(tid, p.id)}
                            disabled={readonly}
                          />
                          {p.name} {p.pos === "GK" && <span className="badge-gk">{getEffectivePos(p.id) === "GK" ? "GK" : "오늘 필드"}</span>}
                        </label>
                      ))}
                      {isConfirmed && sourceList.length === 0 && (
                        <div className="muted">선택된 선수가 없습니다. ‘수정’을 눌러 전체 명단에서 선택하세요.</div>
                      )}
                    </div>

                    {/* ✅ GK가 팀에 포함된 경우: 오늘(해당 날짜) 포지션 선택 */}
                    {(() => {
                      const rosterIds = asArray(cur.rosters[tid], []);
                      const gkIds = rosterIds.filter(pid => getBasePos(pid) === "GK");
                      if (gkIds.length < 1) return null;
                      return (
                        <div className="row" style={{ marginTop: 8, gap: 8, flexWrap: "wrap" }}>
                          <span className="hint">오늘 포지션을 선택할 수 있습니다 (선택은 해당 일자에만 적용).</span>
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                            {gkIds.map(pid => (
                              <div key={pid} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", border: "1px solid var(--line)", borderRadius: 8 }}>
                                <span style={{ fontWeight: 600 }}>{name(pid)}</span>
                                <select
                                  value={getEffectivePos(pid)}
                                  onChange={e => { const v = (e.target.value as Player['pos']); setPosOverride(pid, v === getBasePos(pid) ? null : v); }}
                                  disabled={readonly}
                                >
                                  <option value="GK">GK</option>
                                  <option value="필드">필드(오늘만)</option>
                                </select>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })()}

                    {/* ✅ 포메이션 미리보기 */}
                    <FormationPreview
                      team={tid}
                      roster={asArray(cur.rosters[tid], [])}
                      players={players}
                      teamName={effectiveTeamNames[tid]}
                      formation={formation}
                      color={TEAM_PINNIES[tid]}
                      posOverrides={cur.posOverrides}
                    />

                    <div className="row">
                      <button onClick={() => toggleConfirmTeamView(tid)} disabled={readonly}>
                        {isConfirmed ? "수정" : "확정"}
                      </button>
                      {isConfirmed && <span className="hint">확정된 팀원만 표시</span>}
                    </div>
                    <div className="row" style={{ marginTop: 8 }}>
                      <label style={{ marginRight: 8 }}>🛡 수비 기여도 선정</label>
                      <select
                        value={(cur.defAwards?.[tid] ?? "") as any}
                        onChange={e => setDef(tid, e.target.value || null)}
                        disabled={readonly}
                      >
                        <option value="">(선택 없음)</option>
                        {asArray(cur.rosters[tid], []).map(pid => {
                          const name = players.find(p => p.id === pid)?.name || "?";
                          return <option key={pid} value={pid}>{name}</option>;
                        })}
                      </select>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* 경기/표/개인순위 섹션들은 기존 그대로 */}
          <section className="box">
            <h3>경기 결과</h3>
            <div className="row spread">
              <div className="hint">각 경기의 <b>기록</b>에서 선수별 G/A 입력 (CS는 자동)</div>
              <button onClick={addMatch} disabled={readonly}>경기 추가</button>
            </div>
            {matchesSorted.length === 0 && <p className="muted">경기를 추가하세요.</p>}
            <div className="match-list">
              {matchesSorted.map(m => (
                <MatchRow key={m.id} m={m} readonly={readonly} updateMatch={updateMatch} deleteMatch={deleteMatch}
                  rosterA={asArray(cur.rosters[m.home], [])} rosterB={asArray(cur.rosters[m.away], [])} players={players}
                  values={cur.matchStats?.[m.id] || {}} onChange={(pid, field, val) => setMatchStat(m.id, pid, field, val)} teamNames={effectiveTeamNames} />
              ))}
            </div>

            <div className="table-wrap">
              <h4>순위표 (팀 보너스: {(typeof cur !== "undefined" ? (cur as any)?.hasTeamD : false) ? "1위 4 / 2위 3 / 3위 2 / 4위 1" : "1위 4 / 2위 2 / 3위 1"})</h4>
              <table className="tbl"><thead><tr>
                <th>순위</th><th>팀명</th><th>승점</th><th>승</th><th>무</th><th>패</th><th>득점</th><th>실점</th><th>득실</th><th>팀</th>
              </tr></thead><tbody>
                {computeStandings(cur.matches).filter(r => getActiveTeamsSafe(typeof cur !== "undefined" ? cur : undefined).includes(r.team)).map((t, idx) => (
                  <tr key={t.team}><td>{idx + 1}</td><td><span>{TEAM_LABELS[t.team as TeamId]}</span>{" "}<TeamSwatch team={t.team as TeamId} /></td><td>{t.pts}</td><td>{t.w}</td><td>{t.d}</td><td>{t.l}</td><td>{t.gf}</td><td>{t.ga}</td><td>{t.gd}</td><td className="bold">{(Array.isArray(cur.matches) && cur.matches.length>0 ? computeTeamBonus(computeStandings(cur.matches).filter(r => getActiveTeamsSafe(typeof cur !== "undefined" ? cur : undefined).includes(r.team)), (typeof cur !== "undefined" ? (cur as any)?.hasTeamD : false) || false)[t.team] : 0)}</td></tr>
                ))}
              </tbody></table>
            </div>
          </section>

          <section className="box">
            <h3>오늘의 개인 순위</h3>
            <div className="table-wrap">
              <table className="tbl"><thead><tr>
                <th>순위</th><th>선수</th><th>팀명</th><th>G</th><th>A</th><th>CS</th><th>수비</th><th>팀</th><th>총점</th>
              </tr></thead><tbody>
                {sortedDaily.map((r: any, idx: number) => (
                  <tr key={r.id}>
                    <td>{idx + 1}</td>
                    <td>{r.name}</td>
                    <td>{hideTeamNameForGKIds.has(r.id) ? "" : (r.team && r.team !== "-" ? <TeamSwatch team={r.team as TeamId} /> : "-")}</td>
                    <td>{r.goals || 0}</td>
                    <td>{r.assists || 0}</td>
                    <td>{r.cleansheets || 0}</td>
                    <td>{r.def || 0}</td>
                    <td>{r.teamBonus || 0}</td>
                    <td className="bold">{r.total || 0}</td>
                  </tr>
                ))}
              </tbody></table>
            </div>
          </section>
        </>
      )}

      {/* 전체 순위/선수분석/랭킹 보드 페이지는 이전과 동일 … */}
      
      <section className={`box ${page === 3 ? "" : "hidden"}`}>
        <h3>전체 순위</h3>

        <div className="row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <span className="label-strong">기록 보기:</span>
          <select value={statsFilterMode} onChange={e => setStatsFilterMode(e.target.value as any)}>
            <option value="all">전체</option>
            <option value="season">시즌</option>
            <option value="range">기간</option>
          </select>

          {statsFilterMode === "season" && (
            <>
              <span className="subtle">시즌:</span>
              <select value={statsSeason || ""} onChange={e => setStatsSeason(e.target.value)} style={{ minWidth: 140 }}>
                {availableSeasons.map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <span className="hint">예) 2025-2 = 2025년 7~12월</span>
            </>
          )}

          {statsFilterMode === "range" && (
            <>
              <span className="subtle">시작:</span>
              <input type="date" value={statsRangeStart ? ensureSunday(statsRangeStart) : ""} onChange={e => setStatsRangeStart(ensureSunday(e.target.value))} />
              <span className="subtle">끝:</span>
              <input type="date" value={statsRangeEnd ? ensureSunday(statsRangeEnd) : ""} onChange={e => setStatsRangeEnd(ensureSunday(e.target.value))} />
              <span className="hint">일요일로 자동 보정</span>
            </>
          )}

          <span className="badge-view" style={{ marginLeft: "auto" }}>
            현재: {filterLabel} · {filteredSessionEntries.length}회차
          </span>
        </div>

        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>순위</th>
                <th>선수</th>
                <th
                  style={{ cursor: "pointer", userSelect: "none" }}
                  onClick={() => {
                    const k: OverallSortKey = "days";
                    if (overallSortKey === k) setOverallSortDir(d => (d === "desc" ? "asc" : "desc"));
                    else { setOverallSortKey(k); setOverallSortDir("desc"); }
                  }}
                >
                  참여{overallSortKey === "days" ? (overallSortDir === "desc" ? " ▼" : " ▲") : ""}
                </th>
                <th
                  style={{ cursor: "pointer", userSelect: "none" }}
                  onClick={() => {
                    const k: OverallSortKey = "goals";
                    if (overallSortKey === k) setOverallSortDir(d => (d === "desc" ? "asc" : "desc"));
                    else { setOverallSortKey(k); setOverallSortDir("desc"); }
                  }}
                >
                  G{overallSortKey === "goals" ? (overallSortDir === "desc" ? " ▼" : " ▲") : ""}
                </th>
                <th
                  style={{ cursor: "pointer", userSelect: "none" }}
                  onClick={() => {
                    const k: OverallSortKey = "assists";
                    if (overallSortKey === k) setOverallSortDir(d => (d === "desc" ? "asc" : "desc"));
                    else { setOverallSortKey(k); setOverallSortDir("desc"); }
                  }}
                >
                  A{overallSortKey === "assists" ? (overallSortDir === "desc" ? " ▼" : " ▲") : ""}
                </th>
                <th
                  style={{ cursor: "pointer", userSelect: "none" }}
                  onClick={() => {
                    const k: OverallSortKey = "cleansheets";
                    if (overallSortKey === k) setOverallSortDir(d => (d === "desc" ? "asc" : "desc"));
                    else { setOverallSortKey(k); setOverallSortDir("desc"); }
                  }}
                >
                  CS{overallSortKey === "cleansheets" ? (overallSortDir === "desc" ? " ▼" : " ▲") : ""}
                </th>
                <th
                  style={{ cursor: "pointer", userSelect: "none" }}
                  onClick={() => {
                    const k: OverallSortKey = "def";
                    if (overallSortKey === k) setOverallSortDir(d => (d === "desc" ? "asc" : "desc"));
                    else { setOverallSortKey(k); setOverallSortDir("desc"); }
                  }}
                >
                  수비{overallSortKey === "def" ? (overallSortDir === "desc" ? " ▼" : " ▲") : ""}
                </th>
                <th
                  style={{ cursor: "pointer", userSelect: "none" }}
                  onClick={() => {
                    const k: OverallSortKey = "teamBonus";
                    if (overallSortKey === k) setOverallSortDir(d => (d === "desc" ? "asc" : "desc"));
                    else { setOverallSortKey(k); setOverallSortDir("desc"); }
                  }}
                >
                  팀{overallSortKey === "teamBonus" ? (overallSortDir === "desc" ? " ▼" : " ▲") : ""}
                </th>
                <th
                  style={{ cursor: "pointer", userSelect: "none" }}
                  onClick={() => {
                    const k: OverallSortKey = "total";
                    if (overallSortKey === k) setOverallSortDir(d => (d === "desc" ? "asc" : "desc"));
                    else { setOverallSortKey(k); setOverallSortDir("desc"); }
                  }}
                >
                  총점{overallSortKey === "total" ? (overallSortDir === "desc" ? " ▼" : " ▲") : ""}
                </th>
                <th
                  style={{ cursor: "pointer", userSelect: "none" }}
                  onClick={() => {
                    const k: OverallSortKey = "average";
                    if (overallSortKey === k) setOverallSortDir(d => (d === "desc" ? "asc" : "desc"));
                    else { setOverallSortKey(k); setOverallSortDir("desc"); }
                  }}
                >
                  평균{overallSortKey === "average" ? (overallSortDir === "desc" ? " ▼" : " ▲") : ""}
                </th>
              </tr>
            </thead>

            <tbody>
              {sortedCumulativeFilteredSorted.map((r: any, idx: number) => (
                <tr key={r.id}>
                  <td>{idx + 1}</td>
                  <td>{r.name}</td>
                  <td>{r.days}</td>
                  <td>{r.goals}</td>
                  <td>{r.assists}</td>
                  <td>{r.cleansheets}</td>
                  <td>{r.def}</td>
                  <td>{r.teamBonus}</td>
                  <td className="bold">{r.total}</td>
                  <td>{r.average}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>


      <section className={`box ${page === 4 ? "" : "hidden"}`}>
        <h3>선수별 분석</h3>
        <div className="row">
          <label>선수 선택:</label>
          <select
            value={selectedPlayerId || ""}
            onChange={e => setSelectedPlayerId(e.target.value || null)}
          >
            <option value="">-- 선택 --</option>
            {playersSorted.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>

        {selectedPlayerData && (
          <div className="analysis">
            <h4>{selectedPlayerData.name} ({selectedPlayerData.teamName})</h4>
            <div style={{ margin: '8px 0 16px 0' }}>
              <FifaSection
                players={[{ id: (selectedPlayerId || (selectedPlayerData as any).id), name: selectedPlayerData.name }]}
                readonly
              />
            </div>

            <div className="charts" style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 360px", minWidth: 320 }}>
                <ResponsiveContainer width="100%" height={300}>
                  <RadarChart data={[
                    { stat: "Goals", value: selectedPlayerData.goals },
                    { stat: "Assists", value: selectedPlayerData.assists },
                    { stat: "Defense", value: selectedPlayerData.def },
                    { stat: "CS", value: selectedPlayerData.cleansheets },
                    { stat: "Team", value: selectedPlayerData.teamBonus },
                  ]}>
                    <PolarGrid />
                    <PolarAngleAxis dataKey="stat" stroke="#EAEAEA" />
                    <PolarRadiusAxis domain={[0, globalMaxValue]} stroke="#A9A9A9" />
                    <Radar dataKey="value" stroke="#D4AF37" fill="#D4AF37" fillOpacity={0.6} />
                  </RadarChart>
                </ResponsiveContainer>
              </div>

              <div style={{ flex: "1 1 360px", minWidth: 320 }}>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={Object.entries(sessionsByDate).sort(([a],[b])=>a.localeCompare(b)).map(([dateKey, s])=>{
                    const sc = calcScores(s); const row = sc[selectedPlayerId!] || { total: 0 };
                    return { date: dateKey.slice(5), total: row.total };
                  })}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#23252B" />
                    <XAxis dataKey="date" stroke="#EAEAEA" />
                    <YAxis stroke="#EAEAEA" />
                    <Tooltip />
                    <Line type="monotone" dataKey="total" stroke="#D4AF37" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        )}
      </section>

      <section className={`box ${page === 5 ? "" : "hidden"}`}>
        <h3>🏆 선수 랭킹 보드</h3>

        <div className="row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 6 }}>
          <span className="label-strong">기록 보기:</span>
          <select value={statsFilterMode} onChange={e => setStatsFilterMode(e.target.value as any)}>
            <option value="all">전체</option>
            <option value="season">시즌</option>
            <option value="range">기간</option>
          </select>

          {statsFilterMode === "season" && (
            <>
              <span className="subtle">시즌:</span>
              <select value={statsSeason || ""} onChange={e => setStatsSeason(e.target.value)} style={{ minWidth: 140 }}>
                {availableSeasons.map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </>
          )}

          {statsFilterMode === "range" && (
            <>
              <span className="subtle">시작:</span>
              <input type="date" value={statsRangeStart ? ensureSunday(statsRangeStart) : ""} onChange={e => setStatsRangeStart(ensureSunday(e.target.value))} />
              <span className="subtle">끝:</span>
              <input type="date" value={statsRangeEnd ? ensureSunday(statsRangeEnd) : ""} onChange={e => setStatsRangeEnd(ensureSunday(e.target.value))} />
            </>
          )}

          <span className="badge-view" style={{ marginLeft: "auto" }}>
            현재: {filterLabel} · {filteredSessionEntries.length}회차
          </span>
        </div>


        <div className="ranking-section">
          <h4>총점</h4>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={top5Ranking("total")}>
              <XAxis dataKey="name" stroke="#EAEAEA" />
              <YAxis stroke="#EAEAEA" />
              <Tooltip />
              <Bar dataKey="total" fill="#D4AF37" />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* 5개 섹션이 한 행에 고정 */}
        <div className="ranking-grid">
          {[
            { key: "goals", title: "⚽ 득점왕" },
            { key: "assists", title: "🎯 도움왕" },
            { key: "def", title: "🛡 수비 기여도" },
            { key: "teamBonus", title: "🤝 팀 기여도" },
            { key: "cleansheets", title: "🧤 클린시트" }
          ].map(cat => (
            <div className="ranking-section" key={cat.key}>
              <h4>{cat.title}</h4>
              <div className="rank-cards">
                {top5Ranking(cat.key as any).map((p) => (
                  <div key={p.id} className={`rank-card rank-${p.rank}`}>
                    <span className="rank-badge">{p.rank}</span>
                    <span className="player-name">{p.name}</span>
                    <span className="player-score">{(p as any)[cat.key]}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <p className="footer">© 골딘 기록앱</p>

      <style>{`
        :root{
          --gold:#D4AF37; --gold-2:#C89B3C; --emblem-word:#EAEAEA;
          --bg:#0B0C0F; --card:#15161A; --line:#23252B; --text:#EAEAEA; --muted:#A9A9A9;

          /* 조끼 색상 */
          --jersey-red:#E74C3C;
          --jersey-yellow:#F1C40F;
          --jersey-green:#4CAF50;
          --jersey-stroke:#0a0b0f;
        }
        *, *::before, *::after { box-sizing: border-box; }
        body { background: var(--bg); }

        .wrap { max-width: 1100px; margin: 0 auto; padding: 14px; font-family: system-ui, -apple-system, Segoe UI, Roboto, "Noto Sans KR", sans-serif; color: var(--text); background: var(--bg); }
        .title { font-size: 22px; font-weight: 800; margin: 4px 0 10px; letter-spacing: .2px; }

        .panel { display:flex; gap:8px; align-items:center; flex-wrap:wrap; padding:10px; border:1px solid var(--line); border-radius:12px; background: linear-gradient(180deg, #121318, #0E0F13); }
        .badge-view { font-size:12px; color:#ff7a7a; font-weight:700; }
        .label-strong { font-weight:700; color: var(--text); }
        .ok { color: var(--gold); font-weight:700; }
        .hint { color: var(--muted); font-size:12px; }
        .muted { color: var(--muted); }

        .tabs { display:flex; gap:8px; margin:12px 0; flex-wrap: wrap; }
        .tab { padding:8px 12px; border:1px solid var(--line); border-radius:999px; background:#15161A; color:var(--text); cursor:pointer; transition:all .15s; }
        .tab:hover { border-color: var(--gold-2); }
        .tab.active { background: var(--gold); color:#1A1A1A; border-color: var(--gold); }

        .row { display:flex; gap:8px; align-items:center; margin:6px 0; }
        .row.spread { justify-content: space-between; }
        .box { border:1px solid var(--line); border-radius:12px; padding:12px; margin-top:12px; background: var(--card); box-shadow: 0 1px 8px rgba(0,0,0,.35); }
        .hidden { display:none; }

        .teams-grid { display:grid; grid-template-columns: repeat(3, 1fr); gap:10px; }
        .team-card { border:1px solid var(--line); border-radius:12px; padding:8px; background:#111318; }
        .team-id { margin-left:auto; font-size:12px; color: var(--muted); }
        .checkline { display:flex; gap:6px; align-items:center; padding:4px 0; }
        .badge-gk { margin-left:6px; font-size:11px; padding:2px 6px; border:1px solid var(--gold-2); border-radius:999px; color:var(--gold); }

        .list-scroll { max-height: 280px; overflow:auto; border:1px solid var(--line); border-radius:8px; padding:6px; background:#0E1015; }
        .list-scroll.small { max-height: 200px; }

        /* 선수관리 */
        .players-admin-grid { display: grid; grid-template-columns: 1fr; gap: 8px; }
        @media (min-width: 1024px) { .players-admin-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
        .player-admin-item { display:grid; grid-template-columns: 1fr 84px 78px; gap:6px; border:1px solid var(--line); border-radius:10px; padding:6px; background:#0B0C10; }
        .player-name-input { min-width: 0; width:100%; padding:6px 8px; font-size:14px; }
        .player-admin-item select { padding:6px 8px; font-size:14px; }
        .player-admin-item button { padding:6px 8px; font-size:13px; }

        .table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; border:1px solid var(--line); border-radius:10px; padding:6px; background:#0F1116; }
        .tbl { width: 100%; border-collapse: separate; border-spacing: 0; color: var(--text); }
        .tbl th, .tbl td { border-bottom:1px solid #1f2127; padding:8px 10px; text-align:center; }
        .tbl th { background:#141721; position: sticky; top: 0; z-index: 1; color:#dcdcdc; }
        .bold { font-weight:700; color: var(--gold); }
        .subtle { color:#b0b0b0; font-size:12px; }

        .card { border:1px solid var(--line); border-radius:12px; padding:10px; background:#111318; overflow: hidden; }

        .match-head { display: grid; grid-template-columns: 72px 1fr auto; grid-template-areas: "seq score actions"; gap: 10px; align-items: center; }
        .seq { grid-area: seq; font-weight: 800; color: var(--gold); }
        .scoreline { grid-area: score; display: grid; grid-template-columns: 1fr 72px 22px 72px 1fr; gap: 6px; align-items: center; }
        .colon { text-align:center; font-weight:700; color: var(--muted); }
        .head-actions { grid-area: actions; display:flex; gap:6px; justify-content:flex-end; flex-wrap: nowrap; }
        .danger { color:#ff8a8a; }

        .score-input { width: 72px; height: 38px; border:1px solid var(--line); border-radius:8px; text-align:center; font-size:15px; background:#0D0F14; color: var(--text); }

        .gk-row { display:flex; gap:12px; align-items:center; margin-top:6px; flex-wrap: wrap; }

        .record-grid { display:grid; grid-template-columns: 1fr 1fr; gap:12px; margin-top:10px; }
        .team-col { border:1px solid var(--line); border-radius:10px; padding:8px; background:#0E1015; }
        .team-col-head { font-weight:700; margin-bottom:6px; color: var(--gold); }

        .players-grid { display: grid; grid-template-columns: 1fr; gap: 8px; }
        .player-card { border:1px solid var(--line); border-radius:10px; padding:8px; background:#0B0C10; display:flex; align-items:center; gap:8px; flex-wrap: wrap; }
        .player-name { flex:1 1 180px; min-width: 140px; font-weight:600; color: var(--text); }
        .pos { color:#9aa0aa; font-size:12px; }

        .stat { display:inline-flex; align-items:center; gap:6px; }
        .stat-label { font-weight:600; color:#cfcfcf; }
        .stat-input { width:64px; height:38px; padding:6px 8px; border:1px solid var(--line); border-radius:8px; text-align:center; font-size:15px; background:#0D0F14; color: var(--text); }
        .stat-input.select { width:64px; height:38px; }

        input, select, textarea, button { padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background:#0D0F14; color: var(--text); font-size:16px; }
        input::placeholder, textarea::placeholder { color:#7f8694; }
        button { background:#12151C; cursor:pointer; transition: all .15s; }
        button:hover { border-color: var(--gold); box-shadow: 0 0 0 2px rgba(212,175,55,0.08) inset; }
        textarea { width:100%; min-height: 80px; }

        .analysis h4 { margin: 0 0 8px; }

        /* ===== 포메이션 미리보기 ===== */
        .formation-card { margin-top:10px; border:1px solid var(--line); border-radius:10px; padding:8px; background:#0D1016; }
        .formation-title { font-weight:700; margin-bottom:6px; }
        .pitch { width:100%; height:auto; display:block; background:#0D0F14; border-radius:8px; }
        .pitch-bg { fill:#0E1218; }
        .pitch-line { stroke:#2A2E36; stroke-width:0.7; }
        .pitch-circle { fill:none; stroke:#2A2E36; stroke-width:0.7; }
        .player-shadow { fill:#000; opacity:.35; transform: translateY(1px); }
        .player-initials { fill:#0D0F14; font-size:3.2px; font-weight:800; }
        .player-label { fill:#cfd3db; font-size:2.6px; }

        /* ===== 랭킹 보드 ===== */
        .ranking-grid { display: grid; grid-template-columns: 1fr; gap: 12px; }
        @media (min-width: 640px) { .ranking-grid { grid-template-columns: repeat(2, 1fr); } }
        @media (min-width: 880px) { .ranking-grid { grid-template-columns: repeat(3, 1fr); } }
        @media (min-width: 1024px){ .ranking-grid { grid-template-columns: repeat(5, 1fr); } }

        .ranking-section { min-width: 0; }
        .ranking-section h4 { margin: 6px 0 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .rank-cards { display:flex; flex-direction: column; gap: 6px; }
        .rank-card { display:flex; align-items:center; background:#1c1c1f; border-radius:10px; padding:6px 8px; color:var(--text); border:1px solid #24262c; gap:4px; }
        .rank-card .rank-badge { font-weight:800; color:var(--emblem-word); font-size:14px; line-height:1; } /* 순위 숫자: 엠블럼 글자색 */
        .rank-card .player-name { flex:1 1 auto; margin:0 4px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; font-size:14px; }
        .rank-card .player-score { font-weight:800; color:var(--gold); font-size:14px; line-height:1; }
        .rank-card.rank-1 { border-color:#FFD700; box-shadow:0 0 0 1px rgba(212,175,55,.2) inset; background:#202127; }

        @media (max-width: 900px) { .scoreline { grid-template-columns: 1fr 62px 18px 62px 1fr; } .score-input { width: 62px; } }
        @media (max-width: 480px) {
          .match-head { grid-template-columns: 1fr; grid-template-areas: "seq" "score" "actions"; row-gap: 8px; align-items: stretch; }
          .seq { font-size: 16px; }
          .scoreline { grid-template-columns: minmax(0,1fr) 54px 14px 54px minmax(0,1fr); }
          .head-actions { justify-content: flex-start; flex-wrap: wrap; }
          .head-actions button { padding: 6px 10px; }
          .gk-row { gap: 8px; }
          .score-input { width: 54px; }
        }
        @media (max-width: 360px) { .scoreline { grid-template-columns: minmax(0,1fr) 48px 12px 48px minmax(0,1fr); } .stat-input { width: 56px; } .score-input { width: 48px; } }
        @media (max-width: 720px) {
          .teams-grid { grid-template-columns: 1fr; }
          .record-grid { grid-template-columns: 1fr; }
          .table-wrap { border: none; padding: 0; background: transparent; }
          .tbl th, .tbl td { border-bottom: 1px solid #23262c; }
          .tbl tr:last-child td { border-bottom: none; }
          .card { box-shadow: 0 1px 4px rgba(0,0,0,0.4); border: 1px solid var(--line); }
          .box { border: 1px solid var(--line); }
          .player-name { flex-basis: 100%; }
        }
      
        /* === Readability improvements for jersey texts === */
        .player-initials {
          font-size: 7px;
          font-weight: 700;
          fill: #ffffff;
          stroke: #000000;
          stroke-width: 0.8px;
          paint-order: stroke fill;
          pointer-events: none;
        }
        .player-label {
          font-size: 6px;
          font-weight: 600;
          fill: #ffffff;
          stroke: #000000;
          stroke-width: 0.5px;
          paint-order: stroke fill;
          pointer-events: none;
        }
`}</style>
    </div>
  );
}

/* ====== AddPlayer ====== */
function AddPlayer({ onAdd, disabled }: { onAdd: (name: string) => void; disabled?: boolean }) {
  const [name, setName] = useState("");
  return (
    <div className="row">
      <input
        placeholder="이름"
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter" && !disabled) { onAdd(name); setName(""); } }}
        disabled={disabled}
      />
      <button onClick={() => { if (!disabled) { onAdd(name); setName(""); } }} disabled={disabled}>추가</button>
    </div>
  );
}
