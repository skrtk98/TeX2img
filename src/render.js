// TeX → DVI (latex) → SVG (dvisvgm) → PNG/WEBP (sharp/librsvg)
//
// 任意の TeX を実行するということは、任意のプログラムを実行するのと同義。
// 以下の多層防御で被害範囲を限定する:
//   - シェルエスケープ無効 (-no-shell-escape, shell_escape=f)
//   - ファイル読み書きを作業ディレクトリ配下に限定 (openin_any/openout_any=p)
//   - 実行時間の上限 (SIGKILL)、入力サイズ・出力ピクセル数の上限
//   - リクエスト毎の使い捨て一時ディレクトリ
//   - (Docker) 非 root ユーザーで実行

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

const env = (name, fallback) => Number(process.env[name] ?? fallback);

export const LIMITS = Object.freeze({
  compileTimeoutMs: env('TEX_TIMEOUT_MS', 15000),
  dvisvgmTimeoutMs: env('DVISVGM_TIMEOUT_MS', 15000),
  // ラスタ出力の 1 辺・総画素数の上限（メモリ枯渇対策）
  maxDimension: env('MAX_DIMENSION', 8000),
  maxPixels: env('MAX_PIXELS', 25_000_000),
});

// ラスタ出力は scale=1 のとき、ブラウザで SVG を等倍表示したときと同じピクセル数
// (CSS の 1pt = 4/3px) にする。sharp(librsvg) は density=72 で 1pt を 1px として
// 描画するので、dvisvgm 側で 4/3 倍した SVG を density=72 でラスタライズする。
// （density を上げる方式は sharp 側の倍率と二重に掛かるため使わない）
const RASTER_DENSITY = 72;
const PT_TO_PX = 4 / 3;
const BBOX_MARGIN_PT = 1;

export class RenderError extends Error {
  /**
   * @param {string} message
   * @param {{status?: number, line?: number|null, log?: string}} [details]
   */
  constructor(message, { status = 422, line = null, log = '' } = {}) {
    super(message);
    this.name = 'RenderError';
    this.status = status;
    this.line = line;
    this.log = log;
  }
}

// \documentclass を含まない入力は standalone の varwidth 環境で包む。
// varwidth により \[ ... \] や align* などのディスプレイ数式も使え、
// 出力は内容の自然な幅まで縮む。
const SNIPPET_PREAMBLE = String.raw`\documentclass[varwidth=\maxdimen]{standalone}
\usepackage{amsmath}
\usepackage{amssymb}
\usepackage{mathtools}
\usepackage{bm}
\usepackage{xcolor}
`;
const TIKZ_PREAMBLE = String.raw`\usepackage{tikz}
`;

// pgf/TikZ を dvisvgm ネイティブのドライバで出力させる（Ghostscript 経由より正確）。
// \documentclass より前に置いても無害。
const PGF_DRIVER = String.raw`\def\pgfsysdriver{pgfsys-dvisvgm.def}
`;

const USES_TIKZ = /\\(?:tikz|begin\s*\{tikzpicture\})/;
const HAS_DOCUMENTCLASS = /\\documentclass\b/;

// 和文を含む、または和文用クラス・オプションを指定した入力は upLaTeX で組む。
// それ以外は latex のほうが起動が軽く、欧文パッケージとの相性問題もないのでそちらを使う。
// 和文フォントは原ノ味（Adobe-Japan1）なので、ハングル等の日本語外の文字は出ない。
const CJK_CHARS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f\uff00-\uffef]/u;
const JA_CLASS = /\\documentclass\s*(?:\[[^\]]*\buplatex\b[^\]]*\])|\\documentclass\s*(?:\[[^\]]*\])?\s*\{(?:u?j(?:article|report|book)|js(?:article|report|book)|bxjs\w*)\}/;

/** @returns {'latex'|'uplatex'} */
export function selectEngine(tex) {
  return CJK_CHARS.test(tex) || JA_CLASS.test(tex) ? 'uplatex' : 'latex';
}

