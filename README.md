# TeX2img

TeX ソースを **SVG / PNG / WEBP** 画像に変換する Web アプリと REST API。

- TeX ソースはリクエストボディで送る（HTTP **`QUERY`** メソッド。互換用に `POST` も可）
- 出力フォーマット・背景透過・スケールは URL パラメータで指定
- Web UI（`/`）のテキストエリアから変換・プレビュー・ダウンロード・クリップボードコピー
- [Render](https://render.com) に Docker でデプロイ（`render.yaml` 同梱）

## 変換パイプライン

```
TeX ──latex──▶ DVI ──dvisvgm --no-fonts──▶ SVG ──sharp (librsvg)──▶ PNG / WEBP
```

- SVG は文字をパスに変換するため、閲覧環境のフォントに依存しない
- PNG / WEBP は SVG をラスタライズする。`scale=1` で SVG を等倍表示したときと同じピクセル数（96dpi 相当）
- WEBP は可逆圧縮（数式・図は非可逆だと文字の縁が汚れるため）

## REST API

### `QUERY /render`（または `POST /render`）

| パラメータ | 値 | 既定値 |
|---|---|---|
| `format` | `svg` / `png` / `webp` | `svg` |
| `transparent` | `true` / `false`（`1`/`0`, `yes`/`no`, 値なし = `true`） | `true` |
| `scale` | `0.1` – `10` の数値 | `1` |

リクエストボディ: TeX ソース（UTF-8 テキスト、最大 64KB）。`Content-Type` は問わないが `text/plain; charset=utf-8` 推奨。

```sh
# SVG（既定）
curl -X QUERY 'https://<your-app>.onrender.com/render' \
  --data-binary '\[ e^{i\pi} + 1 = 0 \]' -o euler.svg

# 白背景・3 倍の PNG
curl -X QUERY 'https://<your-app>.onrender.com/render?format=png&transparent=false&scale=3' \
  --data-binary @formula.tex -o formula.png
```

```js
const res = await fetch('https://<your-app>.onrender.com/render?format=webp&scale=2', {
  method: 'QUERY',
  headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  body: String.raw`\[ \sum_{n=1}^\infty \frac{1}{n^2} = \frac{\pi^2}{6} \]`,
});
const blob = await res.blob();
```

### 入力の解釈

- **`\documentclass` を含まない場合**（スニペット）: 次の文書で包む。数式は `$…$` / `\[…\]` / `align*` 等で書く。
  ```latex
  \documentclass[varwidth=\maxdimen]{standalone}
  \usepackage{amsmath,amssymb,mathtools,bm,xcolor}
  % \tikz / tikzpicture を含むときだけ \usepackage{tikz}
  \begin{document}
  <入力>
  \end{document}
  ```
- **`\documentclass` を含む場合**: そのまま完全な文書としてコンパイルする。独自パッケージを使いたいときはこちら。
  `article` 等だとページ番号まで含んだ範囲が切り出されるので、`standalone` クラスを推奨。
- どちらの場合も 1 ページ目のみを画像化し、内容の外接矩形 + 1pt（×scale）の余白で切り出す。

### レスポンス

| ステータス | 意味 |
|---|---|
| `200` | 画像。`Content-Type` は `image/svg+xml` / `image/png` / `image/webp` |
| `304` | `If-None-Match` が `ETag` と一致 |
| `400` | パラメータ不正、ボディが空 |
| `405` | `QUERY` / `POST` / `OPTIONS` 以外（`Allow` ヘッダ付き） |
| `413` | ボディが大きすぎる / 出力画像が大きすぎる（8000px 超、または 2500 万画素超） |
| `422` | LaTeX のコンパイルエラー、タイムアウト |
| `503` | 混雑（同時実行数 + 待ち行列の上限超過） |

エラーは JSON: `{"error": "Undefined control sequence.\n$\\foo", "line": 2, "log": "…"}`
`line` はユーザー入力基準の行番号（スニペットを包んだ分のずれは補正済み）。

レスポンスヘッダ:

- `ETag`: 入力 + パラメータの SHA-256。同一入力なら同一画像
- `X-Cache`: `HIT` / `MISS`（サーバー内 LRU キャッシュ）
- `Cache-Control: public, max-age=86400, immutable`
- CORS: `Access-Control-Allow-Origin: *`（`CORS_ORIGIN` で変更可）。ブラウザから別オリジンで `QUERY` を送るとプリフライト（`OPTIONS`）が飛ぶが、対応済み

### その他のエンドポイント

- `GET /` — Web UI
- `GET /healthz` — ヘルスチェック（`{"ok":true}`）

## ローカル実行

Node.js 22 以上と TeX Live、dvisvgm が必要。

```sh
# Debian / Ubuntu
sudo apt-get install --no-install-recommends texlive-latex-base texlive-latex-recommended \
  texlive-latex-extra texlive-fonts-recommended texlive-pictures dvisvgm ghostscript
npm install
npm start          # http://localhost:10000
npm test           # latex が無い環境では結合テストは skip される
```

Docker:

```sh
docker build -t tex2img .
docker run --rm -p 10000:10000 tex2img
```

## Render へのデプロイ

1. このリポジトリを GitHub に push
2. Render ダッシュボード → **New → Blueprint** → リポジトリを選択（`render.yaml` が読まれる）
3. デプロイ完了後、`https://<service-name>.onrender.com/` を開く

`render.yaml` は Docker ランタイム・Free プラン・`/healthz` ヘルスチェックで定義している。

## 環境変数

| 変数 | 既定値 | 説明 |
|---|---|---|
| `PORT` | `10000` | 待ち受けポート（Render が自動設定） |
| `MAX_CONCURRENCY` | `2` | 同時コンパイル数 |
| `MAX_QUEUE` | `16` | 待ち行列の上限。超えると 503 |
| `MAX_BODY_BYTES` | `65536` | リクエストボディ上限 |
| `TEX_TIMEOUT_MS` | `15000` | latex の実行時間上限 |
| `DVISVGM_TIMEOUT_MS` | `15000` | dvisvgm の実行時間上限 |
| `MAX_DIMENSION` | `8000` | ラスタ出力の 1 辺の上限 (px) |
| `MAX_PIXELS` | `25000000` | ラスタ出力の総画素数上限 |
| `CACHE_ENTRIES` | `256` | キャッシュ件数上限 |
| `CACHE_BYTES` | `33554432` | キャッシュ容量上限 |
| `CORS_ORIGIN` | `*` | `Access-Control-Allow-Origin` |

## セキュリティ

任意の TeX の実行は任意コードの実行とほぼ同義なので、多層で制限している。

- `-no-shell-escape` + `shell_escape=f`: `\write18` 無効
- `openin_any=p` / `openout_any=p`: 作業ディレクトリ外（絶対パス・`..`・ドットファイル）の読み書き禁止（`/etc/passwd` 等は読めないことをテストで確認）
- リクエスト毎の使い捨て一時ディレクトリ、実行時間上限（`SIGKILL`）、入力サイズ・出力画素数の上限、同時実行数制限
- Docker では非 root ユーザー（`node`）で実行
- SVG には `\special{dvisvgm:raw …}` で任意の要素（`<script>` 等）を埋め込めるため、SVG レスポンスに
  `Content-Security-Policy: default-src 'none'; …; sandbox` を付与。**API 利用側で SVG を `innerHTML` 等でインライン展開する場合は自前でサニタイズすること**（`<img src>` で表示するならスクリプトは動かない）

## 既知の制約

- **`QUERY` メソッドは IETF のドラフト段階**（`draft-ietf-httpbis-safe-method-w-body`）。Node.js 22 / curl / ブラウザの `fetch` は扱えるが、
  途中のプロキシ・CDN・WAF・HTTP クライアントライブラリが未知メソッドとして拒否する可能性がある。そのため `POST` を同じ挙動で受け付けている。
  また HTML の `<form>` や `<img src>` からは使えない
- 日本語は未対応（`texlive-lang-japanese` と `uplatex` が必要。イメージが大きくなる）
- キャッシュはプロセス内メモリのみ。Render Free はアイドル 15 分でスリープし、復帰時（コールドスタート、数十秒）に消える
