#!/usr/bin/env bash
# デプロイ済みサービスの疎通確認。
#   ./scripts/smoke.sh https://tex2img-xxxx.onrender.com
# 特に「手前のプロキシ (Render / Cloudflare) が QUERY メソッドを通すか」を確認する。
set -uo pipefail

BASE="${1:?usage: $0 BASE_URL}"
BASE="${BASE%/}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0

check() { # name expected actual
  if [[ "$2" == "$3" ]]; then
    printf '  \e[32mPASS\e[0m %s\n' "$1"
  else
    printf '  \e[31mFAIL\e[0m %s (expected %s, got %s)\n' "$1" "$2" "$3"
    fail=1
  fi
}

# req METHOD PATH [BODY] -> "status content-type" を出力し、本文とヘッダを $TMP に保存
req() {
  local args=(-s -o "$TMP/body" -D "$TMP/headers" -w '%{http_code} %{content_type}' -X "$1" --max-time 120)
  [[ $# -ge 3 ]] && args+=(-H 'Content-Type: text/plain; charset=utf-8' --data-binary "$3")
  curl "${args[@]}" "$BASE$2"
}
header() { grep -i "^$1:" "$TMP/headers" | head -1 | cut -d' ' -f2- | tr -d '\r'; }

echo "== $BASE (Free プランはスリープ復帰に 1 分ほどかかることがある)"
check 'GET /healthz' 200 "$(req GET /healthz | cut -d' ' -f1)"
check 'GET / (Web UI)' '200 text/html; charset=utf-8' "$(req GET /)"

check 'QUERY /render → SVG' '200 image/svg+xml; charset=utf-8' "$(req QUERY /render '\[ e^{i\pi}+1=0 \]')"
loc="$(header content-location)"
check 'QUERY returns Content-Location' yes "$([[ $loc == /render/* ]] && echo yes || echo "no ($loc)")"
check 'GET Content-Location → SVG' '200 image/svg+xml; charset=utf-8' "$(req GET "$loc")"

check 'POST /render?format=png' '200 image/png' "$(req POST '/render?format=png&scale=2' '$x^2$')"
check 'QUERY /render?format=webp&transparent=false' '200 image/webp' \
  "$(req QUERY '/render?format=webp&transparent=false' '$x^2$')"
check 'GET /render?tex=' '200 image/svg+xml; charset=utf-8' "$(req GET '/render?tex=%24%5Cfrac%7B1%7D%7B2%7D%24')"

req QUERY /render '日本語 $v=\text{速さ}$' > /dev/null
check 'Japanese uses upLaTeX' uplatex "$(header x-tex-engine)"
uses=$(grep -o '<use ' "$TMP/body" | wc -l | tr -d ' ')
check 'Japanese glyphs are drawn (>= 6 glyphs)' yes "$([[ $uses -ge 6 ]] && echo yes || echo "no ($uses)")"

check 'TeX error → 422 JSON' '422 application/json; charset=utf-8' "$(req QUERY /render '$\nosuchmacro$')"
check 'CORS preflight' 204 "$(curl -s -o /dev/null -w '%{http_code}' -X OPTIONS --max-time 60 \
  -H 'Origin: https://example.com' -H 'Access-Control-Request-Method: QUERY' "$BASE/render")"

exit $fail
