import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { parseOptions, canonicalQuery, OptionError } from '../src/options.js';
import { buildDocument, parseTexError, addSvgBackground, svgSize, selectEngine } from '../src/render.js';
import { encodeSource, decodeSource, DecodeError } from '../src/codec.js';
import { LruCache, errorSvg } from '../src/server.js';

const p = (qs) => parseOptions(new URLSearchParams(qs));

test('defaults: svg, transparent, scale 1', () => {
  assert.deepEqual(p(''), { format: 'svg', transparent: true, scale: 1 });
});

test('parses format / transparent / scale', () => {
  assert.deepEqual(p('format=PNG&transparent=false&scale=2.5'), { format: 'png', transparent: false, scale: 2.5 });
  assert.equal(p('transparent').transparent, true);
  assert.equal(p('transparent=0').transparent, false);
});

test('rejects invalid values', () => {
  for (const qs of ['format=gif', 'transparent=maybe', 'scale=0', 'scale=11', 'scale=abc', 'scale=']) {
    assert.throws(() => p(qs), OptionError, qs);
  }
});

test('snippet is wrapped in standalone, full document is kept', () => {
  const snip = buildDocument('$x$');
  assert.match(snip.source, /\\documentclass\[varwidth=\\maxdimen\]\{standalone\}/);
  assert.doesNotMatch(snip.source, /tikz\}/);
  assert.equal(snip.source.split('\n')[snip.lineOffset], '$x$');

  assert.match(buildDocument('\\tikz \\draw (0,0) -- (1,1);').source, /\\usepackage\{tikz\}/);
  assert.match(buildDocument('$速さ$').source, /class=ujarticle\]\{standalone\}/);

  const full = buildDocument('\\documentclass{article}\n\\begin{document}x\\end{document}');
  assert.doesNotMatch(full.source, /standalone/);
  assert.equal(full.source.split('\n')[full.lineOffset], '\\documentclass{article}');
});

test('maps TeX error line numbers back to user input', () => {
  const log = 'foo\n./main.tex:9: Undefined control sequence.\n<recently read> \\foo\nl.9 $\\foo\n';
  assert.deepEqual(parseTexError(log, 8), { message: 'Undefined control sequence.\n$\\foo', line: 1 });
  assert.equal(parseTexError('./main.tex:3: Oops', 8).line, null);
  assert.equal(parseTexError('! Emergency stop.\n', 0).message, 'Emergency stop.');
});

test('svg helpers', () => {
  const svg = "<?xml version='1.0'?><svg width='10.5pt' height='4pt' viewBox='-1 -2 10.5 4'><path/></svg>";
  assert.deepEqual(svgSize(svg), { width: 10.5, height: 4 });
  assert.match(addSvgBackground(svg), /<svg[^>]*><rect x='-1' y='-2' width='10.5' height='4' fill='#ffffff'\/><path/);
});

test('LRU cache evicts by count and bytes', () => {
  const c = new LruCache(2, 10);
  c.set('a', 'A', 4);
  c.set('b', 'B', 4);
  assert.equal(c.get('a'), 'A'); // a を最新に
  c.set('c', 'C', 4); // 件数超過 → b が落ちる
  assert.deepEqual([...c.map.keys()], ['a', 'c']);
  c.set('d', 'D', 9); // 容量超過 → a, c が落ちる
  assert.deepEqual([...c.map.keys()], ['d']);
  c.set('huge', 'H', 11); // 単体で上限超え → 入れない
  assert.equal(c.get('huge'), undefined);
});

test('canonicalQuery keeps only non-default options', () => {
  assert.equal(canonicalQuery(p('')), '');
  assert.equal(canonicalQuery(p('format=PNG&transparent=0&scale=2.50')), 'format=png&transparent=false&scale=2.5');
  assert.equal(canonicalQuery(p('format=svg&transparent=yes&scale=1')), '');
});

test('codec round-trips UTF-8 and is URL-safe', () => {
  const tex = '速度 $v = \\frac{d}{t}$ + ü\n'.repeat(20);
  const token = encodeSource(tex);
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  assert.ok(token.length < Buffer.byteLength(tex), 'compressed');
  assert.equal(decodeSource(token, 1e6), tex);
});

test('codec rejects garbage, oversize output (zip bomb) and invalid UTF-8', () => {
  assert.throws(() => decodeSource('not+base64/url=', 1e6), DecodeError);
  assert.throws(() => decodeSource('AAAA', 1e6), DecodeError);
  const bomb = deflateRawSync(Buffer.alloc(1e6, 'a')).toString('base64url');
  assert.throws(() => decodeSource(bomb, 64 * 1024), (e) => e instanceof DecodeError && e.status === 413);
  const badUtf8 = deflateRawSync(Buffer.from([0xff, 0xfe, 0x41])).toString('base64url');
  assert.throws(() => decodeSource(badUtf8, 1e6), DecodeError);
});

test('selectEngine picks upLaTeX for Japanese', () => {
  assert.equal(selectEngine('$x^2$'), 'latex');
  assert.equal(selectEngine('café $\\alpha$'), 'latex');
  assert.equal(selectEngine('$v = \\text{速度}$'), 'uplatex');
  assert.equal(selectEngine('ひらがな'), 'uplatex');
  assert.equal(selectEngine('カタカナ'), 'uplatex');
  assert.equal(selectEngine('\\documentclass{ujarticle}\\begin{document}x\\end{document}'), 'uplatex');
  assert.equal(selectEngine('\\documentclass[uplatex]{jsarticle}'), 'uplatex');
  assert.equal(selectEngine('\\documentclass{article}'), 'latex');
});

test('errorSvg escapes markup', () => {
  const svg = errorSvg(422, 'bad <script>alert(1)</script> & "x"', 3);
  assert.doesNotMatch(svg, /<script/);
  assert.match(svg, /&lt;script&gt;/);
  assert.match(svg, /line 3/);
});
