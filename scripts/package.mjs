// Package one audio file for CashCast: ffmpeg cuts it into 4-second HLS segments, then each
// segment is encrypted with its own key. Output: media/<trackId>/{index.m3u8, seg_*.ts, manifest.json}.
// The encrypted files are public; only the keys are sold.
//
//   node scripts/package.mjs <audio file> <trackId> "<title>" "<artist>" "<license url>"
//   (master secret: CASHCAST_MASTER_SECRET env var, hex, or secrets/master.key)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { createCipheriv } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { segmentKey, segmentIv, keyCommitment, SEGMENT_SECONDS } from '../src/keys.js';

export function loadMasterSecret(root = new URL('..', import.meta.url).pathname) {
  const network = process.env.CASHCAST_NETWORK || 'mock';
  const file = join(root, 'secrets', `master-${network}.key`);
  const hex = process.env.CASHCAST_MASTER_SECRET || (existsSync(file) && readFileSync(file, 'utf8').trim());
  if (!hex) throw new Error(`No master secret: set CASHCAST_MASTER_SECRET or start the server once to create ${file}`);
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('master secret must be 64 hex characters');
  return Buffer.from(hex, 'hex');
}

export function packageTrack({ input, trackId, title, artist, license, outRoot, master, force = false }) {
  if (!/^[a-z0-9-]{1,40}$/.test(trackId)) throw new Error('trackId: lowercase letters, digits and dashes only');
  const out = join(outRoot, trackId);
  // Keys depend only on (master, trackId, segment): re-using a trackId for new audio would let old
  // keys decrypt it. Pick a new trackId instead.
  if (existsSync(out) && !force) throw new Error(`${trackId} already exists; use a new trackId`);
  const work = mkdtempSync(join(tmpdir(), 'cashcast-'));
  try {
    execFileSync('ffmpeg', ['-loglevel', 'error', '-i', input, '-vn', '-ac', '2', '-c:a', 'aac', '-b:a', '128k',
      '-f', 'hls', '-hls_time', String(SEGMENT_SECONDS), '-hls_playlist_type', 'vod',
      '-hls_segment_filename', join(work, 'seg_%05d.ts'), join(work, 'plain.m3u8')]);
    // Durations come from ffmpeg's own playlist, in segment order.
    const durations = readFileSync(join(work, 'plain.m3u8'), 'utf8').split('\n')
      .filter((l) => l.startsWith('#EXTINF:')).map((l) => Number(l.slice(8).split(',')[0]));
    const segments = readdirSync(work).filter((f) => f.endsWith('.ts')).sort();
    if (segments.length !== durations.length || segments.length === 0) throw new Error('ffmpeg output mismatch');

    mkdirSync(out, { recursive: true });
    const playlist = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...durations))}`,
      '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD'];
    const keyHashes = [];
    segments.forEach((file, n) => {
      const key = segmentKey(master, trackId, n), iv = segmentIv(n);
      const cipher = createCipheriv('aes-128-cbc', key, iv);
      writeFileSync(join(out, file), Buffer.concat([cipher.update(readFileSync(join(work, file))), cipher.final()]));
      keyHashes.push(keyCommitment(key));
      playlist.push(`#EXT-X-KEY:METHOD=AES-128,URI="/k/${trackId}/${n}",IV=0x${iv.toString('hex')}`,
        `#EXTINF:${durations[n].toFixed(3)},`, file);
    });
    playlist.push('#EXT-X-ENDLIST', '');
    writeFileSync(join(out, 'index.m3u8'), playlist.join('\n'));
    const manifest = { trackId, title, artist, license, segmentSeconds: durations,
      durationSeconds: Number(durations.reduce((a, b) => a + b, 0).toFixed(3)), keyHashes };
    writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
    return manifest;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [input, trackId, title, artist, license] = process.argv.slice(2);
  if (!license) throw new Error('usage: package.mjs <audio> <trackId> "<title>" "<artist>" "<license url>"');
  const m = packageTrack({ input, trackId, title, artist, license, master: loadMasterSecret(),
    outRoot: join(new URL('../media', import.meta.url).pathname, process.env.CASHCAST_NETWORK || 'mock') });
  console.log(`${m.trackId}: ${m.keyHashes.length} segments, ${m.durationSeconds}s`);
}
