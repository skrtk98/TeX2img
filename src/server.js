import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DecodeError, decodeSource, encodeSource } from './codec.js';
import { FORMATS, OptionError, canonicalQuery, parseOptions } from './options.js';
import { RenderError, render } from './render.js';

const num = (name, fallback) => Number(process.env[name] ?? fallback);

const CONFIG = {
  port: num('PORT', 10000), // Render の既定ポート
  maxBodyBytes: num('MAX_BODY_BYTES', 64 * 1024),
  // GET 埋め込み URL 用。Node の既定 (16KB) から引き上げる。
  // ただし手前のプロキシ・CDN・ブラウザ外のクライアントにも独自の上限がある
  maxHeaderBytes: num('MAX_HEADER_BYTES', 64 * 1024),
  // latex は 1 プロセスで数十〜100MB 程度使う。Render Free (512MB) なら 2 が上限目安
  concurrency: num('MAX_CONCURRENCY', 2),
  maxQueue: num('MAX_QUEUE', 16),
  cacheEntries: num('CACHE_ENTRIES', 256),
  cacheBytes: num('CACHE_BYTES', 32 * 1024 * 1024),
  corsOrigin: process.env.CORS_ORIGIN ?? '*',
  // これより長い埋め込み URL は Content-Location に載せない。
  // 巨大なレスポンスヘッダは手前のプロキシに弾かれうるし、URL としても実用的でない
  maxEmbedUrlBytes: num('MAX_EMBED_URL_BYTES', 8 * 1024),
};

const RENDER_PATH = '/render';
const BODY_METHODS = ['QUERY', 'POST'];
const URL_METHODS = ['GET', 'HEAD'];
const INDEX_HTML = fileURLToPath(new URL('../public/index.html', import.meta.url));

// ---------------------------------------------------------------- utilities

/** 同時実行数を制限するセマフォ。待ち行列が溢れたら即座に拒否する。 */
export class Limiter {
  constructor(concurrency, maxQueue) {
    this.concurrency = concurrency;
    this.maxQueue = maxQueue;
    this.active = 0;
    this.queue = [];
  }

