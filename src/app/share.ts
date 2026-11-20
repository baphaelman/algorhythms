/**
 * Share links (PLAN.md §11.4): `#p=` + base64url(deflate-raw(JSON)).
 *
 * Decoding is complete. Encoding writes the piece as it is; M5 extends `encodeShareLink` with
 * default stripping (and restores the defaults in `decodeShareLink`'s caller, `parsePiece`, which
 * already fills every omitted field). The fragment never reaches a server.
 */

/** The fragment key: `#p=<payload>`. */
export const SHARE_KEY = 'p';

/** Decoded JSON larger than this is refused (a guard against decompression bombs). */
export const MAX_DECODED_BYTES = 8 * 1024 * 1024;

/** Links longer than this are truncated by some chat apps; the UI should offer a file instead (§11.4). */
export const LONG_LINK_CHARS = 2000;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text))
    throw new Error('The link contains characters that are not base64url.');
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Runs bytes through a (de)compression stream, stopping once the output exceeds `limit` bytes. */
async function pipe(
  bytes: Uint8Array,
  stream: CompressionStream | DecompressionStream,
  limit = Infinity,
): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  // Errors surface on the reader side; ignore the writer's copies of them.
  writer.write(bytes as Uint8Array<ArrayBuffer>).catch(() => undefined);
  writer.close().catch(() => undefined);
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error('The link expands to more data than a piece can hold.');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** The base64url(deflate-raw(JSON)) payload of a piece (or any JSON value). */
export async function encodeSharePayload(value: unknown): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(value));
  const packed = await pipe(json, new CompressionStream('deflate-raw'));
  return toBase64Url(packed);
}

/** Decodes a payload to the JSON value inside it. Throws an Error with a readable message. */
export async function decodeSharePayload(payload: string): Promise<unknown> {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(payload.trim());
  } catch (e) {
    throw new Error(
      e instanceof Error && /base64url/.test(e.message)
        ? e.message
        : 'The link is damaged: it is not valid base64.',
      { cause: e },
    );
  }
  let json: Uint8Array;
  try {
    json = await pipe(bytes, new DecompressionStream('deflate-raw'), MAX_DECODED_BYTES);
  } catch (e) {
    if (e instanceof Error && /more data/.test(e.message)) throw e;
    throw new Error('The link is damaged: it could not be decompressed.', { cause: e });
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json)) as unknown;
  } catch (e) {
    throw new Error('The link is damaged: its contents are not valid JSON.', { cause: e });
  }
}

/** The payload in a URL fragment (`#p=…`, with or without the `#`), or null when there is none. */
export function sharePayloadOf(hash: string): string | null {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const p = params.get(SHARE_KEY);
  return p && p.length > 0 ? p : null;
}

/**
 * A share link for a piece: `base#p=<payload>`. `base` defaults to the current page without its
 * fragment. M5 strips defaults before encoding.
 */
export async function encodeShareLink(piece: unknown, base?: string): Promise<string> {
  const url = base ?? (typeof location === 'undefined' ? '' : location.href.split('#')[0]);
  return `${url}#${SHARE_KEY}=${await encodeSharePayload(piece)}`;
}

/** Decodes the piece JSON from a link or a bare fragment; null when it carries no `#p=`. */
export async function decodeShareLink(linkOrHash: string): Promise<unknown | null> {
  const hashAt = linkOrHash.indexOf('#');
  const payload = sharePayloadOf(hashAt >= 0 ? linkOrHash.slice(hashAt) : linkOrHash);
  return payload === null ? null : decodeSharePayload(payload);
}
