import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { FORMATS, OptionError, parseOptions } from './options.js';
import { RenderError, render } from './render.js';

const num = (name, fallback) => Number(process.env[name] ?? fallback);

const CONFIG = {
  port: num('PORT', 10000), // Render の既定ポート
  maxBodyBytes: num('MAX_BODY_BYTES', 64 * 1024),
  // latex は 1 プロセスで数十〜100MB 程度使う。Render Free (512MB) なら 2 が上限目安
  concurrency: num('MAX_CONCURRENCY', 2),
  maxQueue: num('MAX_QUEUE', 16),
  cacheEntries: num('CACHE_ENTRIES', 256),
  cacheBytes: num('CACHE_BYTES', 32 * 1024 * 1024),
  corsOrigin: process.env.CORS_ORIGIN ?? '*',
};

const RENDER_PATH = '/render';
const RENDER_METHODS = ['QUERY', 'POST'];
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
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key, buf) {
    if (buf.length > this.maxBytes) return;
    if (this.map.has(key)) {
      this.bytes -= this.map.get(key).length;
      this.map.delete(key);
    }
    this.map.set(key, buf);
    this.bytes += buf.length;
    for (const [k, v] of this.map) {
      if (this.map.size <= this.maxEntries && this.bytes <= this.maxBytes) break;
      this.map.delete(k);
      this.bytes -= v.length;
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
    'Access-Control-Allow-Methods': [...RENDER_METHODS, 'OPTIONS'].join(', '),
    'Access-Control-Allow-Headers': 'Content-Type, If-None-Match',
    'Access-Control-Expose-Headers': 'ETag, X-Cache, Content-Disposition',
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

// ---------------------------------------------------------------- handlers

const limiter = new Limiter(CONFIG.concurrency, CONFIG.maxQueue);
const cache = new LruCache(CONFIG.cacheEntries, CONFIG.cacheBytes);

async function handleRender(req, res, url) {
  const opts = parseOptions(url.searchParams);
  const body = await readBody(req, CONFIG.maxBodyBytes);
  const tex = body.toString('utf8').replace(/^﻿/, '');
  if (tex.trim() === '') throw new HttpError(400, 'Request body (TeX source) is empty');

  const key = createHash('sha256')
    .update(`${opts.format}\0${opts.transparent}\0${opts.scale}\0${tex}`)
    .digest('base64url');
  const etag = `"${key}"`;
  const headers = {
    ...corsHeaders(),
    ETag: etag,
    // QUERY は安全かつ冪等なのでキャッシュ可能。同一入力なら同一出力。
    'Cache-Control': 'public, max-age=86400, immutable',
    Vary: 'Origin',
  };

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  let out = cache.get(key);
  headers['X-Cache'] = out ? 'HIT' : 'MISS';
  if (!out) {
    out = await limiter.run(() => render(tex, opts));
    cache.set(key, out);
  }

  res.writeHead(200, {
    ...headers,
    'Content-Type': FORMATS[opts.format],
    'Content-Length': out.length,
    'Content-Disposition': `inline; filename="tex.${opts.format}"`,
    'X-Content-Type-Options': 'nosniff',
    // \special{dvisvgm:raw ...} で任意の SVG 要素（<script> 等）を埋め込めるため、
    // SVG を直接開かれた場合でもスクリプトが動かないようにする
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
  });
  res.end(out);
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

  if (url.pathname === RENDER_PATH) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }
    if (RENDER_METHODS.includes(req.method)) return handleRender(req, res, url);
    throw new HttpError(405, `Use ${RENDER_METHODS.join(' or ')} with the TeX source as the request body`, {
      Allow: [...RENDER_METHODS, 'OPTIONS'].join(', '),
      ...corsHeaders(),
    });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    throw new HttpError(405, 'Method not allowed', { Allow: 'GET, HEAD' });
  }
  if (url.pathname === '/') return handleIndex(res);
  if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true });
  throw new HttpError(404, 'Not found');
}

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const cors = req.method === 'OPTIONS' ? {} : corsHeaders();
      if (err instanceof RenderError) {
        sendJson(res, err.status, { error: err.message, line: err.line, log: err.log || undefined }, cors);
      } else if (err instanceof OptionError || err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message }, { ...cors, ...err.headers });
      } else {
        console.error(err);
        sendJson(res, 500, { error: 'Internal server error' }, cors);
      }
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
