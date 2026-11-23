import { deflateSync, Inflate, strFromU8, strToU8 } from 'fflate';

import { MAX_APP_CONFIG_SIZE } from './config-file';
import { SITE_URL } from './site';

/** 结构放在 fragment：浏览器请求网站时不把它交给服务器。三端只用这一份编码。 */
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

/** 只做传输编码；检查通过的文件才由检查器给出链接，接收方仍须重新校验。 */
export function appLink(text: string): string {
  if (text.length > MAX_APP_CONFIG_SIZE) throw new Error('app file too large');
  const bytes = strToU8(text);
  if (bytes.length > MAX_APP_CONFIG_SIZE) throw new Error('app file too large');
  return `${APP_LINK_BASE}#a=${base64url(deflateSync(bytes))}`;
}

/** 聊天里一条超过这个长度的链接多半会被截断或点不开（单个 App 实测 1.2–3.5 KB，整套设置可到几十 KB）。 */
export const MAX_CHAT_LINK_LENGTH = 8000;

/** 检查器给 AI 放进回答的链接：太长就不给，让 AI 只交 JSON 代码块（复制是退路）。 */
export function chatAppLink(text: string): string | null {
  const link = appLink(text);
  return link.length <= MAX_CHAT_LINK_LENGTH ? link : null;
}

/** 不依赖 Node Buffer、浏览器 atob、TextDecoder；Hermes、Node 和网页同一条路。 */
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
  // 每次只给少量压缩数据：超限时停止，不先解出整个压缩炸弹再检查。
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

/** 原生意图需要在 router 丢掉 hash 之前，把已知导入地址改写为 /open?a=…；别的深链不动。 */
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
