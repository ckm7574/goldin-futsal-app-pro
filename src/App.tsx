/* 개선된 App.tsx - 골키퍼 필드 플레이어 통계 반영 문제 해결 */

import React, { useEffect, useMemo, useRef, useState } from "react";

// ====== 공통 타입/유틸 ======
const TEAM_IDS = ["A", "B", "C", "D"] as const;
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
  formations?: Record<TeamId, FormationKey>;
  posOverrides?: Record<string, Player["pos"]>; // 날짜별 포지션 오버라이드 (예: GK -> 필드)
};

type PersistShape = {
  players: Player[];
  cardPrefs?: Record<string, { style?: string }>;
  teamNames: Record<TeamId, string>;
  sessionsByDate: Record<string, Session>;
  sessionDate: string;
};

// 개선된 통계 계산 함수 - posOverrides 반영
function calcScores(session: Session, players: Player[], globalTeamNames: Record<TeamId, string>) {
  const out: Record<string, any> = {};
  const teamNamesUse = globalTeamNames;

  const teamOf = (pid: string): TeamId | "-" =>
    (session.rosters.A || []).includes(pid) ? "A" :
    (session.rosters.B || []).includes(pid) ? "B" :
    (session.rosters.C || []).includes(pid) ? "C" :
    (session.rosters.D || []).includes(pid) ? "D" : "-";

  // 개선된 포지션 판단 함수
  const getEffectivePosition = (pid: string): Player["pos"] => {
    // 1. 날짜별 오버라이드 먼저 적용
    const override = session?.posOverrides?.[pid];
    if (override === "GK" || override === "필드") {
      return override;
    }
    // 2. 기본 포지션 사용
    const player = players.find(p => p.id === pid);
    return player?.pos || "필드";
  };

  const activeTeams = session.hasTeamD ? ["A", "B", "C", "D"] : ["A", "B", "C"];
  const standings = computeStandings(session.matches, activeTeams);
  const teamBonusByTeam = computeTeamBonus(standings, session.hasTeamD || false);
  const hasMatches = Array.isArray(session.matches) && session.matches.length > 0;

  // GK 승리 횟수 계산
  const gkWins: Record<string, number> = {};
  (session.matches || []).forEach(m => {
    const hg = Number(m.hg) || 0, ag = Number(m.ag) || 0;
    if (hg > ag && m.gkHome) gkWins[m.gkHome] = (gkWins[m.gkHome] || 0) + 1;
    if (ag > hg && m.gkAway) gkWins[m.gkAway] = (gkWins[m.gkAway] || 0) + 1;
  });

  // 개선된 GK 판단 로직 - posOverrides 반영
  const teamGKs: Record<TeamId, string[]> = { A: [], B: [], C: [], D: [] };
  activeTeams.forEach(tid => {
    teamGKs[tid] = (session.rosters[tid] || []).filter(pid => {
      return getEffectivePosition(pid) === "GK";
    });
  });

  // 매치 스탯 처리
  (session.matches || []).forEach(m => {
    const ms = session.matchStats?.[m.id] || {};
    Object.entries(ms).forEach(([pid, s]) => {
      const base = out[pid] || { goals: 0, assists: 0, cleansheets: 0 };
      out[pid] = {
        goals: base.goals + (Number((s as any).goals) || 0),
        assists: base.assists + (Number((s as any).assists) || 0),
        cleansheets: base.cleansheets
      };
    });
    
    // 클린시트 처리
    if (Number(m.ag) === 0 && m.gkHome) {
      const b = out[m.gkHome] || { goals: 0, assists: 0, cleansheets: 0 };
      out[m.gkHome] = { ...b, cleansheets: (b.cleansheets || 0) + 1 };
    }
    if (Number(m.hg) === 0 && m.gkAway) {
      const b = out[m.gkAway] || { goals: 0, assists: 0, cleansheets: 0 };
      out[m.gkAway] = { ...b, cleansheets: (b.cleansheets || 0) + 1 };
    }
  });

  // 모든 선수 기본값 설정
  activeTeams.forEach(tid => {
    (session.rosters[tid] || []).forEach(pid => {
      if (!out[pid]) out[pid] = { goals: 0, assists: 0, cleansheets: 0 };
    });
  });

  // 최종 점수 계산 - posOverrides 반영
  const collator = new Intl.Collator("ko-KR", { sensitivity: "base", numeric: true });
  Object.keys(out).forEach(pid => {
    const team = teamOf(pid);
    // 개선된 GK 판단 - posOverrides 반영
    const isGK = getEffectivePosition(pid) === "GK";
    const def = team !== "-" && (session.defAwards?.[team] || null) === pid ? 2 : 0;

    let teamBonus = 0;
    if (team !== "-" && hasMatches) {
      if (isGK) {
        const gks = teamGKs[team];
        if (gks.length <= 1) {
          teamBonus = teamBonusByTeam[team] || 0;
        } else {
          // GK 2명일 때: 승리 횟수 -> 클린시트 -> 이름 순
          const gkWinsCount = Object.fromEntries(gks.map(id => [id, gkWins[id] || 0]));
          const gkCSCount = Object.fromEntries(gks.map(id => [id, out[id]?.cleansheets || 0]));
          const sortedByWins = [...gks].sort((a, b) => {
            return (gkWinsCount[b] - gkWinsCount[a]) ||
                   (gkCSCount[b] - gkCSCount[a]) ||
                   collator.compare(
                     players.find(p => p.id === a)?.name || "",
                     players.find(p => p.id === b)?.name || ""
                   );
          });

          const top = sortedByWins[0];
          const second = sortedByWins[1];
          const tieWins = (gkWinsCount[top] || 0) === (gkWinsCount[second] || 0);
          const tieCS = (gkCSCount[top] || 0) === (gkCSCount[second] || 0);
          
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
      teamName: team === "-" ? "-" : teamNamesUse[team],
      isGK
    };
  });

  return out;
}

// 개선된 순위 계산 함수
function computeStandings(matchesInput: Match[] | null | undefined, activeTeams: TeamId[] = ["A", "B", "C"]) {
  const matches = matchesInput || [];
  const t: Record<TeamId, any> = {};
  
  activeTeams.forEach(teamId => {
    t[teamId] = {
      team: teamId,
      pts: 0, gf: 0, ga: 0, gd: 0,
      w: 0, d: 0, l: 0
    };
  });
  
  const seen = new Set<TeamId>();
  matches.forEach(m => {
    if (!activeTeams.includes(m.home) || !activeTeams.includes(m.away)) return;
    
    seen.add(m.home as TeamId);
    seen.add(m.away as TeamId);
    
    const HG = Number(m.hg) || 0, AG = Number(m.ag) || 0;
    t[m.home].gf += HG; t[m.home].ga += AG;
    t[m.away].gf += AG; t[m.away].ga += HG;
    
    if (HG > AG) {
      t[m.home].pts += 3; t[m.home].w++; t[m.away].l++;
    } else if (HG < AG) {
      t[m.away].pts += 3; t[m.away].w++; t[m.home].l++;
    } else {
      t[m.home].pts++; t[m.away].pts++;
      t[m.home].d++; t[m.away].d++;
    }
  });
  
  activeTeams.forEach(k => {
    t[k].gd = t[k].gf - t[k].ga;
  });
  
  return Object.values(t).sort((a, b) => 
    b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || a.team.localeCompare(b.team)
  );
}

function computeTeamBonus(st: any[], hasTeamD: boolean): Record<TeamId, number> {
  const order = st.map(s => s.team);
  const map: Record<TeamId, number> = { A: 0, B: 0, C: 0, D: 0 };
  
  if (hasTeamD) {
    order.forEach((tid, i) => { 
      map[tid] = i === 0 ? 4 : i === 1 ? 3 : i === 2 ? 2 : 1; 
    });
  } else {
    order.forEach((tid, i) => { 
      map[tid] = i === 0 ? 4 : i === 1 ? 2 : 1; 
    });
  }
  
  return map;
}

// 기본 데이터
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
  { name: "한형진", pos: "필드" }
] as const;

// 개선된 UI 컴포넌트
const TeamSwatch: React.FC<{ team: TeamId; size?: number; rounded?: number }> = ({ team, size = 14, rounded = 4 }) => {
  const TEAM_SWATCH_HEX: Record<TeamId, string> = { 
    A: "#dc2626", B: "#fbbf24", C: "#16a34a", D: "#ffffff" 
  };
  
  return (
    <span
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: rounded,
        background: TEAM_SWATCH_HEX[team],
        border: "2px solid rgba(255,255,255,0.3)",
        verticalAlign: "middle"
      }}
    />
  );
};

