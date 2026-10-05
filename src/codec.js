// 埋め込み用 GET URL のための TeX ソースのエンコード。
// raw DEFLATE (RFC 1951) → base64url (RFC 4648 §5, パディングなし)。
// ブラウザでは CompressionStream('deflate-raw')、Python では
// zlib.compressobj(9, zlib.DEFLATED, -15) で同じものを作れる。

import { deflateRawSync, inflateRawSync } from 'node:zlib';

export class DecodeError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'DecodeError';
    this.status = status;
  }
}

/** @param {string} tex */
export function encodeSource(tex) {
  return deflateRawSync(Buffer.from(tex, 'utf8'), { level: 9 }).toString('base64url');
}

/**
 * @param {string} token
 * @param {number} maxBytes 展開後の上限（zip bomb 対策）
 */
export function decodeSource(token, maxBytes) {
  if (!/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new DecodeError('Encoded source must be base64url (A-Z a-z 0-9 - _) without padding');
  }
  let buf;
  try {
    buf = inflateRawSync(Buffer.from(token, 'base64url'), { maxOutputLength: maxBytes });
  } catch (e) {
    if (e.code === 'ERR_BUFFER_TOO_LARGE') {
      throw new DecodeError(`Decoded source too large (max ${maxBytes} bytes)`, 413);
    }
    throw new DecodeError('Encoded source is not valid raw-DEFLATE data');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw new DecodeError('Decoded source is not valid UTF-8');
  }
}
