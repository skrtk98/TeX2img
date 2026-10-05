# TeX2img

TeX ソースを **SVG / PNG / WEBP** 画像に変換する Web アプリと REST API。

- TeX ソースはリクエストボディで送る（HTTP **`QUERY`** メソッド。互換用に `POST` も可）
- 出力フォーマット・背景透過・スケールは URL パラメータで指定
- **埋め込み用の `GET` URL** も発行（`<img src>` や Markdown に直接書ける。サーバー側に保存しないステートレス方式）
- **日本語対応**（和文を含む入力は自動で upLaTeX + 原ノ味フォント）
- Web UI（`/`）のテキストエリアから変換・プレビュー・ダウンロード・コピー・埋め込みコード取得
- [Render](https://render.com) に Docker でデプロイ（`render.yaml` 同梱）

## 変換パイプライン

```
TeX ──latex / uplatex──▶ DVI ──dvisvgm --no-fonts──▶ SVG ──sharp (librsvg)──▶ PNG / WEBP
```

- SVG は文字をパスに変換するため、閲覧環境のフォントに依存しない
- PNG / WEBP は `scale=1` のとき、SVG をブラウザで等倍表示したときと同じピクセル数（CSS の 1pt = 4/3px）
- WEBP は可逆圧縮（数式・図は非可逆だと文字の縁が汚れるため）
- エンジンは入力から自動選択: 平仮名・片仮名・漢字・全角記号を含む、または `jsarticle` / `ujarticle` / `bxjs*` クラスや
  `uplatex` オプションを指定した場合は **upLaTeX**、それ以外は **latex**。使ったエンジンは `X-TeX-Engine` ヘッダで返す

## REST API

### パラメータ（全メソッド共通）

| パラメータ | 値 | 既定値 |
|---|---|---|
| `format` | `svg` / `png` / `webp` | `svg` |
| `transparent` | `true` / `false`（`1`/`0`, `yes`/`no`, 値なし = `true`） | `true` |
| `scale` | `0.1` – `10` の数値 | `1` |

### `QUERY /render`（または `POST /render`）— API の本命

リクエストボディ: TeX ソース（UTF-8 テキスト、最大 64KB）。`Content-Type` は問わないが `text/plain; charset=utf-8` 推奨。

```sh
# SVG（既定）
curl -X QUERY 'https://<your-app>.onrender.com/render' \
  --data-binary '\[ e^{i\pi} + 1 = 0 \]' -o euler.svg

# 白背景・3 倍の PNG（ファイルから）
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
const embedUrl = new URL(res.headers.get('Content-Location'), res.url); // 埋め込み用 URL
```

成功レスポンスの **`Content-Location`** ヘッダに、同じ画像を `GET` で取得できる URL（下記の `/render/{encoded}`）が入る。
これは QUERY 仕様（[draft-ietf-httpbis-safe-method-w-body](https://datatracker.ietf.org/doc/draft-ietf-httpbis-safe-method-w-body/)）が想定している使い方で、
「長いソースは QUERY で送り、結果を参照するときは GET」という分担になる。URL が 8KB を超える場合はヘッダを付けない。

### `GET /render/{encoded}` — 埋め込み用

`{encoded}` は TeX ソース（UTF-8）を **raw DEFLATE（RFC 1951）で圧縮して base64url（パディングなし）** にしたもの。
ソースは URL に含まれているので、サーバーは何も保存しない（スリープや再デプロイで URL が壊れない）。

```markdown
![Euler](https://<your-app>.onrender.com/render/i4lWSI2rzowpyKxV0FYwVLBVMFCIiQUA?format=png&scale=2)
```

自前で URL を組み立てる場合:

```js
// ブラウザ / Node.js 18+
async function embedUrl(tex, params = '') {
  const stream = new Blob([tex]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  const b64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `https://<your-app>.onrender.com/render/${b64}${params ? '?' + params : ''}`;
}
```

```python
import base64, zlib
def embed_url(tex: str, params: str = "") -> str:
    c = zlib.compressobj(9, zlib.DEFLATED, -15)  # -15 = raw DEFLATE
    data = c.compress(tex.encode()) + c.flush()
    token = base64.urlsafe_b64encode(data).rstrip(b"=").decode()
    return f"https://<your-app>.onrender.com/render/{token}" + (f"?{params}" if params else "")
```

### `GET /render?tex=...` — 手書き用

短い数式を URL に直接書きたいとき用。`tex` はパーセントエンコードする。

```html
<img src="https://<your-app>.onrender.com/render?tex=%24E%3Dmc%5E2%24&format=png&scale=2" alt="E=mc^2">
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
  和文を含んでいればそのまま upLaTeX で組まれる（`$v = \text{速さ}$` なども可）。
- **`\documentclass` を含む場合**: そのまま完全な文書としてコンパイルする。独自パッケージを使いたいときはこちら。
  `article` 等だとページ番号まで含んだ範囲が切り出されるので、`standalone` クラスか `\pagestyle{empty}` を推奨。
  和文クラスは `\documentclass[uplatex]{jsarticle}` や `\documentclass{ujarticle}` を使う（DVI 経由なので LuaLaTeX 用の `ltjsarticle` は不可）。
- どちらの場合も 1 ページ目のみを画像化し、内容の外接矩形 + 1pt（×scale）の余白で切り出す。

### レスポンス

| ステータス | 意味 |
|---|---|
| `200` | 画像。`Content-Type` は `image/svg+xml` / `image/png` / `image/webp` |
| `304` | `If-None-Match` が `ETag` と一致 |
| `400` | パラメータ不正、ソースが空・未指定、`{encoded}` の形式不正 |
| `405` | 許可されていないメソッド（`Allow` ヘッダ付き） |
| `413` | ソースが大きすぎる / 出力画像が大きすぎる（8000px 超、または 2500 万画素超） |
| `422` | LaTeX のコンパイルエラー、タイムアウト |
| `503` | 混雑（同時実行数 + 待ち行列の上限超過） |

エラーは JSON: `{"error": "Undefined control sequence.\n$\\foo", "line": 2, "log": "…"}`
`line` はユーザー入力基準の行番号（スニペットを包んだ分のずれは補正済み）。

ただし `GET` で `Accept` が画像を求めている場合（`<img>` からの読み込み等）は、エラー内容を描いた **SVG 画像**を同じステータスコードで返す。
埋め込み先で壊れた画像アイコンではなく原因が見える。

レスポンスヘッダ:

- `Content-Location`: 同じ画像の埋め込み用 GET URL（上記）
- `ETag`: 入力 + パラメータの SHA-256。同一入力なら同一画像（QUERY と GET で共通）
- `X-Cache`: `HIT` / `MISS`（サーバー内 LRU キャッシュ）
- `X-TeX-Engine`: `latex` / `uplatex`
- `Cache-Control: public, max-age=604800, immutable`
- CORS: `Access-Control-Allow-Origin: *`（`CORS_ORIGIN` で変更可）。ブラウザから別オリジンで `QUERY` を送るとプリフライト（`OPTIONS`）が飛ぶが、対応済み

### その他のエンドポイント

- `GET /` — Web UI
- `GET /healthz` — ヘルスチェック（`{"ok":true}`）

## ローカル実行

Node.js 22 以上と TeX Live、dvisvgm が必要。

```sh
# Debian / Ubuntu
sudo apt-get install --no-install-recommends texlive-latex-base texlive-latex-recommended \
  texlive-latex-extra texlive-fonts-recommended texlive-pictures texlive-lang-japanese \
  dvisvgm ghostscript
sudo kanji-config-updmap-sys --jis2004 haranoaji   # 和文フォントを原ノ味に（必須）
npm install
npm start          # http://localhost:10000
npm test           # latex / uplatex が無い環境では該当する結合テストは skip される
```

Docker:

```sh
docker build -t tex2img .
docker run --rm -p 10000:10000 tex2img
```

## Render へのデプロイ

1. このリポジトリを GitHub に push
2. Render ダッシュボード → **New → Blueprint** → リポジトリを選択（`render.yaml` が読まれる）
3. デプロイ完了後、疎通確認:
   ```sh
   ./scripts/smoke.sh https://<service-name>.onrender.com
   ```
   QUERY が手前のプロキシを通るか、日本語のグリフが実際に描画されるかまで確認する。

`render.yaml` は Docker ランタイム・Free プラン・`/healthz` ヘルスチェックで定義している。
Docker ビルド時に和文フォントの自己診断を行い、和文が描画されない状態ならビルドを失敗させる。

## 環境変数

| 変数 | 既定値 | 説明 |
|---|---|---|
| `PORT` | `10000` | 待ち受けポート（Render が自動設定） |
| `MAX_CONCURRENCY` | `2` | 同時コンパイル数 |
| `MAX_QUEUE` | `16` | 待ち行列の上限。超えると 503 |
| `MAX_BODY_BYTES` | `65536` | TeX ソースの上限（ボディ・展開後の `{encoded}`・`?tex=` 共通） |
| `MAX_HEADER_BYTES` | `65536` | リクエストライン + ヘッダの上限（長い GET URL 用） |
| `MAX_EMBED_URL_BYTES` | `8192` | これを超える埋め込み URL は `Content-Location` に載せない |
| `TEX_TIMEOUT_MS` | `15000` | latex / uplatex の実行時間上限 |
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
- `{encoded}` の展開後サイズを制限（zip bomb 対策）
- Docker では非 root ユーザー（`node`）で実行
- SVG には `\special{dvisvgm:raw …}` で任意の要素（`<script>` 等）を埋め込める。GET URL を作れば誰でも
  「このサイトのオリジンで開かれる SVG」を配布できるので、画像レスポンスには
  `Content-Security-Policy: default-src 'none'; …; sandbox` を付与してスクリプトを無効化している。
  **API 利用側で SVG を `innerHTML` 等でインライン展開する場合は自前でサニタイズすること**（`<img src>` で表示するならスクリプトは動かない）

## 既知の制約

- **`QUERY` メソッドは IETF のドラフト段階**。Node.js 22 / curl / ブラウザの `fetch` は扱えるが、
  途中のプロキシ・CDN・WAF・HTTP クライアントライブラリが未知メソッドとして拒否する可能性がある。そのため `POST` を同じ挙動で受け付けている。
- **GET URL の長さ**: サーバーは 64KB まで受け付けるが、実際の上限は経路で決まる（多くの CDN・プロキシは 8〜16KB 程度、
  GitHub の画像プロキシ等はさらに短いことがある）。埋め込みは数式 1 つ〜数個程度の規模を想定。長い文書は QUERY を使う
- **GET 埋め込みは誰でも計算資源を消費させられる**（人気ページに重い URL を貼る等）。結果はキャッシュされるが、
  サーバー内メモリのみで、CDN キャッシュは無い。公開運用するなら CDN（Cloudflare 等）を前段に置くこと
- 和文フォントは原ノ味（Adobe-Japan1）のみ。ハングルや簡体字固有の字形は出ない
- キャッシュはプロセス内メモリのみ。Render Free はアイドル 15 分でスリープし、復帰時（コールドスタート、数十秒）に消える
