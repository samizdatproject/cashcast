import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createDecipheriv, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageTrack } from '../scripts/package.mjs';
import { segmentKey, segmentIv, keyCommitment } from '../src/keys.js';

test('packager: every segment decrypts with its own key, and the manifest commits to that key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cashcast-test-'));
  try {
    const input = join(dir, 'tone.wav');
    execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=18', input]);
    const master = randomBytes(32);
    const m = packageTrack({ input, trackId: 'tone', title: 'Tone', artist: 'Test', license: 'CC0', outRoot: dir, master });
    const out = join(dir, 'tone');
    const segs = readdirSync(out).filter((f) => f.endsWith('.ts')).sort();
    assert.equal(segs.length, m.keyHashes.length);
    assert.ok(segs.length >= 4 && Math.abs(m.durationSeconds - 18) < 0.5, `${segs.length} segments, ${m.durationSeconds}s`);
    segs.forEach((f, n) => {
      const key = segmentKey(master, 'tone', n);
      assert.equal(keyCommitment(key), m.keyHashes[n]);
      const d = createDecipheriv('aes-128-cbc', key, segmentIv(n));
      const plain = Buffer.concat([d.update(readFileSync(join(out, f))), d.final()]);
      assert.equal(plain[0], 0x47, 'decrypted segment is MPEG-TS'); // TS sync byte
      // A neighbouring segment's key gives garbage, not the segment.
      const wrong = createDecipheriv('aes-128-cbc', segmentKey(master, 'tone', n + 1), segmentIv(n)).setAutoPadding(false);
      const garbage = Buffer.concat([wrong.update(readFileSync(join(out, f))), wrong.final()]);
      assert.ok(!garbage.subarray(0, plain.length).equals(plain));
    });
    const playlist = readFileSync(join(out, 'index.m3u8'), 'utf8');
    assert.equal((playlist.match(/#EXT-X-KEY:METHOD=AES-128,URI="\/k\/tone\/\d+"/g) || []).length, segs.length);
    assert.ok(playlist.includes('#EXT-X-ENDLIST'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
