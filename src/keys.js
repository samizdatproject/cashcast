// Segment keys. Every 4-second segment of a track has its own AES-128 key, derived from the
// server's master secret, so the server stores no keys and can always re-derive the one it sells.
import { hkdfSync, createHash } from 'node:crypto';

export const SEGMENT_SECONDS = 4;

export function segmentKey(masterSecret, trackId, n) {
  return Buffer.from(hkdfSync('sha256', masterSecret, Buffer.from(`cashcast/${trackId}`), Buffer.from(`segment/${n}`), 16));
}

// HLS AES-128 uses a 16-byte IV; we use the segment number (big-endian), stated explicitly in the playlist.
export function segmentIv(n) {
  const iv = Buffer.alloc(16);
  iv.writeUInt32BE(n, 12);
  return iv;
}

// What the manifest publishes for each key: a wrong key from the server is then provable.
export function keyCommitment(key) {
  return createHash('sha256').update(key).digest('hex');
}