  async run(fn) {
    if (this.active >= this.concurrency) {
      if (this.queue.length >= this.maxQueue) {
        throw new RenderError('Server is busy, try again later', { status: 503 });
      }
      await new Promise((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

/** 総バイト数と件数で上限を持つ LRU キャッシュ（Map の挿入順を利用） */
export class LruCache {
  constructor(maxEntries, maxBytes) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.bytes = 0;
    this.map = new Map();
  }

  get(key) {
    const e = this.map.get(key);
    if (e === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  set(key, value, size) {
    if (size > this.maxBytes) return;
    if (this.map.has(key)) {
      this.bytes -= this.map.get(key).size;
      this.map.delete(key);
    }
    this.map.set(key, { value, size });
    this.bytes += size;
    for (const [k, e] of this.map) {
      if (this.map.size <= this.maxEntries && this.bytes <= this.maxBytes) break;
      this.map.delete(k);
      this.bytes -= e.size;
    }
  }
}

class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (declared > limit) {
      reject(new HttpError(413, `Request body too large (max ${limit} bytes)`));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, `Request body too large (max ${limit} bytes)`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': CONFIG.corsOrigin,
    'Access-Control-Allow-Methods': [...URL_METHODS, ...BODY_METHODS, 'OPTIONS'].join(', '),
    'Access-Control-Allow-Headers': 'Content-Type, If-None-Match',
    'Access-Control-Expose-Headers': 'Accept-Query, ETag, X-Cache, X-TeX-Engine, Content-Location, Content-Disposition',
    'Access-Control-Max-Age': '86400',
  };
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

// \special{dvisvgm:raw ...} で任意の SVG 要素（<script> 等）を埋め込めるため、
// SVG を直接開かれた場合でもスクリプトが動かないようにする
const IMAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";

const xmlEscape = (s) =>
  s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);

/**
 * <img> 埋め込みでエラーになったとき、壊れた画像アイコンではなく原因を表示するための SVG。
 * ステータスコードは 4xx/5xx のまま（ブラウザは本文が画像なら表示する）。
 */
export function errorSvg(status, message, line) {
  const head = `TeX2img error ${status}${line ? ` (line ${line})` : ''}`;
  const lines = [head, ...message.split('\n')]
    .slice(0, 8)
    .map((l) => (l.length > 100 ? l.slice(0, 99) + '…' : l));
  const lh = 18;
  const width = Math.max(...lines.map((l) => l.length)) * 7.8 + 24;
  const height = lines.length * lh + 16;
  const text = lines
    .map((l, i) => `<text x='12' y='${22 + i * lh}'${i === 0 ? " font-weight='bold'" : ''}>${xmlEscape(l)}</text>`)
    .join('');
  return (
    `<svg xmlns='http://www.w3.org/2000/svg' width='${Math.ceil(width)}' height='${height}'>` +
    `<rect width='100%' height='100%' fill='#fdecec' stroke='#d33' stroke-width='2'/>` +
    `<g font-family='monospace' font-size='13' fill='#9b1c1c'>${text}</g></svg>`
  );
}

/** <img> などからのリクエストか（JSON より画像を欲しがっているか） */
function wantsImage(req) {
  const accept = req.headers.accept ?? '';
  return URL_METHODS.includes(req.method) && /\bimage\//.test(accept) && !/application\/json/.test(accept);
}

// ---------------------------------------------------------------- handlers

const limiter = new Limiter(CONFIG.concurrency, CONFIG.maxQueue);
const cache = new LruCache(CONFIG.cacheEntries, CONFIG.cacheBytes);

/** リクエストから TeX ソースを取り出す（ボディ / ?tex= / パス中のエンコード済みソース） */
async function readSource(req, url, token) {
  if (BODY_METHODS.includes(req.method)) {
    if (url.searchParams.has('tex')) {
      throw new HttpError(400, `Send the TeX source as the request body, not as "tex" parameter, with ${req.method}`);
    }
    return (await readBody(req, CONFIG.maxBodyBytes)).toString('utf8');
  }
  if (token !== undefined) {
    if (url.searchParams.has('tex')) throw new HttpError(400, 'Use either /render/{encoded} or ?tex=, not both');
    return decodeSource(token, CONFIG.maxBodyBytes);
  }
  const tex = url.searchParams.get('tex');
  if (tex === null) {
    throw new HttpError(
      400,
      'Missing TeX source: use GET /render?tex=..., GET /render/{deflate-raw+base64url}, or QUERY/POST /render with the source as the body',
    );
  }
  if (Buffer.byteLength(tex) > CONFIG.maxBodyBytes) {
    throw new HttpError(413, `TeX source too large (max ${CONFIG.maxBodyBytes} bytes)`);
  }
  return tex;
}

async function handleRender(req, res, url, token) {
  const opts = parseOptions(url.searchParams);
  const tex = (await readSource(req, url, token)).replace(/^﻿/, '');
  if (tex.trim() === '') throw new HttpError(400, 'TeX source is empty');

  const key = createHash('sha256')
    .update(`${opts.format}\0${opts.transparent}\0${opts.scale}\0${tex}`)
    .digest('base64url');
  const etag = `"${key}"`;
  const headers = {
    ...corsHeaders(),
    ETag: etag,
    'Cache-Control': 'public, max-age=604800, immutable',
    Vary: 'Origin',
  };
  // 同一入力なら同一出力。QUERY の結果と同じ表現を GET で取得できる URL を返す
  // （RFC 10008 の Content-Location）。埋め込みにはこれを使う
  const query = canonicalQuery(opts);
  const embedPath = `${RENDER_PATH}/${encodeSource(tex)}${query ? `?${query}` : ''}`;
  if (embedPath.length <= CONFIG.maxEmbedUrlBytes) headers['Content-Location'] = embedPath;

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  let out = cache.get(key);
  headers['X-Cache'] = out ? 'HIT' : 'MISS';
  if (!out) {
    out = await limiter.run(() => render(tex, opts));
    cache.set(key, out, out.body.length);
  }

  res.writeHead(200, {
    ...headers,
    'Content-Type': FORMATS[opts.format],
    'Content-Length': out.body.length,
    'Content-Disposition': `inline; filename="tex.${opts.format}"`,
    'X-Content-Type-Options': 'nosniff',
    'X-TeX-Engine': out.engine,
    'Content-Security-Policy': IMAGE_CSP,
  });
  res.end(out.body);
}

let indexCache;
async function handleIndex(res) {
  indexCache ??= await readFile(INDEX_HTML);
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': indexCache.length,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(indexCache);
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;

  if (pathname === RENDER_PATH || pathname.startsWith(`${RENDER_PATH}/`)) {
    const token = pathname === RENDER_PATH ? undefined : pathname.slice(RENDER_PATH.length + 1);
    const allowed = token === undefined ? [...URL_METHODS, ...BODY_METHODS] : URL_METHODS;
    // RFC 10008 §3: QUERY を受け付けること、および受け付けるクエリの形式を広告する
    if (token === undefined) res.setHeader('Accept-Query', 'text/plain');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }
    if (allowed.includes(req.method)) return handleRender(req, res, url, token);
    throw new HttpError(
      405,
      token === undefined
        ? 'Use QUERY or POST with the TeX source as the request body, or GET with ?tex='
        : 'Use GET for /render/{encoded}',
      { Allow: [...allowed, 'OPTIONS'].join(', '), ...corsHeaders() },
    );
  }

  if (!URL_METHODS.includes(req.method)) {
    throw new HttpError(405, 'Method not allowed', { Allow: URL_METHODS.join(', ') });
  }
  if (pathname === '/') return handleIndex(res);
  if (pathname === '/healthz') return sendJson(res, 200, { ok: true });
  throw new HttpError(404, 'Not found');
}

export function createServer() {
  return http.createServer({ maxHeaderSize: CONFIG.maxHeaderBytes }, async (req, res) => {
    try {
      await route(req, res);
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const cors = req.method === 'OPTIONS' ? {} : corsHeaders();
      const known =
        err instanceof RenderError ||
        err instanceof OptionError ||
        err instanceof HttpError ||
        err instanceof DecodeError;
      if (!known) console.error(err);
      const status = known ? err.status : 500;
      const message = known ? err.message : 'Internal server error';
      const line = err instanceof RenderError ? err.line : null;

      if (wantsImage(req)) {
        const svg = Buffer.from(errorSvg(status, message, line));
        res.writeHead(status, {
          ...cors,
          ...err.headers,
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Content-Length': svg.length,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': IMAGE_CSP,
        });
        res.end(svg);
        return;
      }
      const body = { error: message };
      if (err instanceof RenderError) Object.assign(body, { line, log: err.log || undefined });
      sendJson(res, status, body, { ...cors, ...err.headers });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createServer();
  server.listen(CONFIG.port, () => {
    console.log(`tex2img listening on :${CONFIG.port}`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
