import { supabase } from "./supabase";

/**
 * 선수 사진 — Supabase 파일 저장소(버킷: player-photos)
 * 서버 설정: supabase/player_photos_storage.sql
 *
 * - 기록 데이터에는 사진 "주소(URL)"만 저장 → 저장할 때 보내는 양이 크게 줄어듦
 * - 올리기/지우기는 현재 관리자만 가능 (서버가 발급한 1회용 허가 필요)
 * - 파일 이름은 매번 새로 만들어지므로, 한 번 올린 사진 주소는 내용이 바뀌지 않음
 *   (→ 브라우저/앱이 오래 캐시해도 안전)
 */

export const PHOTO_BUCKET = "player-photos";
const PENDING_KEY = "goldin_photo_cleanup";
const MAX_SIDE = 300; // 기존과 동일: 긴 변 최대 300px

/** 저장소 사진 주소에서 파일 이름(p/xxx.webp) 추출. 저장소 사진이 아니면 null */
export function photoNameFromUrl(url: string | null | undefined): string | null {
  if (!url || typeof url !== "string") return null;
  const marker = `/storage/v1/object/public/${PHOTO_BUCKET}/`;
  const i = url.indexOf(marker);
  if (i < 0) return null;
  const name = decodeURIComponent(url.slice(i + marker.length).split("?")[0]);
  return /^p\/[A-Za-z0-9_-]+\.(png|jpg|jpeg|webp)$/.test(name) ? name : null;
}

/** 기존과 같은 방식으로 줄이기: 긴 변 300px, 투명 배경 유지 (가능하면 WebP, 안 되면 PNG) */
async function resizeForUpload(file: File): Promise<{ blob: Blob; ext: "webp" | "png"; type: string }> {
  const objUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new window.Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("이미지를 읽을 수 없습니다"));
      el.src = objUrl;
    });
    const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    canvas.getContext("2d")!.drawImage(img, 0, 0, w, h);

    const toBlob = (type: string, q?: number) =>
      new Promise<Blob | null>(res => canvas.toBlob(b => res(b), type, q));

    // WebP: 투명 배경 유지 + PNG 보다 훨씬 작음. 지원 안 하는 브라우저(일부 iPhone)는 PNG
    const webp = await toBlob("image/webp", 0.92);
    if (webp && webp.type === "image/webp") return { blob: webp, ext: "webp", type: "image/webp" };
    const png = await toBlob("image/png");
    if (!png) throw new Error("이미지 변환에 실패했습니다");
    return { blob: png, ext: "png", type: "image/png" };
  } finally {
    URL.revokeObjectURL(objUrl);
  }
}

function explain(err: any): string {
  const msg = String(err?.message ?? err ?? "");
  if (/not_lock_holder/.test(msg)) return "관리자 권한이 없거나 만료되었습니다. 다시 잠금 해제해 주세요.";
  if (/could not find the function|PGRST202/i.test(msg))
    return "서버 설정이 필요합니다 (supabase/player_photos_storage.sql 실행)";
  if (/bucket not found/i.test(msg)) return "사진 저장소가 없습니다 (supabase/player_photos_storage.sql 실행)";
  if (/row-level security|unauthorized|403/i.test(msg)) return "사진 올리기 권한이 없습니다. 다시 시도해 주세요.";
  if (/payload too large|413|exceeded the maximum/i.test(msg)) return "사진 파일이 너무 큽니다.";
  return msg || "알 수 없는 오류";
}

/** 사진 올리기 → 공개 주소 반환 */
export async function uploadPlayerPhoto(token: string, playerId: string, file: File): Promise<string> {
  const { blob, ext, type } = await resizeForUpload(file);
  const { data, error } = await supabase.rpc("photo_upload_ticket", {
    p_token: token, p_player_id: playerId, p_ext: ext,
  });
  if (error) throw new Error(explain(error));
  const name = String((data as any)?.name || "");
  if (!name) throw new Error("업로드 허가를 받지 못했습니다");

  const { error: upErr } = await supabase.storage.from(PHOTO_BUCKET).upload(name, blob, {
    contentType: type,
    cacheControl: "31536000", // 1년 — 파일 이름이 매번 달라서 안전
    upsert: false,
  });
  if (upErr) throw new Error(explain(upErr));
  return supabase.storage.from(PHOTO_BUCKET).getPublicUrl(name).data.publicUrl;
}

/* ---------- 더 이상 쓰지 않는 사진 정리 ---------- */

function readPending(): string[] {
  try { const v = JSON.parse(localStorage.getItem(PENDING_KEY) || "[]"); return Array.isArray(v) ? v : []; }
  catch { return []; }
}
function writePending(v: string[]) {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(Array.from(new Set(v)).slice(-100))); } catch {}
}

/** 바뀌거나 지워진 사진을 "정리 대상"으로 표시 (기록이 서버에 저장된 뒤에 지움) */
export function markPhotoForCleanup(url: string | null | undefined) {
  const name = photoNameFromUrl(url);
  if (name) writePending([...readPending(), name]);
}

/**
 * 기록 저장 성공 직후 호출. 방금 저장한 데이터에 없는 사진만 저장소에서 지움.
 * (서버도 한 번 더 확인해서, 기록에서 쓰는 사진은 절대 지우지 않음)
 */
export async function cleanupUnusedPhotos(token: string | null, savedPayload: unknown) {
  if (!token) return;
  const pending = readPending();
  if (!pending.length) return;
  const text = JSON.stringify(savedPayload ?? "");
  const unused = pending.filter(n => !text.includes(n));
  const stillUsed = pending.filter(n => text.includes(n));
  if (!unused.length) { writePending(stillUsed); return; }
  try {
    const { data, error } = await supabase.rpc("photo_delete_tickets", { p_token: token, p_names: unused });
    if (error) return; // 다음 저장 때 다시 시도
    const ok: string[] = Array.isArray(data) ? data : [];
    if (ok.length) await supabase.storage.from(PHOTO_BUCKET).remove(ok);
    writePending(stillUsed);
  } catch { /* 다음 저장 때 다시 시도 */ }
}
