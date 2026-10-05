// URL クエリパラメータの解釈と検証。
// 不正な値は黙って既定値に倒さず、400 で返す（API 利用者のバグを隠さないため）。

export const FORMATS = Object.freeze({
  svg: 'image/svg+xml; charset=utf-8',
  png: 'image/png',
  webp: 'image/webp',
});

export const DEFAULTS = Object.freeze({
  format: 'svg',
  transparent: true,
  scale: 1,
});

export const SCALE_MIN = 0.1;
export const SCALE_MAX = 10;

export class OptionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OptionError';
    this.status = 400;
  }
}

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

function parseBool(name, raw) {
  const v = raw.trim().toLowerCase();
  // `?transparent` のように値なしで指定された場合は true とみなす
  if (v === '' || TRUE_VALUES.has(v)) return true;
  if (FALSE_VALUES.has(v)) return false;
  throw new OptionError(`"${name}" must be a boolean (true/false/1/0), got "${raw}"`);
}

/**
 * @param {URLSearchParams} params
 * @returns {{format: 'svg'|'png'|'webp', transparent: boolean, scale: number}}
 */
export function parseOptions(params) {
  const opts = { ...DEFAULTS };

  const format = params.get('format');
  if (format !== null) {
    const f = format.trim().toLowerCase();
    if (!Object.hasOwn(FORMATS, f)) {
      throw new OptionError(`"format" must be one of ${Object.keys(FORMATS).join(', ')}, got "${format}"`);
    }
    opts.format = f;
  }

  const transparent = params.get('transparent');
  if (transparent !== null) opts.transparent = parseBool('transparent', transparent);

  const scale = params.get('scale');
  if (scale !== null) {
    const s = Number(scale.trim());
    if (scale.trim() === '' || !Number.isFinite(s) || s < SCALE_MIN || s > SCALE_MAX) {
      throw new OptionError(`"scale" must be a number between ${SCALE_MIN} and ${SCALE_MAX}, got "${scale}"`);
    }
    opts.scale = s;
  }

  return opts;
}
