import { deflateSync, Inflate, strFromU8, strToU8 } from 'fflate';

import { MAX_APP_CONFIG_SIZE } from './config-file';
import { SITE_URL } from './site';

/** Structure is placed in the fragment: browser requests do not send it to the server. All three platforms use this single encoding format. */
export const APP_LINK_BASE = `${SITE_URL}/open`;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const MAX_PAYLOAD = Math.ceil(((MAX_APP_CONFIG_SIZE + 1024) * 4) / 3);

function base64url(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    chunks.push(
      ALPHABET[a >> 2]! +
        ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)]! +
        (b === undefined ? '' : ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)]!) +
        (c === undefined ? '' : ALPHABET[c & 63]!),
    );
  }
  return chunks.join('');
}

/** Performs transport encoding only; checked files receive links from the checker, and the receiver must still re-validate. */
export function appLink(text: string): string {
  if (text.length > MAX_APP_CONFIG_SIZE) throw new Error('app file too large');
  const bytes = strToU8(text);
  if (bytes.length > MAX_APP_CONFIG_SIZE) throw new Error('app file too large');
  return `${APP_LINK_BASE}#a=${base64url(deflateSync(bytes))}`;
}

/** Links exceeding this length in chat are likely to be truncated or fail to open (individual app measurements range from 1.2–3.5 KB, while full setups can reach tens of KB). */
export const MAX_CHAT_LINK_LENGTH = 8000;

/** Links provided by the checker for the AI to include in responses: omitted if too long, instructing the AI to provide only JSON code blocks (copying is the fallback). */
export function chatAppLink(text: string): string | null {
  const link = appLink(text);
  return link.length <= MAX_CHAT_LINK_LENGTH ? link : null;
}

/** Does not depend on Node Buffer, browser atob, or TextDecoder; Hermes, Node, and web use the same path. */
export function readAppLink(payload: string): string {
  if (
    !payload ||
    payload.length > MAX_PAYLOAD ||
    payload.length % 4 === 1 ||
    !/^[A-Za-z0-9_-]+$/.test(payload)
  )
    throw new Error('invalid app link');
  const bytes = new Uint8Array(Math.floor((payload.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let at = 0;
  for (const char of payload) {
    value = (value << 6) | ALPHABET.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[at++] = (value >> bits) & 255;
      value &= (1 << bits) - 1;
    }
  }
  if (value !== 0) throw new Error('invalid app link');
  const chunks: Uint8Array[] = [];
  let size = 0;
  const inflate = new Inflate((chunk) => {
    size += chunk.length;
    if (size > MAX_APP_CONFIG_SIZE) throw new Error('app file too large');
    chunks.push(chunk);
  });
  // Feeds compressed data in small chunks: stops upon exceeding limits, avoiding decompressing an entire decompression bomb before checking.
  for (let i = 0; i < bytes.length; i += 64)
    inflate.push(bytes.subarray(i, i + 64), i + 64 >= bytes.length);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return strFromU8(output);
}

/** Native intents need to rewrite known import addresses to /open?a=… before the router discards the hash; other deep links remain untouched. */
export function appLinkPayload(path: string): string | null {
  try {
    const url = new URL(path, SITE_URL);
    const native =
      url.protocol === 'morph:' &&
      url.hostname === 'open' &&
      (!url.pathname || url.pathname === '/');
    const web = url.origin === SITE_URL && url.pathname === '/open';
    if (!native && !web) return null;
    const params = new URLSearchParams(url.hash.startsWith('#a=') ? url.hash.slice(1) : url.search);
    const all = params.getAll('a');
    return all.length === 1 && all[0] && all[0].length <= MAX_PAYLOAD ? all[0] : null;
  } catch {
    return null;
  }
}
