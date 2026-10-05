import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOptions, OptionError } from '../src/options.js';
import { buildDocument, parseTexError, addSvgBackground, svgSize } from '../src/render.js';
import { LruCache } from '../src/server.js';

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
  c.set('a', Buffer.alloc(4));
  c.set('b', Buffer.alloc(4));
  c.get('a'); // a を最新に
  c.set('c', Buffer.alloc(4)); // 件数超過 → b が落ちる
  assert.deepEqual([...c.map.keys()], ['a', 'c']);
  c.set('d', Buffer.alloc(9)); // 容量超過 → a, c が落ちる
  assert.deepEqual([...c.map.keys()], ['d']);
  c.set('huge', Buffer.alloc(11)); // 単体で上限超え → 入れない
  assert.equal(c.get('huge'), undefined);
});
