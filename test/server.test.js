// latex / dvisvgm が入っている環境（Docker イメージ等）でのみ実行される結合テスト
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from '../src/server.js';
import { encodeSource } from '../src/codec.js';

const hasTex = ['latex', 'dvisvgm'].every((c) => spawnSync(c, ['--version']).status === 0);
const opts = { skip: !hasTex && 'latex/dvisvgm not installed' };
const hasJa = hasTex && spawnSync('kpsewhich', ['kanjix.map']).status === 0 && spawnSync('uplatex', ['--version']).status === 0;
const jaOpts = { skip: !hasJa && 'uplatex / kanjix.map not installed' };

let server;
let base;
before(async () => {
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const send = (qs, body, method = 'QUERY') => fetch(`${base}/render${qs}`, { method, body });

test('GET / serves the web UI', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(await res.text(), /<textarea/);
});

test('GET /render without source is 400, other methods 405', async () => {
  const res = await fetch(base + '/render');
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Missing TeX source/);

  const put = await fetch(base + '/render', { method: 'PUT', body: 'x' });
  assert.equal(put.status, 405);
  assert.match(put.headers.get('allow'), /QUERY/);
  const post = await fetch(base + '/render/abc', { method: 'POST', body: 'x' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD, OPTIONS');
});

test('body methods reject ?tex= to avoid ambiguity', async () => {
  assert.equal((await send('?tex=x', 'y')).status, 400);
});

test('malformed encoded source is 400', async () => {
  assert.equal((await fetch(base + '/render/@@@')).status, 400);
  assert.equal((await fetch(base + '/render/AAAA')).status, 400);
});

test('CORS preflight allows QUERY', async () => {
  const res = await fetch(base + '/render', { method: 'OPTIONS' });
  assert.equal(res.status, 204);
  assert.match(res.headers.get('access-control-allow-methods'), /QUERY/);
  assert.equal(res.headers.get('accept-query'), 'text/plain');
});

test('empty body and invalid params are 400', async () => {
  assert.equal((await send('', '   ')).status, 400);
  assert.equal((await send('?format=gif', '$x$')).status, 400);
});

test('QUERY renders SVG by default', opts, async () => {
  const res = await send('', '$E=mc^2$');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^image\/svg\+xml/);
  assert.match(res.headers.get('content-security-policy'), /sandbox/);
  const svg = await res.text();
  assert.match(svg, /<svg/);
  assert.doesNotMatch(svg, /<rect/); // 透過（既定）なので背景矩形なし
});

test('transparent=false adds a background to SVG', opts, async () => {
  const svg = await (await send('?transparent=false', '$x$')).text();
  assert.match(svg, /<rect [^>]*fill='#ffffff'/);
});

test('PNG / WEBP with scale and transparency', opts, async () => {
  const png1 = Buffer.from(await (await send('?format=png', '$x+y$')).arrayBuffer());
  const png3 = Buffer.from(await (await send('?format=png&scale=3', '$x+y$')).arrayBuffer());
  assert.equal(png1.subarray(1, 4).toString(), 'PNG');
  const width = (b) => b.readUInt32BE(16);
  assert.ok(Math.abs(width(png3) / width(png1) - 3) < 0.2, `${width(png1)} -> ${width(png3)}`);
  // PNG の color type: 6 = RGBA, 2 = RGB
  assert.equal(png1[25], 6);
  const opaque = Buffer.from(await (await send('?format=png&transparent=false', '$x+y$')).arrayBuffer());
  assert.equal(opaque[25], 2);

  const res = await send('?format=webp', '$x$', 'POST');
  assert.equal(res.headers.get('content-type'), 'image/webp');
  const webp = Buffer.from(await res.arrayBuffer());
  assert.equal(webp.subarray(8, 12).toString(), 'WEBP');
});

test('caching: second request hits, If-None-Match gives 304', opts, async () => {
  const body = '$a^2+b^2=c^2$';
  const first = await send('', body);
  await first.arrayBuffer();
  const second = await send('', body);
  await second.arrayBuffer();
  assert.equal(second.headers.get('x-cache'), 'HIT');
  const etag = second.headers.get('etag');
  const res = await fetch(`${base}/render`, { method: 'QUERY', body, headers: { 'If-None-Match': etag } });
  assert.equal(res.status, 304);
});

test('TeX errors are 422 with user-relative line number', opts, async () => {
  const res = await send('', 'ok\n$\\undefinedmacro$');
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.match(body.error, /Undefined control sequence/);
  assert.equal(body.line, 2);
  assert.ok(body.log);
});

test('sandbox: no shell escape, no reading files outside the work dir', opts, async () => {
  const res = await send('?format=png', '\\immediate\\write18{echo pwned}\\input{/etc/hostname}');
  assert.equal(res.status, 422);
  const read = await send(
    '',
    '\\newread\\r\\openin\\r=/etc/passwd \\ifeof\\r BLOCKED\\else\\read\\r to\\x LEAKED\\fi',
  );
  assert.equal(read.status, 200);
  // dvisvgm --no-fonts はグリフをパス化するので文字列は残らない。
  // ファイルが読めた場合は LEAKED の 6 グリフ、読めなければ BLOCKED の 7 グリフになる
  const svg = await read.text();
  assert.equal((svg.match(/<use /g) ?? []).length, 7);
});

test('oversized raster output is rejected', opts, async () => {
  const res = await send('?format=png&scale=10', '\\rule{50cm}{50cm}');
  assert.equal(res.status, 413);
});

test('GET ?tex= renders the same image as QUERY', opts, async () => {
  const tex = '$\\sqrt{2}$';
  const q = Buffer.from(await (await send('?format=png', tex)).arrayBuffer());
  const res = await fetch(`${base}/render?format=png&tex=${encodeURIComponent(tex)}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(q));
});

test('QUERY returns Content-Location that GET resolves to the same image', opts, async () => {
  const tex = '\\[ \\sum_{k=1}^n k = \\frac{n(n+1)}{2} \\]';
  const res = await send('?format=webp&scale=2&transparent=false', tex);
  const body = Buffer.from(await res.arrayBuffer());
  const loc = res.headers.get('content-location');
  assert.equal(loc, `/render/${encodeSource(tex)}?format=webp&transparent=false&scale=2`);

  const get = await fetch(base + loc);
  assert.equal(get.status, 200);
  assert.equal(get.headers.get('etag'), res.headers.get('etag'));
  assert.equal(get.headers.get('content-location'), loc);
  assert.ok(Buffer.from(await get.arrayBuffer()).equals(body));

  const head = await fetch(base + loc, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-type'), 'image/webp');
  assert.equal((await head.arrayBuffer()).byteLength, 0);
});

test('no Content-Location when the embed URL would be too long', opts, async () => {
  // 圧縮が効かないランダムなコメント行で 8KB 超にする
  const noise = Array.from({ length: 1000 }, () => '%' + randomBytes(16).toString('hex')).join('\n');
  const res = await send('', `${noise}\n$x$`);
  await res.arrayBuffer();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-location'), null);
});

test('<img>-style GET gets an SVG error image, API clients get JSON', opts, async () => {
  const url = `${base}/render?format=png&tex=${encodeURIComponent('$\\nosuchmacro$')}`;
  const img = await fetch(url, { headers: { Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' } });
  assert.equal(img.status, 422);
  assert.match(img.headers.get('content-type'), /^image\/svg\+xml/);
  assert.match(await img.text(), /Undefined control sequence/);

  const api = await fetch(url);
  assert.equal(api.status, 422);
  assert.match(api.headers.get('content-type'), /json/);
});

test('raster size at scale=1 matches the SVG size in CSS pixels', opts, async () => {
  const tex = '$\\displaystyle\\int_0^1 x\\,dx$';
  const svg = await (await send('', tex)).text();
  const widthPt = Number(svg.match(/<svg[^>]*\swidth='([\d.]+)pt'/)[1]);
  const png = Buffer.from(await (await send('?format=png', tex)).arrayBuffer());
  const expected = (widthPt * 4) / 3;
  assert.ok(Math.abs(png.readUInt32BE(16) - expected) <= 2, `png ${png.readUInt32BE(16)}px vs svg ${expected}px`);
});

test('Japanese is rendered with upLaTeX and real glyphs', jaOpts, async () => {
  const res = await send('', '日本語 $v=\\text{速さ}$');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-tex-engine'), 'uplatex');
  const svg = await res.text();
  // 和文 5 文字 + v + = の 7 グリフ以上（フォントが見つからないと和文は 0 個になる）
  assert.ok((svg.match(/<use /g) ?? []).length >= 7, 'Japanese glyphs present');

  const en = await send('', '$v$');
  await en.arrayBuffer();
  assert.equal(en.headers.get('x-tex-engine'), 'latex');
});

test('Japanese directly in math mode and TikZ nodes', jaOpts, async () => {
  const res = await send('?format=png', '$\\alpha + 日本$ \\[ v = \\frac{距離}{時間} \\] \\tikz \\node {ノード};');
  assert.equal(res.status, 200, await res.clone().text());
});

test('full upLaTeX document with jsarticle', jaOpts, async () => {
  const doc = '\\documentclass[uplatex]{jsarticle}\n\\pagestyle{empty}\n\\begin{document}\nこんにちは、\\LaTeX\n\\end{document}';
  const res = await send('?format=png', doc);
  assert.equal(res.status, 200, await res.clone().text().catch(() => ''));
  assert.equal(res.headers.get('x-tex-engine'), 'uplatex');
});
