// CashCast key server. Sells 16-byte segment keys against payments the listener's session key
// signs off-chain, and settles each channel on-chain once.
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { secp256k1, binToHex, hexToBin } from '@bitauth/libauth';
import { segmentKey } from './keys.js';
import { listenerPkh, channelContract, verifyPayment, buildSettle, lockOf, buildRefund } from './channel.js';

const sha256hex = (s) => createHash('sha256').update(s).digest('hex');

export function loadCatalog(mediaDir) {
  if (!existsSync(mediaDir)) return [];
  return readdirSync(mediaDir).filter((d) => existsSync(join(mediaDir, d, 'manifest.json')))
    .map((d) => JSON.parse(readFileSync(join(mediaDir, d, 'manifest.json'), 'utf8')))
    .sort((a, b) => b.durationSeconds - a.durationSeconds); // longest first: the free minute is a smaller share
}

export function buildServer(cfg) {
  const {
    provider, db, masterSecret, providerKey, mediaDir, payouts,
    priceSatsPerSegment = 150, centsPerMinute = null, usdPrice = null, freeSegments = 15, sessionBlocks = 144, safetyBlocks = 12,
    maxRefundFee = 1000, minFunding = 5000, maxSpend = 500_000, idleMs = 10 * 60_000, fundingCheckMs = 5_000,
    heightTtlMs = 30_000, dev = false, autoSettle = true, logger = false, rateLimitMax = 600, trustProxy = false,
  } = cfg;
  // Fail at startup, not at the first settlement: payouts must parse and add up to 100%.
  if (!payouts?.length || payouts.reduce((a, p) => a + p.bps, 0) !== 10_000) throw new Error('payout bps must sum to 10000');
  for (const p of payouts) lockOf(p.address);
  if (!Buffer.isBuffer(masterSecret) || masterSecret.length !== 32) throw new Error('master secret must be 32 bytes');
  const providerPk = binToHex(secp256k1.derivePublicKeyCompressed(providerKey));
  const catalog = loadCatalog(mediaDir);
  const tracks = new Map(catalog.map((m) => [m.trackId, m]));
  const app = Fastify({ logger, trustProxy }); // trustProxy only behind a local reverse proxy (real client IPs for rate limits)
  app.register(rateLimit, { max: rateLimitMax, timeWindow: '1 minute' });
  // Strict content security policy: scripts only from this site (plus WebAssembly for the crypto
  // library), connections only to this site and the WizardConnect relays.
  const csp = ["default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "connect-src 'self' wss:",
    "style-src 'self' https://fonts.googleapis.com", "font-src https://fonts.gstatic.com", "img-src 'self' data: https:",
    "media-src 'self' blob:", "worker-src 'self' blob:", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'"].join('; ');
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('content-security-policy', csp).header('x-content-type-options', 'nosniff').header('referrer-policy', 'no-referrer');
    return payload;
  });

  let heightCache = { at: 0, value: 0 };
  async function height() {
    if (Date.now() - heightCache.at >= heightTtlMs) heightCache = { at: Date.now(), value: await provider.getBlockHeight() };
    return heightCache.value;
  }

  const q = {
    insert: db.prepare(`INSERT INTO sessions (id, token_hash, listener_address, user_pkh, session_pk, timeout,
      max_refund_fee, address, created_at, last_activity, price_sats) VALUES (?,?,?,?,?,?,?,?,?,?,?)`),
    get: db.prepare('SELECT * FROM sessions WHERE id = ?'),
    fund: db.prepare(`UPDATE sessions SET funding_txid=?, funding_vout=?, funding_sats=?, status='funded' WHERE id=? AND status='open'`),
    pay: db.prepare('UPDATE sessions SET paid_amount=?, paid_sig=?, last_activity=? WHERE id=? AND paid_amount < ?'),
    touch: db.prepare('UPDATE sessions SET last_activity=? WHERE id=?'),
    settled: db.prepare(`UPDATE sessions SET settle_txid=?, status='settled' WHERE id=?`),
    claimSettle: db.prepare(`UPDATE sessions SET status='settling' WHERE id=? AND status='funded'`),
    setStatus: db.prepare('UPDATE sessions SET status=? WHERE id=?'),
    knownTx: db.prepare('SELECT 1 FROM sessions WHERE funding_txid = ? OR settle_txid = ? LIMIT 1'),
    due: db.prepare(`SELECT id FROM sessions WHERE status='funded' AND paid_amount > 0 AND (last_activity <= ? OR timeout - ? <= ?)`),
    expired: db.prepare(`SELECT id FROM sessions WHERE status IN ('funded','expired','closed') AND timeout <= ?`),
    refunded: db.prepare(`UPDATE sessions SET settle_txid=?, status='refunded' WHERE id=?`),
    isUnlocked: db.prepare('SELECT 1 FROM unlocked WHERE session_id=? AND track=? AND segment=?'),
    used: db.prepare('SELECT COUNT(*) AS n FROM unlocked WHERE session_id=?'),
    unlock: db.prepare('INSERT OR IGNORE INTO unlocked (session_id, track, segment) VALUES (?,?,?)'),
  };
  // Price: either fixed sats per 4-second segment, or `centsPerMinute` converted with the live
  // BCH/USD rate (`usdPrice()` → number or null). Each session keeps the price it opened with.
  async function currentPrice() {
    const usd = usdPrice ? await usdPrice() : null;
    if (centsPerMinute && usd) {
      const satsPerMinute = (centsPerMinute / 100 / usd) * 1e8;
      return { sats: Math.max(1, Math.round(satsPerMinute / (60 / 4))), usd };
    }
    return { sats: priceSatsPerSegment, usd };
  }
  const priceOf = (s) => s.price_sats || priceSatsPerSegment;
  const params = (s) => ({ userPkh: s.user_pkh, sessionPk: s.session_pk, providerPk, timeout: s.timeout, maxRefundFee: s.max_refund_fee });
  const credits = (s) => Math.floor(s.paid_amount / priceOf(s));

  // Bearer token check. The channel id is public; only the token (given once, at creation) is a credential.
  function tokenOk(s, headers) {
    const token = String(headers.authorization || '').replace(/^Bearer /, '');
    return Boolean(s && token && timingSafeEqual(Buffer.from(sha256hex(token)), Buffer.from(s.token_hash)));
  }
  function auth(req, reply) {
    const s = q.get.get(req.params.id);
    if (!tokenOk(s, req.headers)) { reply.code(401).send({ error: 'unknown session or bad token' }); return null; }
    return s;
  }

  // Look for the funding coin once the listener's wallet has paid the contract address.
  // Funding is accepted unconfirmed (BCH 0-conf), which is why each session can spend at most
  // `maxSpend` sats: that bounds what a double-spent funding could cost. Lookups are throttled.
  const lastFundingCheck = new Map();
  async function refreshFunding(s) {
    if (s.status !== 'open') return s;
    if (Date.now() - (lastFundingCheck.get(s.id) || 0) < fundingCheckMs) return s;
    lastFundingCheck.set(s.id, Date.now());
    const utxos = await provider.getUtxos(s.address);
    const coin = utxos.find((u) => !u.token && u.satoshis >= BigInt(minFunding));
    if (coin) { q.fund.run(coin.txid, coin.vout, Number(coin.satoshis), s.id); lastFundingCheck.delete(s.id); }
    return q.get.get(s.id);
  }

  const view = (s, height = heightCache.value) => ({
    height, refundableFrom: s.timeout + 1,
    id: s.id, status: s.status, address: s.address, params: params(s),
    funding: s.funding_txid ? { txid: s.funding_txid, vout: s.funding_vout, satoshis: s.funding_sats } : null,
    paidAmount: s.paid_amount, credits: credits(s), used: q.used.get(s.id).n, settleTxid: s.settle_txid,
    priceSatsPerSegment: priceOf(s),
  });

  app.get('/api/config', async () => {
    const price = await currentPrice();
    return { providerPk, priceSatsPerSegment: price.sats, usdPerBch: price.usd, centsPerMinute, freeSegments, sessionBlocks,
      maxRefundFee, minFunding, maxSpend, dev, autoSettle,
      payouts: payouts.map(({ address, bps, label }) => ({ address, bps, label: label || null })) };
  });
  app.get('/api/catalog', async () => catalog);

  app.post('/api/sessions', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { listenerAddress, sessionPk } = req.body || {};
    let userPkh;
    try { userPkh = binToHex(listenerPkh(String(listenerAddress))); } catch (e) { return reply.code(400).send({ error: e.message }); }
    if (!/^0[23][0-9a-f]{64}$/.test(String(sessionPk))) return reply.code(400).send({ error: 'sessionPk must be a compressed public key (hex)' });
    const timeout = (await height()) + sessionBlocks;
    const id = randomUUID(), token = randomBytes(32).toString('hex'), now = Date.now();
    const p = { userPkh, sessionPk, providerPk, timeout, maxRefundFee };
    const address = channelContract(p, provider).address;
    q.insert.run(id, sha256hex(token), listenerAddress, userPkh, sessionPk, timeout, maxRefundFee, address, now, now, (await currentPrice()).sats);
    return reply.code(201).send({ ...view(q.get.get(id)), token });
  });

  app.get('/api/sessions/:id', async (req, reply) => {
    const s = auth(req, reply); if (!s) return reply;
    const h = await height();
    return view(await refreshFunding(s), h);
  });

  // The listener's browser sends its new running total, signed with the session key.
  app.post('/api/sessions/:id/pay', async (req, reply) => {
    let s = auth(req, reply); if (!s) return reply;
    s = await refreshFunding(s);
    if (s.status !== 'funded') return reply.code(409).send({ error: `session is ${s.status}` });
    const amount = Number(req.body?.amount), sig = String(req.body?.sig || '');
    if (!Number.isSafeInteger(amount) || amount <= s.paid_amount) return reply.code(400).send({ error: 'total must increase' });
    if (amount > Math.min(s.funding_sats, maxSpend)) return reply.code(400).send({ error: 'total exceeds the channel balance or the per-session limit' });
    if (!/^[0-9a-f]{128}$/.test(sig) || !verifyPayment(s.session_pk, s.funding_txid, s.funding_vout, amount, sig)) {
      return reply.code(400).send({ error: 'bad signature' });
    }
    q.pay.run(amount, sig, Date.now(), s.id, amount);
    return view(q.get.get(s.id));
  });

  // Segment keys. The first `freeSegments` of every track are free; after that each new key uses one credit.
  app.get('/k/:track/:n', async (req, reply) => {
    const track = tracks.get(req.params.track), n = Number(req.params.n);
    if (!track || !Number.isInteger(n) || n < 0 || n >= track.keyHashes.length) return reply.code(404).send({ error: 'no such segment' });
    const send = () => reply.header('cache-control', 'no-store').type('application/octet-stream').send(segmentKey(masterSecret, track.trackId, n));
    if (n < freeSegments) return send();
    const id = String(req.headers['x-cashcast-session'] || '');
    const s = q.get.get(id);
    if (!tokenOk(s, req.headers)) return reply.code(402).send({ error: 'payment required' });
    if (s.status !== 'funded') return reply.code(402).send({ error: `session is ${s.status}` });
    // Stop selling well before the timeout, so the settlement is mined before anyone can refund.
    if ((await height()) >= s.timeout - safetyBlocks) return reply.code(410).send({ error: 'session expired; start a new one' });
    if (!q.isUnlocked.get(s.id, track.trackId, n)) {
      const bought = db.transaction(() => {
        const now = q.get.get(s.id);
        if (now.status !== 'funded') return false;
        if (q.isUnlocked.get(s.id, track.trackId, n)) return true; // a parallel request just bought it
        if (q.used.get(s.id).n >= credits(now)) return false;
        q.unlock.run(s.id, track.trackId, n);
        return true;
      })();
      if (!bought) return reply.code(402).send({ error: 'payment required', credits: credits(s), used: q.used.get(s.id).n });
    }
    q.touch.run(Date.now(), s.id);
    return send();
  });

  // Wallet helpers for the funding step. The browser derives the listener's addresses from the
  // wallet's xpubs; the server only looks up plain (non-token) coins and relays the signed transaction.
  app.post('/api/utxos', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const addresses = req.body?.addresses;
    if (!Array.isArray(addresses) || addresses.length === 0 || addresses.length > 40) return reply.code(400).send({ error: '1–40 addresses' });
    for (const address of addresses) {
      try { listenerPkh(String(address)); } catch { return reply.code(400).send({ error: `not a P2PKH address: ${address}` }); }
    }
    // All addresses at once: one by one took ~7 s for a 20-address wallet scan.
    const lists = await Promise.all(addresses.map((a) => provider.getUtxos(String(a))));
    return lists.flatMap((utxos, n) => utxos.filter((u) => !u.token)
      .map((u) => ({ address: addresses[n], txid: u.txid, vout: u.vout, satoshis: Number(u.satoshis) })));
  });
  // A CashCast transaction (a channel's funding, settlement or refund), so the page can show the
  // listener exactly where the money went. It decodes and checks the transaction itself.
  app.get('/api/tx/:txid', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const txid = String(req.params.txid);
    if (!/^[0-9a-f]{64}$/.test(txid)) return reply.code(400).send({ error: 'bad txid' });
    if (!q.knownTx.get(txid, txid)) return reply.code(404).send({ error: 'not a CashCast transaction' });
    const hex = await provider.getRawTransaction(txid);
    if (!hex) return reply.code(404).send({ error: 'not found yet' });
    return { hex };
  });
  app.post('/api/broadcast', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const hex = String(req.body?.hex || '');
    if (!/^[0-9a-f]{120,200000}$/.test(hex)) return reply.code(400).send({ error: 'bad transaction hex' });
    try { return { txid: await provider.sendRawTransaction(hex) }; } catch (e) { return reply.code(400).send({ error: e.message }); }
  });

  // Settle a session on-chain (the listener pressed stop, or the sweeper found it idle or near its timeout).
  // The session is first moved to 'settling', which freezes it: /pay and /k only serve 'funded'
  // sessions, so nothing can be bought after the settled total is read.
  async function settleSession(id) {
    const pre = q.get.get(id);
    if (!pre || pre.paid_amount <= 0 || q.claimSettle.run(id).changes !== 1) return null;
    const s = q.get.get(id);
    try {
      // At or past the timeout the keyless refund can win the race; don't broadcast a losing settle.
      if ((await provider.getBlockHeight()) >= s.timeout) { q.setStatus.run('expired', id); return null; }
      const contract = channelContract(params(s), provider);
      // Use the live coin from the chain: it also proves the channel is still unspent.
      const utxo = (await provider.getUtxos(s.address)).find((u) => u.txid === s.funding_txid && u.vout === s.funding_vout);
      if (!utxo) { q.setStatus.run('closed', id); return null; }
      const tx = buildSettle({ contract, provider, utxo, amount: s.paid_amount, sigHex: s.paid_sig,
        providerKey, userPkh: s.user_pkh, payouts });
      if (!tx) { q.setStatus.run('closed', id); return null; }
      const { txid } = await tx.send();
      q.settled.run(txid, id);
      return txid;
    } catch (e) {
      q.setStatus.run('funded', id); // try again on the next sweep
      throw e;
    }
  }

  // Return a channel's whole balance to the listener after its timeout (the contract's keyless
  // refund path). Anyone may trigger it; the money can only go to the listener.
  async function refundSession(id) {
    const s = q.get.get(id);
    if (!s || !s.funding_txid || !['funded', 'expired', 'closed'].includes(s.status)) return null;
    if ((await provider.getBlockHeight()) < s.timeout) return null;
    const utxo = (await provider.getUtxos(s.address)).find((u) => u.txid === s.funding_txid && u.vout === s.funding_vout);
    if (!utxo) return null;
    const tx = buildRefund({ contract: channelContract(params(s), provider), utxo, userPkh: s.user_pkh,
      timeout: s.timeout, maxRefundFee: s.max_refund_fee, provider });
    const { txid } = await tx.send();
    q.refunded.run(txid, id);
    return txid;
  }

  // Settle sessions nobody closed (idle ones, and any getting near their timeout), and return
  // the money of any channel that reached its timeout without a settlement.
  async function sweep() {
    const h = await provider.getBlockHeight();
    const done = [];
    for (const { id } of q.due.all(Date.now() - idleMs, safetyBlocks, h)) {
      try { const txid = await settleSession(id); if (txid) done.push(txid); } catch (e) { app.log.error({ id, err: e.message }, 'settle failed'); }
    }
    for (const { id } of q.expired.all(h)) {
      try { const txid = await refundSession(id); if (txid) done.push(txid); } catch (e) { app.log.error({ id, err: e.message }, 'refund failed'); }
    }
    return done;
  }

  app.post('/api/sessions/:id/refund', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const s = q.get.get(req.params.id);
    if (!s) return reply.code(404).send({ error: 'no such session' });
    const h = await height();
    if (h < s.timeout) return reply.code(409).send({ error: `refundable from block ${s.timeout + 1}`, height: h });
    const txid = await refundSession(s.id);
    return { ...view(q.get.get(s.id), h), refundTxid: txid };
  });

  app.post('/api/sessions/:id/settle', async (req, reply) => {
    const s = auth(req, reply); if (!s) return reply;
    const txid = await settleSession(s.id);
    return { ...view(q.get.get(s.id)), settleTxid: txid };
  });

  if (mediaDir && existsSync(mediaDir)) app.register(fastifyStatic, { root: mediaDir, prefix: '/media/' });
  app.decorate('settleSession', settleSession);
  app.decorate('sweep', sweep);
  return app;
}
