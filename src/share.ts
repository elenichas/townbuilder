/** Compact, URL-safe encoding of a serialized town for share links. */

function toB64Url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64Url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const canCompress = typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

export async function encode(text: string): Promise<string> {
  const raw = new TextEncoder().encode(text);
  if (!canCompress) return 'p' + toB64Url(raw);
  const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return 'z' + toB64Url(new Uint8Array(await new Response(stream).arrayBuffer()));
}

export async function decode(s: string): Promise<string> {
  const bytes = fromB64Url(s.slice(1));
  if (s[0] === 'p') return new TextDecoder().decode(bytes);
  if (s[0] !== 'z' || !canCompress) throw new Error('unsupported town link');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}
