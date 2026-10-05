#!/usr/bin/env bash
# デプロイ済みサービスの疎通確認。
#   ./scripts/smoke.sh https://tex2img-xxxx.onrender.com
# 機能の確認は POST で行い（経路に依存しない）、QUERY が手前のプロキシを通るかは別に判定する。
set -uo pipefail

BASE="${1:?usage: $0 BASE_URL}"
BASE="${BASE%/}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0

pass() { printf '  \e[32mPASS\e[0m %s\n' "$1"; }
ng() { printf '  \e[31mFAIL\e[0m %s\n' "$1"; fail=1; }
check() { # name expected actual
  if [[ "$2" == "$3" ]]; then pass "$1"; else ng "$1 (expected $2, got $3)"; fi
}

# req METHOD PATH [BODY] -> "status content-type" を出力し、本文とヘッダを $TMP に保存
req() {
  local args=(-s -o "$TMP/body" -D "$TMP/headers" -w '%{http_code} %{content_type}' -X "$1" --max-time 120)
  [[ $# -ge 3 ]] && args+=(-H 'Content-Type: text/plain; charset=utf-8' --data-binary "$3")
  curl "${args[@]}" "$BASE$2"
}
header() { grep -i "^$1:" "$TMP/headers" | head -1 | cut -d' ' -f2- | tr -d '\r'; }

echo "== $BASE (Free プランはスリープ復帰に 1 分ほどかかることがある)"
echo "-- 基本"
check 'GET /healthz' 200 "$(req GET /healthz | cut -d' ' -f1)"
check 'GET / (Web UI)' '200 text/html; charset=utf-8' "$(req GET /)"

echo "-- 変換（POST / GET）"
check 'POST /render → SVG' '200 image/svg+xml; charset=utf-8' "$(req POST /render '\[ e^{i\pi}+1=0 \]')"
loc="$(header content-location)"
if [[ $loc == /render/* ]]; then
  pass 'Content-Location (embed URL) returned'
  check 'GET Content-Location → SVG' '200 image/svg+xml; charset=utf-8' "$(req GET "$loc")"
else
  ng "Content-Location (embed URL) returned (got '$loc')"
fi
check 'POST ?format=png&scale=2' '200 image/png' "$(req POST '/render?format=png&scale=2' '$x^2$')"
check 'POST ?format=webp&transparent=false' '200 image/webp' "$(req POST '/render?format=webp&transparent=false' '$x^2$')"
check 'GET /render?tex=' '200 image/svg+xml; charset=utf-8' "$(req GET '/render?tex=%24%5Cfrac%7B1%7D%7B2%7D%24')"

echo "-- 日本語"
req POST /render '日本語 $v=\text{速さ}$ $\alpha + 日本$' > /dev/null
check 'Japanese uses upLaTeX' uplatex "$(header x-tex-engine)"
uses=$(grep -o '<use ' "$TMP/body" | wc -l | tr -d ' ')
check 'Japanese glyphs are drawn (>= 10 glyphs)' yes "$([[ $uses -ge 10 ]] && echo yes || echo "no ($uses)")"

echo "-- エラー処理"
check 'TeX error → 422 JSON' '422 application/json; charset=utf-8' "$(req POST /render '$\nosuchmacro$')"
check 'TeX error from <img> → 422 SVG' '422 image/svg+xml; charset=utf-8' \
  "$(curl -s -o /dev/null -w '%{http_code} %{content_type}' -H 'Accept: image/webp,image/*,*/*;q=0.8' \
     --max-time 60 "$BASE/render?tex=%5Coops")"
check 'CORS preflight' 204 "$(curl -s -o /dev/null -w '%{http_code}' -X OPTIONS --max-time 60 \
  -H 'Origin: https://example.com' -H 'Access-Control-Request-Method: QUERY' "$BASE/render")"

echo "-- QUERY メソッド"
r="$(req QUERY /render '$x$')"
if [[ "$r" == '200 image/svg+xml; charset=utf-8' ]]; then
  pass 'QUERY /render reaches the app'
else
  ng "QUERY /render reaches the app (got: $r)"
  # このアプリ自身のエラーは必ず JSON で返す。JSON 以外なら手前のプロキシが拒否している
  if [[ "$r" != *application/json* ]]; then
    echo "       → 応答が JSON ではないため、アプリに届く前に手前のプロキシが拒否しています。"
  fi
  echo "       応答ヘッダ:"
  sed 's/^/         /' "$TMP/headers" | tr -d '\r'
fi

exit $fail
