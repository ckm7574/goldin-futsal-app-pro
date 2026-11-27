#!/usr/bin/env python3
"""
기록 데이터(futsal_state) 안에 들어 있는 선수 사진(base64)을
Supabase 파일 저장소(player-photos)로 옮기고, 기록에는 사진 주소만 남긴다.

사전 조건: supabase/player_photos_storage.sql 실행 완료
사용법:
  SUPABASE_URL=https://xxx.supabase.co SUPABASE_ANON_KEY=... ADMIN_PIN=... \
    python3 scripts/migrate_photos_to_storage.py [--dry-run]

안전장치
 - 다른 관리자가 사용 중이면 시작하지 않음 (강제로 가져오지 않음)
 - 시작 전 현재 데이터를 .recovery/ 에 백업
 - 사진을 모두 올리고 공개 주소에서 다시 내려받아 원본과 같은지 확인한 뒤에만 기록 저장
 - 사진 외의 내용(경기 기록 등)은 바꾸지 않음
 - 끝나면 관리자 잠금 해제
"""
import base64, json, os, sys, time, urllib.request, urllib.error

URL = os.environ["SUPABASE_URL"].rstrip("/")
KEY = os.environ["SUPABASE_ANON_KEY"]
PIN = os.environ["ADMIN_PIN"]
DRY = "--dry-run" in sys.argv
BUCKET = "player-photos"
HERE = os.path.dirname(os.path.abspath(__file__))
RECOVERY = os.path.join(HERE, "..", ".recovery")

def req(method, path, body=None, headers=None, raw=False, timeout=60):
    h = {"apikey": KEY, "Authorization": f"Bearer {KEY}"}
    data = None
    if body is not None and not raw:
        data = json.dumps(body, ensure_ascii=False).encode()
        h["Content-Type"] = "application/json"
    elif raw:
        data = body
    h.update(headers or {})
    r = urllib.request.Request(URL + path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            out = resp.read()
            return resp.status, out
    except urllib.error.HTTPError as e:
        return e.code, e.read()

def rpc(name, args):
    st, out = req("POST", f"/rest/v1/rpc/{name}", args)
    if st >= 300:
        raise RuntimeError(f"{name} 실패 ({st}): {out[:300].decode(errors='replace')}")
    return json.loads(out) if out else None

def count_matches(p):
    return sum(len(v.get("matches") or []) for v in (p.get("sessionsByDate") or {}).values())

def main():
    lock = rpc("admin_lock_status", {})
    if lock.get("locked"):
        print(f"중단: '{lock.get('holder_label')}' 님이 관리자 모드 사용 중입니다. 잠금이 풀린 뒤 다시 실행하세요.")
        return 2

    st, out = req("GET", "/rest/v1/futsal_state?select=payload&id=eq.1")
    payload = json.loads(out)[0]["payload"]
    targets = [p for p in payload["players"]
               if isinstance(p.get("photo"), str) and p["photo"].startswith("data:image/")]
    print(f"선수 {len(payload['players'])}명 / 옮길 사진 {len(targets)}장 / 경기 {count_matches(payload)}개")
    if not targets:
        print("옮길 사진이 없습니다."); return 0

    os.makedirs(RECOVERY, exist_ok=True)
    bk = os.path.join(RECOVERY, f"futsal_state_before_photo_migration_{time.strftime('%Y%m%d_%H%M%S')}.json")
    with open(bk, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    print(f"백업: {bk}")
    if DRY:
        print("--dry-run: 여기서 멈춥니다."); return 0

    r = rpc("admin_unlock", {"p_pin": PIN, "p_label": "사진 이전(AI)", "p_force": False})
    if r.get("status") != "ok":
        print(f"중단: 잠금 해제 실패 {r}"); return 2
    token = r["token"]
    try:
        url_by_id = {}
        for i, p in enumerate(targets, 1):
            head, b64 = p["photo"].split(",", 1)
            mime = head[5:].split(";")[0]
            ext = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}.get(mime)
            if not ext:
                print(f"  - {p['name']}: 지원하지 않는 형식({mime}) → 건너뜀"); continue
            data = base64.b64decode(b64)
            name = rpc("photo_upload_ticket", {"p_token": token, "p_player_id": p["id"], "p_ext": ext})["name"]
            st, out = req("POST", f"/storage/v1/object/{BUCKET}/{name}", data, raw=True,
                          headers={"Content-Type": mime, "cache-control": "max-age=31536000", "x-upsert": "false"})
            if st >= 300:
                raise RuntimeError(f"{p['name']} 사진 올리기 실패 ({st}): {out[:200].decode(errors='replace')}")
            public = f"{URL}/storage/v1/object/public/{BUCKET}/{name}"
            st, got = req("GET", f"/storage/v1/object/public/{BUCKET}/{name}")
            if st != 200 or got != data:
                raise RuntimeError(f"{p['name']} 사진 확인 실패 (HTTP {st}, {len(got)}B vs {len(data)}B)")
            url_by_id[p["id"]] = (p["photo"], public)
            print(f"  [{i}/{len(targets)}] {p['name']}: {len(data)//1024}KB → {name}")

        # 저장 직전 최신 데이터 다시 읽기 (그사이 바뀐 게 있어도 사진만 교체)
        st, out = req("GET", "/rest/v1/futsal_state?select=payload&id=eq.1")
        latest = json.loads(out)[0]["payload"]
        before_m, before_p = count_matches(latest), len(latest["players"])
        replaced = 0
        for p in latest["players"]:
            pair = url_by_id.get(p.get("id"))
            if pair and p.get("photo") == pair[0]:
                p["photo"] = pair[1]; replaced += 1
        rpc("futsal_save", {"p_token": token, "p_payload": latest})

        st, out = req("GET", "/rest/v1/futsal_state?select=payload&id=eq.1")
        after = json.loads(out)[0]["payload"]
        left = sum(1 for p in after["players"] if str(p.get("photo") or "").startswith("data:"))
        size = len(json.dumps(after, ensure_ascii=False).encode())
        print(f"완료: 사진 {replaced}장 교체 / 남은 base64 {left}장 / "
              f"경기 {before_m}→{count_matches(after)} / 선수 {before_p}→{len(after['players'])} / "
              f"기록 크기 {size/1e6:.2f}MB")
        return 0
    finally:
        try: rpc("admin_release", {"p_token": token})
        except Exception as e: print("잠금 해제 실패:", e)

if __name__ == "__main__":
    sys.exit(main())
