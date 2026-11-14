// Key server, end to end on the mock chain: session → funding → signed totals → keys → settlement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockNetworkProvider, randomUtxo } from 'cashscript';
import { secp256k1, sha256, hash160, generatePrivateKey, binToHex, cashAddressToLockingBytecode } from '@bitauth/libauth';
import { packageTrack } from '../scripts/package.mjs';
import { segmentKey } from '../src/keys.js';
import { openDb } from '../src/db.js';
import { buildServer } from '../src/server.js';
import { channelContract, payMessage, p2pkhAddress } from '../src/channel.js';

const PRICE = 150, FREE = 2, SAFETY = 12;
const media = mkdtempSync(join(tmpdir(), 'cashcast-media-'));
const master = randomBytes(32);
const wav = join(media, 'tone.wav');
execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=18', wav]);
packageTrack({ input: wav, trackId: 'tone', title: 'Tone', artist: 'Test', license: 'CC0', outRoot: media, master });
rmSync(wav);
process.on('exit', () => rmSync(media, { recursive: true, force: true }));

const addr = () => p2pkhAddress(hash160(secp256k1.derivePublicKeyCompressed(generatePrivateKey())));

function world(opts = {}) {
  const provider = new MockNetworkProvider();
  provider.setBlockHeight(950_000);
  const payouts = [{ address: addr(), bps: 9000 }, { address: addr(), bps: 1000 }]; // artist 90%, platform 10%
  const app = buildServer({ provider, db: openDb(), masterSecret: master, providerKey: generatePrivateKey(), mediaDir: media,
    payouts, priceSatsPerSegment: PRICE, freeSegments: FREE, safetyBlocks: SAFETY, heightTtlMs: 0, fundingCheckMs: 0, idleMs: 60_000, ...opts });
  const listener = { address: addr(), session: generatePrivateKey() };
  return { provider, app, payouts, listener };
}

async function openSession(w) {
  const res = await w.app.inject({ method: 'POST', url: '/api/sessions',
    payload: { listenerAddress: w.listener.address, sessionPk: binToHex(secp256k1.derivePublicKeyCompressed(w.listener.session)) } });
  assert.equal(res.statusCode, 201, res.body);
  return res.json();
}
const authed = (s) => ({ authorization: `Bearer ${s.token}` });
const keyReq = (s, n) => ({ method: 'GET', url: `/k/tone/${n}`, headers: { ...authed(s), 'x-cashcast-session': s.id } });
function signTotal(w, s, amount) {
  return binToHex(secp256k1.signMessageHashSchnorr(w.listener.session, sha256.hash(payMessage(s.funding.txid, s.funding.vout, amount))));
}
async function pay(w, s, amount, sig = signTotal(w, s, amount)) {
  return w.app.inject({ method: 'POST', url: `/api/sessions/${s.id}/pay`, headers: authed(s), payload: { amount, sig } });
}
async function fund(w, s, sats = 20_000n) {
  w.provider.addUtxo(s.address, randomUtxo({ satoshis: sats }));
  const res = await w.app.inject({ method: 'GET', url: `/api/sessions/${s.id}`, headers: authed(s) });
  return res.json();
}

test('free first segments need no session; later ones need payment', async () => {
  const w = world();
  const free = await w.app.inject({ method: 'GET', url: '/k/tone/0' });
  assert.equal(free.statusCode, 200);
  assert.deepEqual(free.rawPayload, segmentKey(master, 'tone', 0));
  assert.equal((await w.app.inject({ method: 'GET', url: `/k/tone/${FREE}` })).statusCode, 402);
  assert.equal((await w.app.inject({ method: 'GET', url: '/k/tone/999' })).statusCode, 404);
});

test('the channel address the server gives can be rebuilt by the listener from the parameters', async () => {
  const w = world();
  const s = await openSession(w);
  assert.equal(channelContract(s.params, w.provider).address, s.address);
  assert.equal(s.params.timeout, 950_000 + 144);
});

test('totals: rejected before funding, must be signed by the session key, increase, and fit the balance', async () => {
  const w = world();
  let s = await openSession(w);
  assert.equal((await pay(w, { ...s, funding: { txid: '00'.repeat(32), vout: 0 } }, PRICE)).statusCode, 409);
  s = { ...(await fund(w, s)), token: s.token };
  assert.equal(s.status, 'funded');
  const other = binToHex(secp256k1.signMessageHashSchnorr(generatePrivateKey(), sha256.hash(payMessage(s.funding.txid, s.funding.vout, PRICE))));
  assert.equal((await pay(w, s, PRICE, other)).statusCode, 400);
  assert.equal((await pay(w, s, PRICE)).statusCode, 200);
  assert.equal((await pay(w, s, PRICE)).statusCode, 400, 'same total again');
  assert.equal((await pay(w, s, 20_001)).statusCode, 400, 'more than the balance');
  const bad = await w.app.inject({ method: 'GET', url: `/api/sessions/${s.id}`, headers: { authorization: 'Bearer nope' } });
  assert.equal(bad.statusCode, 401);
});