/**
 * ユーザー入力から完全な LaTeX 文書を組み立てる。
 * @param {string} tex
 * @returns {{source: string, lineOffset: number}} lineOffset はユーザー入力の 1 行目より前に挿入した行数
 */
export function buildDocument(tex) {
  if (HAS_DOCUMENTCLASS.test(tex)) {
    return { source: PGF_DRIVER + tex + '\n', lineOffset: countLines(PGF_DRIVER) };
  }
  const head =
    PGF_DRIVER + SNIPPET_PREAMBLE + (USES_TIKZ.test(tex) ? TIKZ_PREAMBLE : '') + '\\begin{document}\n';
  return { source: head + tex + '\n\\end{document}\n', lineOffset: countLines(head) };
}

function countLines(s) {
  return s.split('\n').length - 1;
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{cwd: string, timeoutMs: number, env?: NodeJS.ProcessEnv}} opts
 * @returns {Promise<{code: number|null, timedOut: boolean, stdout: Buffer, stderr: string}>}
 */
function run(cmd, args, { cwd, timeoutMs, env: extraEnv = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = [];
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => {
      if (err.length < 64 * 1024) err += d;
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, stdout: Buffer.concat(out), stderr: err });
    });
  });
}

const TEX_ENV = {
  // kpathsea は同名の環境変数で texmf.cnf の設定を上書きできる
  openin_any: 'p',
  openout_any: 'p',
  shell_escape: 'f',
};

/**
 * latex のログから最初のエラーを抜き出し、行番号をユーザー入力基準に補正する。
 * @param {string} log
 * @param {number} lineOffset
 */
export function parseTexError(log, lineOffset) {
  const lines = log.split('\n');
  // -file-line-error 形式: ./main.tex:12: Undefined control sequence.
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\.\/main\.tex:(\d+): (.*)$/);
    if (m) {
      const raw = Number(m[1]);
      const userLine = raw - lineOffset;
      return {
        message: m[2].trim() + contextAfter(lines, i),
        line: userLine >= 1 ? userLine : null,
      };
    }
  }
  const bang = lines.findIndex((l) => l.startsWith('! '));
  if (bang !== -1) {
    return { message: lines[bang].slice(2).trim() + contextAfter(lines, bang), line: null };
  }
  return { message: 'LaTeX compilation failed', line: null };
}

// "l.12 \foo" のようなエラー箇所の行を付け足す
function contextAfter(lines, i) {
  for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
    if (/^l\.\d+ /.test(lines[j])) return `\n${lines[j].replace(/^l\.\d+ /, '')}`;
  }
  return '';
}

function tailOf(s, maxLines = 40) {
  return s.split('\n').slice(-maxLines).join('\n');
}

/**
 * @param {string} tex
 * @param {number} scale
 * @param {'latex'|'uplatex'} engine
 * @returns {Promise<string>} SVG 文字列
 */
