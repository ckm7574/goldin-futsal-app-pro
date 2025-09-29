import React, { forwardRef, useMemo } from "react";

export type FifaStats = {
  name: string;
  pos: string;
  ovr: number;
  pac: number; sho: number; pas: number;
  dri: number; def: number; phy: number;
  photoUrl?: string;
  nationFlag?: string;
  clubCrest?: string;
};

type Props = { stats: FifaStats };

/** Export helper: download current SVG as PNG */
export async function downloadSvgAsPng(svgEl: SVGSVGElement, filename = "card.png") {
  const serializer = new XMLSerializer();
  const svgStr = serializer.serializeToString(svgEl);
  const svgBlob = new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(svgBlob);
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = url;
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = (e) => reject(e);
  });
  const width = Number(svgEl.getAttribute("width") || 600);
  const height = Number(svgEl.getAttribute("height") || 860);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.drawImage(img, 0, 0, width, height);
  URL.revokeObjectURL(url);
  const a = document.createElement("a");
  a.download = filename;
  a.href = canvas.toDataURL("image/png");
  a.click();
}

/** FUT-like theme (free to tweak) */
const theme = {
  bgFrom: "#d8bf63",
  bgTo: "#b5941f",
  frame: "#111",
  text: "#111",
  nameText: "#111",
  statText: "#111",
  radius: 28,
};

const fonts = {
  rating: "'Teko','Rajdhani','DIN Condensed',system-ui,sans-serif",
  name: "'Oswald','Noto Sans KR',system-ui,sans-serif",
  labels: "'Rajdhani','Teko',system-ui,sans-serif",
};

const layout = {
  w: 600, h: 860, // doubled for better export quality
  pad: 28,
  avatar: { x: 120, y: 150, w: 360, h: 360, r: 180 },
  flag:   { x: 88, y: 250, size: 56 },
  crest:  { x: 88, y: 314, size: 56 },
  rating: { x: 86, y: 140 },
  pos:    { x: 86, y: 185 },
  nameY:  560,
  statLx: 110,
  statRx: 340,
  statsY: 640,
  rowGap: 64,
};

function StatRow({label, value, x, y}:{label:string; value:number; x:number; y:number}){
  return (
    <g>
      <text x={x} y={y} fontFamily={fonts.labels} fontSize={36} fontWeight={700} fill={theme.statText}>
        {String(value ?? 0).padStart(2,"0")}
      </text>
      <text x={x+70} y={y} fontFamily={fonts.labels} fontSize={34} fontWeight={700} fill={theme.statText}>
        {label}
      </text>
    </g>
  );
}

/** Main Card */
export const FifaCard = forwardRef<SVGSVGElement, Props>(function FifaCard({ stats }, ref) {
  const s = useMemo(()=> ({
    ...stats,
    name: (stats.name || "").toUpperCase(),
    pos: (stats.pos || "").toUpperCase(),
  }), [stats]);

  return (
    <svg ref={ref} width={layout.w} height={layout.h} viewBox={`0 0 ${layout.w} ${layout.h}`} xmlns="http://www.w3.org/2000/svg" role="img">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={theme.bgFrom} />
          <stop offset="100%" stopColor={theme.bgTo} />
        </linearGradient>
        <clipPath id="avatarClip">
          <circle cx={layout.avatar.x + layout.avatar.r} cy={layout.avatar.y + layout.avatar.r} r={layout.avatar.r} />
        </clipPath>
        <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="6" stdDeviation="8" floodOpacity="0.35"/>
        </filter>
      </defs>

      {/* Outer frame */}
      <g filter="url(#shadow)">
        <rect x={layout.pad} y={layout.pad} width={layout.w-2*layout.pad} height={layout.h-2*layout.pad} rx={theme.radius} ry={theme.radius} fill="url(#bg)" stroke={theme.frame} strokeWidth="6"/>
      </g>

      {/* Rating & Position */}
      <text x={layout.rating.x} y={layout.rating.y} fontFamily={fonts.rating} fontSize="120" fontWeight="800" fill={theme.text}>{s.ovr ?? 0}</text>
      <text x={layout.pos.x} y={layout.pos.y} fontFamily={fonts.rating} fontSize="68" fontWeight="700" fill={theme.text}>{s.pos || ""}</text>

      {/* Flag & Crest */}
      {s.nationFlag ? (
        <image href={s.nationFlag} x={layout.flag.x} y={layout.flag.y} width={layout.flag.size} height={layout.flag.size} preserveAspectRatio="xMidYMid slice"
          onError={(e)=>{ (e.currentTarget as any).style.display='none'; }}/>
      ) : null}
      {s.clubCrest ? (
        <image href={s.clubCrest} x={layout.crest.x} y={layout.crest.y} width={layout.crest.size} height={layout.crest.size} preserveAspectRatio="xMidYMid meet"
          onError={(e)=>{ (e.currentTarget as any).style.display='none'; }}/>
      ) : null}

      {/* Avatar (circle) */}
      {s.photoUrl ? (
        <image href={s.photoUrl} x={layout.avatar.x} y={layout.avatar.y} width={layout.avatar.w} height={layout.avatar.h}
          preserveAspectRatio="xMidYMid slice" clipPath="url(#avatarClip)"
          onError={(e)=>{ (e.currentTarget as any).style.display='none'; }}/>
      ) : null}

      {/* Name */}
      <text x={layout.w/2} y={layout.nameY} textAnchor="middle" fontFamily={fonts.name} fontWeight={800} fontSize="64" fill={theme.nameText}>
        {s.name || ""}
      </text>

      {/* Stats */}
      <g>
        <StatRow label="PAC" value={s.pac ?? 0} x={layout.statLx} y={layout.statsY} />
        <StatRow label="SHO" value={s.sho ?? 0} x={layout.statLx} y={layout.statsY + layout.rowGap} />
        <StatRow label="PAS" value={s.pas ?? 0} x={layout.statLx} y={layout.statsY + layout.rowGap*2} />

        <StatRow label="DRI" value={s.dri ?? 0} x={layout.statRx} y={layout.statsY} />
        <StatRow label="DEF" value={s.def ?? 0} x={layout.statRx} y={layout.statsY + layout.rowGap} />
        <StatRow label="PHY" value={s.phy ?? 0} x={layout.statRx} y={layout.statsY + layout.rowGap*2} />
      </g>
    </svg>
  );
});

export default FifaCard;