test('each credit unlocks one new key; a key already bought can be fetched again', async () => {
  const w = world();
  let s = await openSession(w);
  s = { ...(await fund(w, s)), token: s.token };
  assert.equal((await w.app.inject(keyReq(s, FREE))).statusCode, 402);
  await pay(w, s, PRICE); // one credit
  const k = await w.app.inject(keyReq(s, FREE));
  assert.equal(k.statusCode, 200);
  assert.deepEqual(k.rawPayload, segmentKey(master, 'tone', FREE));
  assert.equal((await w.app.inject(keyReq(s, FREE + 1))).statusCode, 402, 'no credit left');
  assert.equal((await w.app.inject(keyReq(s, FREE))).statusCode, 200, 'same key again is free');
  await pay(w, s, PRICE * 2);
  assert.equal((await w.app.inject(keyReq(s, FREE + 1))).statusCode, 200);
});

test('keys stop being sold near the timeout', async () => {
  const w = world();
  let s = await openSession(w);
  s = { ...(await fund(w, s)), token: s.token };
  await pay(w, s, PRICE * 3);
  w.provider.setBlockHeight(s.params.timeout - SAFETY);
  assert.equal((await w.app.inject(keyReq(s, FREE))).statusCode, 410);
});

test('settlement: listener gets the remainder, artist 90% and platform 10% of the rest after the fee', async () => {
  const w = world();
  let s = await openSession(w);
  s = { ...(await fund(w, s)), token: s.token };
  await pay(w, s, 10_000);
  const res = await w.app.inject({ method: 'POST', url: `/api/sessions/${s.id}/settle`, headers: authed(s) });
  assert.equal(res.statusCode, 200, res.body);
  const done = res.json();
  assert.equal(done.status, 'settled');
  assert.ok(done.settleTxid);
  const sats = async (a) => (await w.provider.getUtxosForLockingBytecode(cashAddressToLockingBytecode(a).bytecode)).reduce((t, u) => t + u.satoshis, 0n);
  assert.equal(await sats(w.listener.address), 10_000n);
  const artist = await sats(w.payouts[0].address), platform = await sats(w.payouts[1].address);
  const fee = 10_000n - artist - platform;
  assert.ok(fee > 0n && fee < 1_000n, `fee ${fee}`);
  assert.ok(artist > platform * 8n && artist < platform * 10n, `artist ${artist}, platform ${platform}`);
  // A second settle does nothing.
  const again = await w.app.inject({ method: 'POST', url: `/api/sessions/${s.id}/settle`, headers: authed(s) });
  assert.equal(again.json().settleTxid, null);
});

test('a tiny total still settles so the listener gets the rest back now (the share pays the fee)', async () => {
  const w = world();
  let s = await openSession(w);
  s = { ...(await fund(w, s)), token: s.token };
  await pay(w, s, 900);
  const res = await w.app.inject({ method: 'POST', url: `/api/sessions/${s.id}/settle`, headers: authed(s) });
  assert.equal(res.json().status, 'settled');
  const back = (await w.provider.getUtxosForLockingBytecode(cashAddressToLockingBytecode(w.listener.address).bytecode)).reduce((t, u) => t + u.satoshis, 0n);
  assert.equal(back, 19_100n);
});

test('once settling starts the session is frozen: no more totals or keys, and a second settle does nothing', async () => {
  const w = world();
  let s = await openSession(w);
  s = { ...(await fund(w, s)), token: s.token };
  await pay(w, s, 1_050);
  const settling = w.app.inject({ method: 'POST', url: `/api/sessions/${s.id}/settle`, headers: authed(s) });
  const [late, key, second] = await Promise.all([pay(w, s, 6_000), w.app.inject(keyReq(s, FREE)),
    w.app.inject({ method: 'POST', url: `/api/sessions/${s.id}/settle`, headers: authed(s) })]);
  const results = [(await settling).json(), second.json()];
  const winners = results.filter((r) => r.settleTxid);
  assert.equal(winners.length, 1, 'exactly one settle broadcasts');
  assert.equal(winners[0].paidAmount, 1_050, 'the settled total is the one read when settling started');
  assert.equal(late.statusCode, 409);
  assert.notEqual(key.statusCode, 200);
});

