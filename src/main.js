// Start the CashCast server.
//   CASHCAST_NETWORK=mock     in-memory chain for local development (adds /api/dev/* helpers)
//   CASHCAST_NETWORK=mainnet  real Bitcoin Cash via Electrum/Fulcrum
// Secrets live in secrets/ (git-ignored, mode 600) and are created on first start.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import { MockNetworkProvider, randomUtxo } from 'cashscript';
import { generatePrivateKey, hexToBin, binToHex, hash160, secp256k1 } from '@bitauth/libauth';
import { openDb } from './db.js';
import { buildServer } from './server.js';
import { p2pkhAddress } from './channel.js';
import { livePrice } from './price.js';
import { FailoverProvider } from './chain.js';

const root = new URL('..', import.meta.url).pathname;
const network = process.env.CASHCAST_NETWORK || 'mock';
const secrets = join(root, 'secrets');
mkdirSync(secrets, { recursive: true, mode: 0o700 });

function secret(name, make) {
  const file = join(secrets, name);
  if (!existsSync(file)) writeFileSync(file, make(), { mode: 0o600 });
  return readFileSync(file, 'utf8').trim();
}
// One master secret per network, so dev keys never unlock real tracks. Checked strictly: a bad
// value must never silently become an empty (public) key.
const masterHex = secret(`master-${network}.key`, () => randomBytes(32).toString('hex'));
if (!/^[0-9a-f]{64}$/i.test(masterHex)) throw new Error('master secret must be 64 hex characters');
const masterSecret = Buffer.from(masterHex, 'hex');
const providerKey = hexToBin(secret(`provider-${network}.key`, () => binToHex(generatePrivateKey())));

const provider = network === 'mainnet' ? new FailoverProvider('mainnet', undefined, { log: (m) => console.log(m) }) : new MockNetworkProvider();
if (network === 'mock') provider.setBlockHeight(950_000);
// Start on whichever public server answers first, and re-check every few minutes, so a stalled
// server is not the first one a listener's request waits on.
if (network === 'mainnet') { provider.warmUp(); setInterval(() => provider.warmUp(), 5 * 60_000).unref(); }

const payouts = [
  { address: process.env.CASHCAST_ARTIST_ADDRESS, bps: 9000, label: 'Artist' },
  { address: process.env.CASHCAST_PLATFORM_ADDRESS, bps: 1000, label: 'CashCast' },
];
if (payouts.some((p) => !p.address)) {
  if (network === 'mainnet') throw new Error('set CASHCAST_ARTIST_ADDRESS and CASHCAST_PLATFORM_ADDRESS');
  // Development: throwaway payout addresses on the in-memory chain.
  for (const p of payouts) p.address = p2pkhAddress(hash160(secp256k1.derivePublicKeyCompressed(generatePrivateKey())));
}

const app = buildServer({
  provider, db: openDb(network === 'mock' ? ':memory:' : join(root, `cashcast-${network}.db`)), masterSecret, providerKey,
  mediaDir: join(root, 'media', network), payouts, logger: { level: 'info' }, dev: network === 'mock',
  trustProxy: process.env.CASHCAST_TRUST_PROXY === '1',
  autoSettle: process.env.CASHCAST_SWEEP !== 'off', // tells the page whether idle sessions settle on their own
  // 1 cent per minute at the live BCH price (mock mode: a fixed $200 so it works offline).
  centsPerMinute: Number(process.env.CASHCAST_CENTS_PER_MINUTE || 1),
  usdPrice: network === 'mock' ? async () => 200 : livePrice(),
  priceSatsPerSegment: Number(process.env.CASHCAST_PRICE_SATS_PER_SEGMENT || 300), // used only if no price is available
});

app.register(fastifyStatic, { root: join(root, 'web'), prefix: '/', decorateReply: false });
app.register(fastifyStatic, { root: join(root, 'node_modules/hls.js/dist'), prefix: '/vendor/hls/', decorateReply: false });

if (network === 'mock') {
  // Development only: pretend the listener's wallet funded the channel, or let blocks pass.
  app.post('/api/dev/fund', async (req) => {
    const { address, satoshis = 50_000 } = req.body || {};
    provider.addUtxo(address, randomUtxo({ satoshis: BigInt(satoshis) }));
    return { ok: true };
  });
  app.post('/api/dev/blocks', async (req) => {
    provider.setBlockHeight((await provider.getBlockHeight()) + Number(req.body?.n || 1));
    return { height: await provider.getBlockHeight() };
  });
}

// Settle idle sessions every minute.
if (process.env.CASHCAST_SWEEP !== 'off') setInterval(() => app.sweep().catch((e) => app.log.error(e)), 60_000).unref();

await app.listen({ port: Number(process.env.PORT || 8787), host: process.env.HOST || '127.0.0.1' });
