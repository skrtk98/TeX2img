// latex / dvisvgm が入っている環境（Docker イメージ等）でのみ実行される結合テスト
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from '../src/server.js';

const hasTex = ['latex', 'dvisvgm'].every((c) => spawnSync(c, ['--version']).status === 0);
const opts = { skip: !hasTex && 'latex/dvisvgm not installed' };

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

test('GET /render is rejected with Allow header', async () => {
  const res = await fetch(base + '/render');
  assert.equal(res.status, 405);
  assert.match(res.headers.get('allow'), /QUERY/);
});

test('CORS preflight allows QUERY', async () => {
  const res = await fetch(base + '/render', { method: 'OPTIONS' });
  assert.equal(res.status, 204);
  assert.match(res.headers.get('access-control-allow-methods'), /QUERY/);
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