test('the sweeper settles idle sessions without the listener pressing stop', async () => {
  const w = world({ idleMs: 0 });
  let s = await openSession(w);
  s = { ...(await fund(w, s)), token: s.token };
  await pay(w, s, 3_000);
  const txids = await w.app.sweep();
  assert.equal(txids.length, 1);
  const now = (await w.app.inject({ method: 'GET', url: `/api/sessions/${s.id}`, headers: authed(s) })).json();
  assert.equal(now.status, 'settled');
});

test('the sweeper settles a busy session that is near its timeout, but never at or after it', async () => {
  const w = world();
  let s = await openSession(w);
  s = { ...(await fund(w, s)), token: s.token };
  await pay(w, s, 3_000);
  assert.equal((await w.app.sweep()).length, 0, 'active and far from the timeout');
  w.provider.setBlockHeight(s.params.timeout - SAFETY);
  assert.equal((await w.app.sweep()).length, 1);
  const w2 = world();
  let s2 = await openSession(w2);
  s2 = { ...(await fund(w2, s2)), token: s2.token };
  await pay(w2, s2, 3_000);
  w2.provider.setBlockHeight(s2.params.timeout);
  assert.equal((await w2.app.settleSession(s2.id)), null, 'at the timeout a settle could lose to the refund: do not broadcast it');
  // ...so the sweeper returns the whole channel to the listener instead.
  assert.equal((await w2.app.sweep()).length, 1);
  const after = (await w2.app.inject({ method: 'GET', url: `/api/sessions/${s2.id}`, headers: authed(s2) })).json();
  assert.equal(after.status, 'refunded');
});

test('totals above the per-session limit are refused (bounds the cost of a double-spent funding)', async () => {
  const w = world({ maxSpend: 5_000 });
  let s = await openSession(w);
  s = { ...(await fund(w, s)), token: s.token };
  assert.equal((await pay(w, s, 5_001)).statusCode, 400);
  assert.equal((await pay(w, s, 5_000)).statusCode, 200);
});

test('bad configuration fails at startup', () => {
  const base = { provider: new MockNetworkProvider(), db: openDb(), masterSecret: master, providerKey: generatePrivateKey(), mediaDir: media };
  assert.throws(() => buildServer({ ...base, payouts: [{ address: addr(), bps: 9000 }] }), /sum to 10000/);
  assert.throws(() => buildServer({ ...base, payouts: [{ address: 'nonsense', bps: 10000 }] }));
  assert.throws(() => buildServer({ ...base, masterSecret: Buffer.alloc(0), payouts: [{ address: addr(), bps: 10000 }] }), /32 bytes/);
});

test('a session keeps the price it opened with, even if the BCH price moves', async () => {
  let usd = 200;
  const w = world({ centsPerMinute: 1, usdPrice: async () => usd });
  const cfg = (await w.app.inject({ method: 'GET', url: '/api/config' })).json();
  assert.equal(cfg.priceSatsPerSegment, 333); // 1¢/min at $200 = 5,000 sats/min = 333 per 4 s
  let s = await openSession(w);
  usd = 100;
  assert.equal((await w.app.inject({ method: 'GET', url: '/api/config' })).json().priceSatsPerSegment, 667);
  s = { ...(await fund(w, s)), token: s.token };
  const r = (await pay(w, s, 666)).json();
  assert.equal(r.credits, 2);
  assert.equal(r.priceSatsPerSegment, 333);
});

test('after the timeout an unsettled channel is refunded to the listener (button or sweeper)', async () => {
  const w = world();
  let s = await openSession(w);
  s = { ...(await fund(w, s)), token: s.token };
  const early = await w.app.inject({ method: 'POST', url: `/api/sessions/${s.id}/refund` });
  assert.equal(early.statusCode, 409);
  w.provider.setBlockHeight(s.params.timeout);
  const res = await w.app.inject({ method: 'POST', url: `/api/sessions/${s.id}/refund` });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().status, 'refunded');
  const back = (await w.provider.getUtxosForLockingBytecode(cashAddressToLockingBytecode(w.listener.address).bytecode)).reduce((t, u) => t + u.satoshis, 0n);
  assert.ok(back > 19_000n && back < 20_000n, `${back}`);
  // The sweeper does the same for any other expired channel.
  let s2 = await openSession(w);
  w.provider.setBlockHeight(s2.params.timeout - 200);
  s2 = { ...(await fund(w, s2)), token: s2.token };
  w.provider.setBlockHeight(s2.params.timeout);
  assert.equal((await w.app.sweep()).length, 1);
});