const PositionBadge: React.FC<{ position: Player["pos"]; size?: "sm" | "md" | "lg" }> = ({ position, size = "md" }) => {
  const sizeClasses = {
    sm: "px-2 py-1 text-xs",
    md: "px-3 py-1 text-sm",
    lg: "px-4 py-2 text-base"
  };

  const positionClasses = {
    GK: "bg-red-500/20 text-red-300 border-red-500/30",
    필드: "bg-green-500/20 text-green-300 border-green-500/30"
  };

  const icons = {
    GK: "🧤",
    필드: "⚽"
  };

  return (
    <span className={`inline-flex items-center gap-1 rounded-full border ${positionClasses[position]} ${sizeClasses[size]}`}>
      <span>{icons[position]}</span>
      {position}
    </span>
  );
};

// 개선된 메인 컴포넌트
export default function App() {
  const [players, setPlayers] = useState<Player[]>(() => 
    DEFAULT_PLAYERS.map(p => ({ ...p, id: Math.random().toString(36).slice(2, 9), active: true }))
  );
  
  const [sessionsByDate, setSessionsByDate] = useState<Record<string, Session>>({});
  const [sessionDate, setSessionDate] = useState<string>("");
  const [currentPage, setCurrentPage] = useState<string>("dashboard");

  // 개선된 통계 계산
  const currentSessionStats = useMemo(() => {
    const session = sessionsByDate[sessionDate];
    if (!session) return {};
    return calcScores(session, players, {
      A: "빨강 팀", B: "노랑 팀", C: "초록 팀", D: "흰색 팀"
    });
  }, [sessionsByDate, sessionDate, players]);

  // 전체 랭킹 계산 (모든 세션 집계)
  const overallRanking = useMemo(() => {
    const allStats: Record<string, any> = {};
    
    Object.entries(sessionsByDate).forEach(([date, session]) => {
      const stats = calcScores(session, players, {
        A: "빨강 팀", B: "노랑 팀", C: "초록 팀", D: "흰색 팀"
      });
      
      Object.entries(stats).forEach(([playerId, stat]) => {
        if (!allStats[playerId]) {
          const player = players.find(p => p.id === playerId);
          allStats[playerId] = {
            id: playerId,
            name: stat.name,
            goals: 0,
            assists: 0,
            cleansheets: 0,
            def: 0,
            teamBonus: 0,
            total: 0,
            days: 0,
            position: player?.pos || "필드"
          };
        }
        
        allStats[playerId].goals += stat.goals;
        allStats[playerId].assists += stat.assists;
        allStats[playerId].cleansheets += stat.cleansheets;
        allStats[playerId].def += stat.def;
        allStats[playerId].teamBonus += stat.teamBonus;
        allStats[playerId].total += stat.total;
        allStats[playerId].days += 1;
      });
    });

    return Object.values(allStats)
      .map(player => ({
        ...player,
        average: player.days > 0 ? (player.total / player.days).toFixed(2) : '0.00'
      }))
      .sort((a, b) => b.total - a.total);
  }, [sessionsByDate, players]);

  // 초기 데이터 로드
  useEffect(() => {
    // 초기 세션 데이터 생성
    const initialSessions: Record<string, Session> = {
      '2024-01-07': {
        rosters: {
          A: players.slice(0, 5).map(p => p.id),
          B: players.slice(5, 10).map(p => p.id),
          C: players.slice(10, 15).map(p => p.id),
          D: []
        },
        matches: [
          {
            id: 'match1',
            seq: 1,
            home: 'A',
            away: 'B',
            hg: 3,
            ag: 2,
            gkHome: players.find(p => p.name === '이용범')?.id || null,
            gkAway: players.find(p => p.name === '최준형')?.id || null
          }
        ],
        matchStats: {
          'match1': {
            // 통계 데이터
          }
        },
        defAwards: { A: null, B: null, C: null, D: null },
        notes: "",
        hasTeamD: false,
        formations: { A: "1-2-1", B: "1-2-1", C: "1-2-1", D: "1-2-1" },
        posOverrides: {
          // 이용범을 GK에서 필드로 변경 - 이것이 통계에 반영되어야 함
          [players.find(p => p.name === '이용범')?.id || '']: '필드'
        }
      }
    };

    setSessionsByDate(initialSessions);
    setSessionDate('2024-01-07');
  }, []);

  // 개선된 UI 렌더링
  const renderDashboard = () => (
    <div className="space-y-6">
      <div className="card">
        <h2 className="text-2xl font-bold mb-6 flex items-center gap-3">
          <i className="fas fa-chart-line text-blue-400"></i>
          일일 통계
        </h2>
        
        <div className="mb-6">
          <label className="block text-sm font-medium mb-2 text-gray-300">날짜 선택:</label>
          <select 
            value={sessionDate}
            onChange={(e) => setSessionDate(e.target.value)}
            className="input w-full max-w-xs"
          >
            {Object.keys(sessionsByDate).map(date => (
              <option key={date} value={date}>{date}</option>
            ))}
          </select>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {Object.entries(currentSessionStats).map(([playerId, stat]) => {
            const player = players.find(p => p.id === playerId);
            const effectivePosition = sessionsByDate[sessionDate]?.posOverrides?.[playerId] || player?.pos || '필드';
            
            return (
              <div key={playerId} className="ranking-card hover:border-blue-500/50 transition-all duration-300">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-bold text-lg text-white">{stat.name}</h3>
                  <PositionBadge position={effectivePosition} />
                </div>
                
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between items-center">
                    <span className="text-gray-400">골:</span>
                    <span className="stats-badge badge-goals">{stat.goals}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-gray-400">어시스트:</span>
                    <span className="stats-badge badge-assists">{stat.assists}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-gray-400">클린시트:</span>
                    <span className="stats-badge badge-cleansheets">{stat.cleansheets}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-gray-400">수비점수:</span>
                    <span className="text-yellow-400 font-semibold">{stat.def}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-gray-400">팀보너스:</span>
                    <span className="text-purple-400 font-semibold">{stat.teamBonus}</span>
                  </div>
                  <div className="flex justify-between items-center font-bold text-lg border-t border-gray-700 pt-3 mt-3">
                    <span className="text-gray-300">총점:</span>
                    <span className="text-blue-400 font-bold">{stat.total}</span>
                  </div>
                </div>
                
                {stat.team && stat.team !== '-' && (
                  <div className="mt-3 pt-3 border-t border-gray-700">
                    <div className="flex items-center text-sm text-gray-400">
                      <TeamSwatch team={stat.team} />
                      <span>{stat.teamName}</span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );

  const renderRanking = () => (
    <div className="card">
      <h2 className="text-2xl font-bold mb-6 flex items-center gap-3">
        <i className="fas fa-trophy text-yellow-400"></i>
        전체 랭킹
      </h2>
      
      <div className="overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th className="text-center">순위</th>
              <th>선수</th>
              <th className="text-center">포지션</th>
              <th className="text-center">경기수</th>
              <th className="text-center">골</th>
              <th className="text-center">어시스트</th>
              <th className="text-center">클린시트</th>
              <th className="text-center">수비점수</th>
              <th className="text-center">팀보너스</th>
              <th className="text-center">총점</th>
              <th className="text-center">평균</th>
            </tr>
          </thead>
          <tbody>
            {overallRanking.map((player, index) => (
              <tr key={player.id} className="hover:bg-gray-800/50 transition-colors">
                <td className="text-center">
                  <span className={`inline-flex items-center justify-center w-8 h-8 rounded-full font-bold text-sm ${
                    index === 0 ? 'bg-yellow-500 text-black' :
                    index === 1 ? 'bg-gray-300 text-black' :
                    index === 2 ? 'bg-orange-600 text-white' :
                    'bg-gray-700 text-white'
                  }`}>
                    {index + 1}
                  </span>
                </td>
                <td className="font-semibold text-white">{player.name}</td>
                <td className="text-center">
                  <PositionBadge position={player.position} size="sm" />
                </td>
                <td className="text-center text-gray-300">{player.days}</td>
                <td className="text-center">
                  <span className="stats-badge badge-goals text-xs">{player.goals}</span>
                </td>
                <td className="text-center">
                  <span className="stats-badge badge-assists text-xs">{player.assists}</span>
                </td>
                <td className="text-center">
                  <span className="stats-badge badge-cleansheets text-xs">{player.cleansheets}</span>
                </td>
                <td className="text-center text-yellow-400 font-semibold">{player.def}</td>
                <td className="text-center text-purple-400 font-semibold">{player.teamBonus}</td>
                <td className="text-center font-bold text-blue-400 text-lg">{player.total}</td>
                <td className="text-center text-gray-400 font-mono">{player.average}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  const pages = {
    dashboard: renderDashboard,
    ranking: renderRanking
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-blue-900 to-purple-900">
      <div className="container mx-auto px-4 py-8">
        <header className="text-center mb-8">
          <h1 className="text-4xl font-bold mb-2 bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">
            골딘 풋살 리그
          </h1>
          <p className="text-gray-300 text-lg">주말 풋살 리그 기록 관리 시스템</p>
        </header>

        <nav className="flex justify-center mb-8">
          <div className="flex bg-black/20 backdrop-blur-sm rounded-xl p-1 border border-white/10">
            <button 
              className={`px-6 py-3 rounded-lg font-medium transition-all duration-300 flex items-center gap-2 ${
                currentPage === 'dashboard' 
                  ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/30' 
                  : 'text-gray-300 hover:text-white hover:bg-white/10'
              }`}
              onClick={() => setCurrentPage('dashboard')}
            >
              <i className="fas fa-chart-line"></i>
              대시보드
            </button>
            <button 
              className={`px-6 py-3 rounded-lg font-medium transition-all duration-300 flex items-center gap-2 ${
                currentPage === 'ranking' 
                  ? 'bg-purple-600 text-white shadow-lg shadow-purple-600/30' 
                  : 'text-gray-300 hover:text-white hover:bg-white/10'
              }`}
              onClick={() => setCurrentPage('ranking')}
            >
              <i className="fas fa-trophy"></i>
              전체 랭킹
            </button>
          </div>
        </nav>

        <main>
          {pages[currentPage]()}
        </main>
      </div>
    </div>
  );
}