async function texToSvg(tex, scale, engine) {
  const dir = await mkdtemp(join(tmpdir(), 'tex2img-'));
  try {
    const { source, lineOffset } = buildDocument(tex);
    await writeFile(join(dir, 'main.tex'), source, 'utf8');

    const latex = await run(
      engine,
      ['-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', 'main.tex'],
      { cwd: dir, timeoutMs: LIMITS.compileTimeoutMs, env: TEX_ENV },
    );
    if (latex.timedOut) {
      throw new RenderError(`LaTeX compilation timed out after ${LIMITS.compileTimeoutMs} ms`, { status: 422 });
    }
    const log = await readFile(join(dir, 'main.log'), 'utf8').catch(() => latex.stdout.toString('utf8'));
    if (latex.code !== 0) {
      const { message, line } = parseTexError(log, lineOffset);
      throw new RenderError(message, { line, log: tailOf(log) });
    }

    const dvi = await run(
      'dvisvgm',
      [
        '--no-fonts', // グリフをパス化。閲覧環境のフォントに依存しない
        '--exact-bbox',
        // 最小 bbox の周囲に余白を付ける（アンチエイリアスの欠け防止）。
        // 余白は --scale の後に加算されるため、自前でスケールを掛ける
        `--bbox=${BBOX_MARGIN_PT * scale}pt`,
        '--page=1',
        // upLaTeX の和文フォント (uprml-h 等) を実フォント (原ノ味) に対応付ける
        ...(engine === 'uplatex' ? ['--fontmap=+kanjix.map'] : []),
        `--scale=${scale}`,
        '--stdout',
        'main.dvi',
      ],
      { cwd: dir, timeoutMs: LIMITS.dvisvgmTimeoutMs, env: TEX_ENV },
    );
    if (dvi.timedOut) {
      throw new RenderError(`SVG conversion timed out after ${LIMITS.dvisvgmTimeoutMs} ms`, { status: 422 });
    }
    const svg = dvi.stdout.toString('utf8');
    if (dvi.code !== 0 || !svg.includes('<svg')) {
      throw new RenderError('SVG conversion failed (empty page?)', { log: tailOf(dvi.stderr) });
    }
    return svg;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** SVG ルート要素の width/height (pt) を取得 */
export function svgSize(svg) {
  const root = svg.match(/<svg\b[^>]*>/)?.[0] ?? '';
  const num = (attr) => {
    const m = root.match(new RegExp(`\\b${attr}=['"]([\\d.]+)(pt)?['"]`));
    return m ? Number(m[1]) : NaN;
  };
  return { width: num('width'), height: num('height') };
}

/** 背景透過しない場合、viewBox 全体を白で塗る矩形を先頭に差し込む */
export function addSvgBackground(svg, color = '#ffffff') {
  const root = svg.match(/<svg\b[^>]*>/);
  if (!root) return svg;
  const vb = root[0].match(/viewBox=['"]([^'"]+)['"]/);
  const [x, y, w, h] = vb ? vb[1].trim().split(/[\s,]+/) : ['0', '0', '100%', '100%'];
  const rect = `<rect x='${x}' y='${y}' width='${w}' height='${h}' fill='${color}'/>`;
  const at = root.index + root[0].length;
  return svg.slice(0, at) + rect + svg.slice(at);
}

/**
 * @param {string} tex
 * @param {{format: 'svg'|'png'|'webp', transparent: boolean, scale: number}} opts
 * @returns {Promise<{body: Buffer, engine: 'latex'|'uplatex'}>}
 */
export async function render(tex, { format, transparent, scale }) {
  const engine = selectEngine(tex);
  const raster = format !== 'svg';
  let svg = await texToSvg(tex, raster ? scale * PT_TO_PX : scale, engine);
  if (!transparent) svg = addSvgBackground(svg);
  if (!raster) return { body: Buffer.from(svg, 'utf8'), engine };

  // density=72 では SVG の 1pt がそのまま 1px になる
  const { width, height } = svgSize(svg);
  const pxW = Math.ceil(width);
  const pxH = Math.ceil(height);
  if (!(pxW > 0 && pxH > 0)) {
    throw new RenderError('Could not determine output size (empty output?)');
  }
  if (pxW > LIMITS.maxDimension || pxH > LIMITS.maxDimension || pxW * pxH > LIMITS.maxPixels) {
    throw new RenderError(
      `Output too large: ${pxW}x${pxH}px (max ${LIMITS.maxDimension}px per side, ${LIMITS.maxPixels} pixels total). Reduce scale.`,
      { status: 413 },
    );
  }

  let img = sharp(Buffer.from(svg, 'utf8'), { density: RASTER_DENSITY, limitInputPixels: LIMITS.maxPixels });
  if (!transparent) img = img.flatten({ background: '#ffffff' });
  const body = await (format === 'png'
    ? img.png({ compressionLevel: 9 }).toBuffer()
    : img.webp({ lossless: true }).toBuffer());
  return { body, engine };
}
