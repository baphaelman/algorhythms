import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  MAX_DECODED_BYTES,
  decodeShareLink,
  decodeSharePayload,
  encodeShareLink,
  encodeSharePayload,
  sharePayloadOf,
} from '../../../src/app/share';

const sample = { format: 'algorhythms', version: 1, meta: { title: 'Ünïcode ♪ title' }, seed: 5 };

describe('share links (§11.4)', () => {
  it('round-trips JSON through base64url(deflate-raw)', async () => {
    const payload = await encodeSharePayload(sample);
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/); // no padding, no + or /
    expect(await decodeSharePayload(payload)).toEqual(sample);
  });

  it('is interoperable with zlib deflate-raw in both directions', async () => {
    const json = JSON.stringify(sample);
    const theirs = deflateRawSync(Buffer.from(json)).toString('base64url');
    expect(await decodeSharePayload(theirs)).toEqual(sample);
    const ours = await encodeSharePayload(sample);
    expect(JSON.parse(inflateRawSync(Buffer.from(ours, 'base64url')).toString('utf8'))).toEqual(
      sample,
    );
  });

  it('builds and reads #p= links', async () => {
    const link = await encodeShareLink(sample, 'https://example.org/algorhythms/');
    expect(link.startsWith('https://example.org/algorhythms/#p=')).toBe(true);
    expect(await decodeShareLink(link)).toEqual(sample);
    expect(await decodeShareLink(link.slice(link.indexOf('#')))).toEqual(sample);
    expect(await decodeShareLink('https://example.org/')).toBeNull();
    expect(sharePayloadOf('#other=1')).toBeNull();
    expect(sharePayloadOf('#p=')).toBeNull();
    expect(sharePayloadOf('#x=1&p=abc')).toBe('abc');
  });

  it('reports damaged links with readable errors', async () => {
    await expect(decodeSharePayload('not base64!')).rejects.toThrow(/base64/);
    await expect(decodeSharePayload('AAAA-not-deflate')).rejects.toThrow(/damaged/);
    const notJson = deflateRawSync(Buffer.from('hello')).toString('base64url');
    await expect(decodeSharePayload(notJson)).rejects.toThrow(/valid JSON/);
  });

  it('refuses a decompression bomb', async () => {
    const bomb = deflateRawSync(Buffer.alloc(MAX_DECODED_BYTES + 1024, 0x20)).toString('base64url');
    await expect(decodeSharePayload(bomb)).rejects.toThrow(/more data/);
  });
});
