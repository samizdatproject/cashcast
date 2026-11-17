// CashCast player. The free first minute plays at once; after that a throwaway session key in
// this browser signs a growing total, and the server sells one segment key per credit.
import Hls from 'hls.js/dist/hls.light.mjs';

// Crypto and wallet code load only when the listener decides to pay, so the free minute starts fast.
const lib = () => import('@bitauth/libauth');
const walletLib = () => import('./wallet.js');
const verifyLib = () => import('./verify.js');

const $ = (sel) => document.querySelector(sel);
const AHEAD = 2;                  // spare paid keys beyond what the player has buffered (buffer + spare ≈ 16–20 s)
const STORE = 'cashcast-session';
const CLOSE_FEE_SATS = 700;       // when stopping before any paid key: covers the settlement fee so the rest returns now
const EXPLORER = 'https://blockchair.com/bitcoin-cash/transaction/';
const HISTORY = 'cashcast-history';
const BLOCK_MINUTES = 10;

const state = {
  config: null, catalog: [], track: null, hls: null,
  session: null, sessionKey: null, wallet: null, budget: 0,
  bought: new Set(),              // paid keys this browser has fetched ("track/segment")
  prepared: null, coins: null,    // background preparation while the listener picks a budget
  busy: false, approving: false, connecting: false, signAbort: null, cancelWait: false,
  // What this browser itself decided, never overwritten by server replies: the approved budget,
  // the pinned price, the checked contract address, the last total it signed, keys used before a reload.
  trust: null,
};

// Server replies may update only these fields of the session; the id, token, address and
// contract parameters are fixed at creation (and checked before the wallet signs).
const SERVER_FIELDS = ['status', 'funding', 'paidAmount', 'used', 'credits', 'settleTxid', 'height', 'refundableFrom', 'priceSatsPerSegment'];
function merge(data) {
  for (const k of SERVER_FIELDS) if (k in data) state.session[k] = data[k];
}

// ---------- small helpers ----------
const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => Uint8Array.from(h.match(/../g) || [], (x) => parseInt(x, 16));
const u32le = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const u64le = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
const fmtTime = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

function money(sats) {
  const usd = state.config?.usdPerBch;
  if (!usd) return `${Number(sats).toLocaleString()} sats`;
  const cents = (sats / 1e8) * usd * 100;
  if (cents >= 100) return `$${(cents / 100).toFixed(2)}`;
  if (cents >= 10) return `${Math.round(cents)}¢`;
  return `${cents.toFixed(1)}¢`;
}
const satsForCents = (c) => Math.round((c / 100 / state.config.usdPerBch) * 1e8 / 100) * 100;

async function api(path, { method = 'GET', body, auth = false } = {}) {
  const headers = body ? { 'content-type': 'application/json' } : {};
  if (auth) headers.authorization = `Bearer ${state.session.token}`;
  const res = await fetch(path, { method, headers, body: body && JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, data });
  return data;
}

function save() {
  try {
    if (state.session) localStorage.setItem(STORE, JSON.stringify({ ...state.session, sessionKey: toHex(state.sessionKey), trust: state.trust }));
    else localStorage.removeItem(STORE);
  } catch { /* storage unavailable: the session won't survive a reload */ }
}
function loadSaved() {
  try { return JSON.parse(localStorage.getItem(STORE) || 'null'); } catch { return null; }
}

function payMessage(txid, vout, amount) {
  const parts = [new TextEncoder().encode('CC01'), fromHex(txid).reverse(), u32le(vout), u64le(amount)];
  const out = new Uint8Array(48); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---------- panel steps ----------
function step(name) {
  for (const el of document.querySelectorAll('.step')) el.hidden = el.dataset.step !== name;
  state.step = name;
  if (name === 'settled') showDisconnect();
}
// After a session, offer to drop the wallet connection (only if a real wallet is paired).
async function showDisconnect() {
  const line = $('#disconnectline');
  line.hidden = true;
  if (state.config?.dev) return;
  $('#disconnect').hidden = false;
  $('#disconnectmsg').textContent = "· removes CashCast from your wallet's connections";
  line.hidden = !(state.wallet || (await walletLib()).rememberedWallet());
}
function showError(e) { $('#error').textContent = e ? (e.message || String(e)) : ''; }

// ---------- payments ----------
// Everything that decides how much to sign comes from this browser's own record (state.trust):
// the price pinned at approval, the budget the listener chose, the last total it signed and the
// keys it fetched. A lying server can therefore never make it sign more than ~5 segments ahead.
async function signTotal(amount) {
  const s = state.session;
  const { secp256k1, sha256 } = await lib();
  const sig = toHex(secp256k1.signMessageHashSchnorr(state.sessionKey, sha256.hash(payMessage(s.funding.txid, s.funding.vout, amount))));
  merge(await api(`/api/sessions/${s.id}/pay`, { method: 'POST', body: { amount, sig }, auth: true }));
  state.trust.signed = amount;
  save();
}

// Keep `AHEAD` paid keys in hand, never past the end of the current track.
async function ensureCredits() {
  const s = state.session, T = state.trust;
  if (!s || !T || s.status !== 'funded' || state.busy) return;
  if (s.priceSatsPerSegment && s.priceSatsPerSegment > T.price) throw new Error('The server asked for a higher price than you approved; payments stopped.');
  const price = T.price;
  const t = state.track;
  // Nothing is paid while the free preview still has more than ~28 s to go.
  if (Math.floor(($('#audio').currentTime || 0) / 4) < state.config.freeSegments - AHEAD - 2) return;
  const boughtHere = [...state.bought].filter((k) => k.startsWith(`${t.trackId}/`)).length;
  const leftInTrack = Math.max(0, t.keyHashes.length - state.config.freeSegments - boughtHere);
  // Keys used: our own (persisted) count, or the server's if higher, but never more than we paid for.
  const used = Math.max(state.bought.size, Math.min(s.used || 0, Math.floor(T.signed / price)));
  const target = used + Math.min(AHEAD, leftInTrack);
  if (Math.floor(T.signed / price) >= target) return;
  const cap = Math.min(T.budget, state.config.maxSpend);
  const amount = Math.min(target, Math.floor(cap / price)) * price;
  if (amount <= T.signed) { step('budget'); return; }
  state.busy = true;
  try { await signTotal(amount); renderMeter(); } finally { state.busy = false; }
}

async function startSession(listenerAddress) {
  const { generatePrivateKey, secp256k1 } = await lib();
  state.sessionKey = generatePrivateKey();
  const sessionPk = toHex(secp256k1.derivePublicKeyCompressed(state.sessionKey));
  state.session = await api('/api/sessions', { method: 'POST', body: { listenerAddress, sessionPk } });
  state.bought.clear();
  save();
}

async function refreshSession() {
  merge(await api(`/api/sessions/${state.session.id}`, { auth: true }));
  save();
  return state.session;
}

const SIGN_WINDOW_MS = 15 * 60_000; // how long a phone wallet may still broadcast a request it was sent
async function waitForWalletPayment() {
  $('#signamount').textContent = `${money(state.trust.budget)} (${state.trust.budget.toLocaleString()} sats)`;
  $('#fundstep').textContent = 'Approve the payment in your wallet app; this page will notice it';
  $('#signhint').hidden = false;
  step('signing');
  try {
    // Wait as long as the wallet may still send it (the same window resume() honours).
    await waitForFunding(Math.max(state.trust.signRequestedAt + SIGN_WINDOW_MS, Date.now() + 120_000));
  } catch (e) {
    delete state.trust.signRequestedAt; save();
    showError(e.name === 'AbortError' ? 'Cancelled. If your wallet already sent the payment, reload in a minute.' : e);
    step(state.wallet ? 'approve' : 'free');
    return;
  }
  delete state.trust.signRequestedAt; save();
  step('funded');
  $('.panel').classList.remove('nudge');
  renderMeter();
  continuePlayback();
  ensureCredits().then(renderMeter).catch(showError);
}

// Polls until the channel is funded or `until` (ms) passes. A failed poll is retried; only a session the server
// no longer knows (401/404) ends it early.
async function waitForFunding(until = Date.now() + 300_000) {
  state.cancelWait = false;
  while (Date.now() < until) {
    if (state.cancelWait) throw Object.assign(new Error('Cancelled.'), { name: 'AbortError' });
    try { if ((await refreshSession()).status === 'funded') return; }
    catch (e) { if (e.status === 401 || e.status === 404) throw e; }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('No payment seen yet. If your wallet sent it, reload in a minute.');
}

async function settle() {
  $('#audio').pause();
  // Stopped before any paid key: sign just the settlement fee so the rest comes back now,
  // instead of after the ~1 day timeout.
  if (state.session.status === 'funded' && state.trust && state.trust.signed === 0 && state.trust.budget > CLOSE_FEE_SATS + 546) {
    await signTotal(CLOSE_FEE_SATS);
  }
  const s = await api(`/api/sessions/${state.session.id}/settle`, { method: 'POST', auth: true });
  merge(s); save();
  if (s.status === 'settled') {
    const paid = Math.min(s.paidAmount, state.trust?.signed ?? s.paidAmount);
    $('#paidtotal').textContent = money(paid);
    $('#returned').textContent = money((state.trust?.budget ?? s.funding.satoshis) - paid);
    step('settled');
    await showReceipt('settle', s.settleTxid);
  } else {
    showWaiting(s);
  }
}

// ---------- receipt ----------
// After a settlement or refund the browser fetches the transaction, checks it is the one that
// spent this channel, and shows every output: what came back to the listener, the artist's and
// CashCast's shares, and the network fee. Kept in this browser's history.
const shortId = (txid) => `${txid.slice(0, 8)}…${txid.slice(-6)}`;
const sats = (n) => `${Number(n).toLocaleString()} sats`;

async function fetchTx(txid) {
  for (let i = 0; i < 6; i++) {
    try { return (await api(`/api/tx/${txid}`)).hex; } catch (e) { if (e.status !== 404 || i === 5) throw e; }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function readClose(kind, txid) {
  const s = state.session, { decodeTransaction, hashTransaction, hexToBin, binToHex, cashAddressToLockingBytecode } = await lib();
  const bin = hexToBin(await fetchTx(txid));
  const tx = decodeTransaction(bin);
  if (typeof tx === 'string' || hashTransaction(bin) !== txid) throw new Error('the transaction did not check out');
  const input = tx.inputs[0];
  if (tx.inputs.length !== 1 || binToHex(input.outpointTransactionHash) !== s.funding.txid || input.outpointIndex !== s.funding.vout) {
    throw new Error('the transaction does not spend this channel');
  }
  const own = `76a914${s.params.userPkh}88ac`;
  const payouts = (state.config.payouts || []).map((p) => ({ ...p, lock: binToHex(cashAddressToLockingBytecode(p.address).bytecode) }));
  const outs = tx.outputs.map((o) => ({ lock: binToHex(o.lockingBytecode), value: Number(o.valueSatoshis) }));
  const others = outs.filter((o) => o.lock !== own);
  // Settlement outputs come in payout order. When a part would be below the 546-sat minimum, the
  // whole share goes to the largest payout (the artist) in a single output.
  const main = payouts.reduce((a, p) => (p.bps > a.bps ? p : a), payouts[0]);
  const whole = others.length === 1 && payouts.length > 1;
  const expected = whole ? [main] : payouts;
  const rows = outs.map((o) => {
    if (o.lock === own) return { label: 'Back to you', value: o.value, you: true };
    const p = expected[others.indexOf(o)];
    const label = !p || p.lock !== o.lock ? 'Other' : whole ? `${p.label || 'Payout'} (whole share)` : `${p.label || 'Payout'} (${p.bps / 100}%)`;
    return { label, value: o.value };
  });
  const input0 = s.funding.satoshis;
  rows.push({ label: 'Network fee', value: input0 - outs.reduce((a, o) => a + o.value, 0) });
  return { kind, txid, rows, back: rows.filter((r) => r.you).reduce((a, r) => a + r.value, 0) };
}

function receiptEl(entry) {
  const box = document.createElement('div'); box.className = 'receipt';
  const txRow = (title, amount, txid, note, rows) => {
    const d = document.createElement('div'); d.className = 'tx';
    const head = document.createElement('div'); head.className = 'head';
    const b = document.createElement('b'); b.textContent = title;
    const a = document.createElement('a'); a.href = EXPLORER + txid; a.target = '_blank'; a.rel = 'noopener'; a.textContent = `${shortId(txid)} ↗`;
    const amt = document.createElement('span'); amt.className = 'amt'; amt.textContent = amount;
    head.append(b, a, amt); d.append(head);
    if (note) { const n = document.createElement('div'); n.className = 'note'; n.textContent = note; d.append(n); }
    if (rows) {
      const ul = document.createElement('ul');
      for (const r of rows) {
        const li = document.createElement('li'); if (r.you) li.className = 'you';
        const l = document.createElement('span'); l.textContent = r.label;
        const v = document.createElement('span'); v.textContent = sats(r.value);
        li.append(l, v); ul.append(li);
      }
      d.append(ul);
    }
    return d;
  };
  box.append(txRow('Funding', `−${sats(entry.budget)}`, entry.fundTxid, 'From your wallet into your channel'));
  if (entry.close) {
    const title = entry.close.kind === 'refund' ? 'Refund' : 'Settlement';
    box.append(txRow(title, `+${sats(entry.close.back)}`, entry.close.txid, `Paid for listening: ${sats(entry.budget - entry.close.back)}`, entry.close.rows));
  } else if (entry.closeTxid) {
    box.append(txRow('Settlement', '', entry.closeTxid, 'Details not available yet — open the link to see it on the blockchain.'));
  }
  return box;
}

function loadHistory() { try { return JSON.parse(localStorage.getItem(HISTORY) || '[]'); } catch { return []; } }
function renderHistory() {
  const list = loadHistory(), ul = $('#historylist');
  $('#history').hidden = list.length === 0;
  ul.innerHTML = '';
  for (const e of list) {
    const li = document.createElement('li');
    const when = document.createElement('div'); when.className = 'when';
    when.textContent = new Date(e.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    li.append(when, receiptEl(e)); ul.append(li);
  }
}

async function showReceipt(kind, txid) {
  const s = state.session;
  const entry = { at: Date.now(), sessionId: s.id, fundTxid: s.funding.txid, budget: s.funding.satoshis, closeTxid: txid };
  $('#receipt').replaceChildren(receiptEl(entry));
  try { entry.close = await readClose(kind, txid); } catch (e) { console.warn('receipt:', e.message); }
  $('#receipt').replaceChildren(receiptEl(entry));
  try {
    const list = loadHistory().filter((x) => x.sessionId !== s.id);
    localStorage.setItem(HISTORY, JSON.stringify([entry, ...list].slice(0, 50)));
  } catch { /* storage unavailable */ }
  renderHistory();
}

function showWaiting(s) {
  const left = s.refundableFrom - s.height;
  $('#waitmsg').textContent = left > 0
    ? `It comes back to your wallet on its own from block ${s.refundableFrom.toLocaleString()} (about ${Math.ceil(left * BLOCK_MINUTES / 60)} h).`
    : 'It can be returned to your wallet now.';
  $('#refundnow').hidden = left > 0;
  step('waiting');
}

// ---------- player ----------
// After the payment the player restarts loading where it stopped (while the listener was in the wallet it may have
// given up on the unpaid key). Phones refuse to start audio that no tap started, so if play() is refused the
// listener gets one big button instead of silence.
function continuePlayback() {
  const a = $('#audio');
  state.hls?.startLoad(a.currentTime);
  a.play().then(() => { $('#continue').hidden = true; }).catch(() => { $('#continue').hidden = false; });
}
function play(track, autoplay = true) {
  state.track = track;
  state.hls?.destroy();
  const hls = new Hls({
    maxBufferLength: 8, maxMaxBufferLength: 10,           // don't fetch keys far ahead of what is heard
    keyLoadPolicy: { default: { maxTimeToFirstByteMs: 8000, maxLoadTimeMs: 20000,
      timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 },
      errorRetry: { maxNumRetry: 8, retryDelayMs: 1500, maxRetryDelayMs: 4000 } } },
    xhrSetup(xhr, url) {
      if (url.includes('/k/') && state.session?.status === 'funded') {
        xhr.setRequestHeader('authorization', `Bearer ${state.session.token}`);
        xhr.setRequestHeader('x-cashcast-session', state.session.id);
      }
    },
  });
  hls.loadSource(`/media/${track.trackId}/index.m3u8`);
  hls.attachMedia($('#audio'));
  hls.on(Hls.Events.FRAG_CHANGED, () => ensureCredits().catch(showError));
  hls.on(Hls.Events.KEY_LOADED, (_, { frag }) => {
    if (frag?.sn >= state.config.freeSegments) {
      state.bought.add(`${track.trackId}/${frag.sn}`);
      if (state.trust) { state.trust.keys = [...state.bought]; save(); }
    }
    ensureCredits().catch(showError);
  });
  hls.on(Hls.Events.ERROR, (_, data) => {
    // A fatal network error (e.g. key retries used up while the listener was approving) stops loading for good;
    // once the channel is funded, start again from where playback is.
    if (data.fatal && data.type === Hls.ErrorTypes.NETWORK_ERROR && state.session?.status === 'funded') {
      ensureCredits().then(() => state.hls?.startLoad($('#audio').currentTime)).catch(showError);
      return;
    }
    if (data.details !== Hls.ErrorDetails.KEY_LOAD_ERROR) return;
    // The player buffers ahead, so this happens before the free preview is over: keep playing
    // what is buffered; playback simply waits at the first unpaid segment. (The wallet nudge is
    // shown by the timeupdate handler when the preview actually ends, not here.)
    if (state.session?.status === 'funded') ensureCredits().then(() => state.hls?.startLoad()).catch(showError);
  });
  state.hls = hls;
  $('#title').textContent = track.title;
  $('#artist').textContent = track.artist;
  $('#license').href = /^https:\/\//.test(track.license) ? track.license : '#';
  $('#dur').textContent = fmtTime(track.durationSeconds);
  $('#freezone').style.width = `${Math.min(100, (state.config.freeSegments * 4 / track.durationSeconds) * 100)}%`;
  renderTracks();
  renderProgress();
  if (autoplay) $('#audio').play().catch(() => {});
}

function renderTracks() {
  const list = $('#tracks');
  list.innerHTML = '';
  state.catalog.forEach((t, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.className = t === state.track ? 'track on' : 'track';
    b.innerHTML = '<span class="n"></span><span class="t"><span class="tt"></span><span class="a"></span></span><span class="d"></span>';
    b.querySelector('.n').textContent = t === state.track ? '♪' : String(i + 1);
    b.querySelector('.tt').textContent = t.title;
    b.querySelector('.a').textContent = t.artist;
    b.querySelector('.d').textContent = fmtTime(t.durationSeconds);
    b.onclick = () => play(t);
    li.append(b); list.append(li);
  });
}

function renderProgress() {
  const a = $('#audio'), t = state.track;
  if (!t) return;
  const d = t.durationSeconds;
  $('#cur').textContent = fmtTime(a.currentTime);
  $('#pos').style.width = `${(a.currentTime / d) * 100}%`;
  // Paid-ahead zone: from the end of the free minute to the last key this session can unlock here.
  const s = state.session, free = state.config.freeSegments * 4;
  if (s?.status === 'funded') {
    const boughtHere = [...state.bought].filter((k) => k.startsWith(`${t.trackId}/`)).length;
    const spare = Math.max(0, s.credits - Math.max(s.used, state.bought.size));
    const end = Math.min(d, free + (boughtHere + spare) * 4);
    $('#paidzone').style.left = `${(free / d) * 100}%`;
    $('#paidzone').style.width = `${Math.max(0, (end - free) / d) * 100}%`;
  } else $('#paidzone').style.width = '0';
}

// Seconds of paid audio actually heard, counted from real playback (seeks and the free minute
// don't count). Drives the live meter: Used goes up and Left goes down every second.
let lastPos = null;
function countHeard() {
  const a = $('#audio'), pos = a.currentTime, prev = lastPos;
  lastPos = pos;
  const T = state.trust;
  if (!T || state.session?.status !== 'funded' || a.paused || prev === null) return;
  const d = pos - prev;
  if (d > 0 && d < 1.5 && pos > state.config.freeSegments * 4) {
    const before = Math.floor(T.heard || 0);
    T.heard = (T.heard || 0) + d;
    if (Math.floor(T.heard) !== before) save();
  }
}

const cents = (sats) => state.config?.usdPerBch ? `${((sats / 1e8) * state.config.usdPerBch * 100).toFixed(2)}¢` : '';

function renderMeter() {
  const s = state.session;
  if (!s || s.status !== 'funded') return;
  const T = state.trust || { budget: s.funding.satoshis, signed: s.paidAmount, price: s.priceSatsPerSegment };
  const perSecond = T.price / 4;
  // What was heard, never more than what was signed. (The signed total runs ~20 s ahead.)
  const used = Math.min(T.signed, Math.round(Math.floor(T.heard || 0) * perSecond));
  const a = $('#audio'), inFree = a.currentTime < state.config.freeSegments * 4;
  const ticking = !a.paused && !inFree;
  $('#livedot').classList.toggle('on', ticking);
  $('#livestate').textContent = a.paused ? 'Paused' : inFree ? 'Free preview · nothing used' : `Playing · ${Math.round(perSecond)} sats / second`;
  $('#approved').textContent = money(T.budget);
  $('#used').textContent = used.toLocaleString();
  $('#usedc').textContent = cents(used);
  $('#left').textContent = (T.budget - used).toLocaleString();
  $('#leftc').textContent = cents(T.budget - used);
  $('#spent').textContent = `${T.signed.toLocaleString()} sats`;
  $('#gauge').style.width = `${Math.min(100, (used / T.budget) * 100)}%`;
  $('#fundtx').href = EXPLORER + s.funding.txid;
  renderProgress();
}

function renderChips() {
  const c = state.config, box = $('#chips');
  const options = c.usdPerBch
    ? [10, 25, 50].map((cents) => ({ sats: satsForCents(cents), label: `${cents}¢` }))
    : [20_000, 50_000, 100_000].map((sats) => ({ sats, label: `${sats / 1000}k` }));
  const usable = options.filter((o) => o.sats >= c.minFunding && o.sats <= c.maxSpend);
  box.innerHTML = '';
  for (const o of usable) {
    const b = document.createElement('button');
    b.innerHTML = `${o.label}<small>${o.sats.toLocaleString()} sats</small>`;
    b.onclick = () => { state.budget = o.sats; for (const x of box.children) x.classList.toggle('on', x === b); };
    box.append(b);
  }
  box.children[0]?.click();
}

// ---------- wallet flow ----------
// Phones: the wallet app is usually on the same device, so the QR code is useless there. Lead with the app link,
// offer the link to copy (for wallets that paste a WizardConnect link), and explain the computer-and-scan fallback
// when the user comes back from the wallet and nothing has connected.
const isPhone = () => /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || matchMedia('(pointer: coarse) and (max-width: 820px)').matches;
let pairHelpTimer = null;
function setupPairing() {
  const box = $('[data-step=pair]');
  const phone = isPhone();
  box.classList.toggle('phone', phone);
  box.classList.remove('showqr');
  $('#pairhead').textContent = phone ? 'Connect your wallet app' : 'Scan with your wallet';
  $('#walletlink').textContent = phone ? 'Open my wallet app' : 'Open wallet on this device';
  $('#copylink').textContent = 'Copy connection link';
  $('#pairhelp').hidden = true;
  clearTimeout(pairHelpTimer);
  pairHelpTimer = setTimeout(() => { if (!box.hidden) $('#pairhelp').hidden = false; }, phone ? 15_000 : 45_000);
}
function initPairingHelp() {
  $('#showqr').onclick = () => $('[data-step=pair]').classList.add('showqr');
  $('#copylink').onclick = async () => {
    const link = $('#walletlink').href;
    if (!link) return;
    try { await navigator.clipboard.writeText(link); $('#copylink').textContent = 'Copied. Paste it in your wallet'; }
    catch { window.prompt('Copy this link and paste it in your wallet:', link); }
    $('#pairhelp').hidden = false;
  };
  // Back from the wallet app and still not connected: show the other ways after a short grace period.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || $('[data-step=pair]').hidden) return;
    clearTimeout(pairHelpTimer);
    pairHelpTimer = setTimeout(() => { if (!$('[data-step=pair]').hidden) $('#pairhelp').hidden = false; }, 8_000);
  });
}
async function connectWallet() {
  if (state.connecting) return;
  state.connecting = true;
  showError('');
  try {
    if (state.config.dev) {
      state.wallet = { walletName: 'dev wallet', refundAddress: $('#listener').value.trim() };
    } else {
      const w = await walletLib();
      if (w.rememberedWallet()) {
        state.wallet = w.reconnect((st) => { $('#relaystatus').textContent = st || ''; });
      } else {
        step('pair');
        setupPairing();
        $('#relaystatus').textContent = 'connecting…';
        state.wallet = await w.connect($('#qr'), $('#walletlink'),
          (st) => { $('#relaystatus').textContent = st === 'connected' ? 'waiting for your wallet…' : (st || ''); });
      }
    }
    $('#walletname').textContent = state.wallet.walletName || 'your wallet';
    $('#refund').textContent = state.wallet.refundAddress;
    renderChips();
    step('approve');
    prepare();
  } catch (e) { if (e.name !== 'AbortError') showError(e); step('free'); }
  finally { state.connecting = false; }
}

// Reuse an unfunded session only if it belongs to this wallet and its timeout is still
// comfortably far away; otherwise start a new one.
async function ensureSession(ownPkh) {
  const { estimatedHeight } = await verifyLib();
  const fresh = state.config.dev || (state.session && state.session.params.timeout - estimatedHeight() > 100);
  const reusable = state.session?.status === 'open' && state.session.params.userPkh === ownPkh && state.trust && fresh;
  if (!reusable) {
    await startSession(state.wallet.refundAddress);
    state.trust = { budget: state.budget, price: state.config.priceSatsPerSegment, signed: 0, heard: 0, keys: [], address: null };
  }
}

// While the listener picks a budget, open the session and look up the wallet's coins, so that
// "Approve" goes straight to the wallet. Errors are ignored here; approve() simply retries.
function prepare() {
  state.coins = null;
  state.prepared = (async () => {
    await ensureSession(await ownRefundPkh());
    if (!state.config.dev) state.coins = { at: Date.now(), list: await (await walletLib()).loadCoins(api) };
  })();
  state.prepared.catch((e) => console.warn('prepare:', e.message));
}

// One approval at a time: a double click must never open two sessions or sign twice.
async function ownRefundPkh() {
  if (!state.config.dev) return (await walletLib()).refundPkh();
  const { decodeCashAddress, binToHex } = await lib();
  const d = decodeCashAddress(state.wallet.refundAddress);
  if (typeof d === 'string') throw new Error('Dev mode: enter a valid refund address');
  return binToHex(d.payload);
}

async function approve() {
  if (state.approving) return;
  state.approving = true;
  const btn = $('#approve'); btn.disabled = true; btn.textContent = 'Approving…';
  showError('');
  try {
    await state.prepared?.catch(() => {}); // a background preparation still running: let it finish
    const ownPkh = await ownRefundPkh();
    await ensureSession(ownPkh);
    // A phone wallet still holding an earlier request for this session may pay it: wait for that payment (with its
    // own budget) instead of asking a second time. The marker is only ever set on phones.
    if (state.session.status === 'open' && state.trust?.signRequestedAt && Date.now() - state.trust.signRequestedAt < SIGN_WINDOW_MS) {
      $('.panel').classList.remove('nudge');
      state.approving = false;
      await waitForWalletPayment();
      return;
    }
    // A funding already signed for this session keeps its amount, whatever chip is selected now.
    const satoshis = state.session.signedHex ? state.trust.budget : (state.trust.budget = state.budget);
    const { secp256k1 } = await lib();
    (await verifyLib()).checkChannel({ session: state.session, ownPkh, satoshis, dev: state.config.dev,
      ownSessionPk: toHex(secp256k1.derivePublicKeyCompressed(state.sessionKey)) });
    state.trust.address = state.session.address; // the wallet pays exactly this checked address
    save();
    $('#signamount').textContent = `${money(satoshis)} (${satoshis.toLocaleString()} sats)`;
    const phone = isPhone();
    $('#fundstep').textContent = phone ? 'Sending the request to your wallet… stay on this page' : 'Check your wallet';
    $('#signhint').hidden = true;
    step('signing');
    let unconfirmedSpent = false; // phone: the node says the inputs are spent, which may be the wallet's own broadcast
    if ((await refreshSession()).status !== 'funded') {
      if (state.config.dev) {
        await api('/api/dev/fund', { method: 'POST', body: { address: state.trust.address, satoshis } });
      } else {
        // A funding signed earlier for this session is re-sent, never signed a second time.
        if (!state.session.signedHex) {
          state.signAbort = new AbortController();
          // Coins looked up in the background are used if they are recent; otherwise they are fetched now.
          const coins = state.coins && Date.now() - state.coins.at < 120_000 ? state.coins.list : undefined;
          state.coins = null;
          const onSent = () => {
            $('#fundstep').textContent = phone ? 'Now open your wallet app to approve' : 'Check your wallet';
            // Phones: the wallet broadcasts, so a reload while it decides must wait for that payment, not ask twice.
            if (phone) { $('#signhint').hidden = false; state.trust.signRequestedAt = Date.now(); save(); }
          };
          const signed = await (await walletLib()).fund({ contractAddress: state.trust.address, satoshis, api, signal: state.signAbort.signal, coins, onSent, walletBroadcasts: phone });
          state.session.signedHex = signed.hex; delete state.trust.signRequestedAt; save();
        }
        $('#fundstep').textContent = 'Sending…';
        try {
          await api('/api/broadcast', { method: 'POST', body: { hex: state.session.signedHex } });
        } catch (e) {
          // Already known or already mined: fine, keep waiting. Anything that means it can never
          // confirm (coins spent elsewhere, invalid): forget it so the next approval signs afresh.
          if (/missingorspent|missing inputs|txn-mempool-conflict/i.test(e.message)) {
            // Spent inputs can mean the payment is already out: on phones the wallet broadcasts it itself.
            const status = (await refreshSession().catch(() => ({}))).status;
            if (status !== 'funded' && !phone) {
              delete state.session.signedHex; save();
              throw new Error(`The payment could not be sent (${e.message}). Nothing was spent; please approve again.`);
            }
            if (status !== 'funded') unconfirmedSpent = true; // phone: wait below, never claim nothing was spent
          } else if (/mandatory-script-verify|non-mandatory|bad-txns|dust|insufficient/i.test(e.message)) {
            // Invalid: it can never confirm, and a wallet's own broadcast of it would have failed the same way.
            delete state.session.signedHex; save();
            throw new Error(`The payment could not be sent (${e.message}). Nothing was spent; please approve again.`);
          }
          console.warn('broadcast:', e.message); // unclear (timeout, proxy error): it may have gone through; keep waiting
        }
      }
      $('#fundstep').textContent = 'Waiting for the network…';
      try { await waitForFunding(); } catch (err) {
        if (unconfirmedSpent && err.name !== 'AbortError') {
          delete state.session.signedHex; save();
          throw new Error('Could not confirm the payment yet. Check your wallet before approving again.');
        }
        throw err;
      }
    }
    step('funded');
    $('.panel').classList.remove('nudge');
    await ensureCredits();
    renderMeter();
    continuePlayback();
  } catch (e) {
    const phone = isPhone(); // the try block's `phone` is not in scope here
    const walletAnswered = e.name === 'AbortError' || /did not sign|reject|declin|denied|cancel/i.test(e.message || '');
    // Keep the phone marker unless the wallet answered or the listener cancelled: the wallet may still pay, and
    // the marker makes a reload (or the next Approve) wait for that payment instead of asking twice.
    if (state.trust?.signRequestedAt && walletAnswered) { delete state.trust.signRequestedAt; save(); }
    const mayHavePaid = phone ? ' If your wallet already sent the payment, reload in a minute.' : '';
    showError(e.name === 'AbortError' ? `Cancelled.${mayHavePaid}` : e); step('approve');
  }
  finally { state.approving = false; state.signAbort = null; btn.disabled = false; btn.textContent = 'Approve'; }
}

// ---------- start ----------
async function resume() {
  const saved = loadSaved();
  if (!saved) return;
  state.sessionKey = fromHex(saved.sessionKey); delete saved.sessionKey;
  const savedTrust = saved.trust; delete saved.trust;
  state.session = saved;
  state.trust = savedTrust || null; // restore before anything saves
  try { await refreshSession(); } catch (e) {
    if (e.status === 401 || e.status === 404) { state.session = null; save(); }
    return; // transient error: keep the session for the next visit
  }
  const s = state.session;
  // Keys bought before the reload are remembered, so replaying them is not paid for twice.
  state.bought = new Set(state.trust?.keys || []);
  if (s.status === 'funded' && state.trust && s.height < s.params.timeout - 12) {
    if (state.trust.signRequestedAt) { delete state.trust.signRequestedAt; save(); }
    step('funded'); renderMeter(); $('#continue').hidden = false; return;
  }
  if (['funded', 'expired', 'closed', 'settling'].includes(s.status)) { showWaiting(s); return; }
  if (s.status === 'open' && state.trust?.signRequestedAt && Date.now() - state.trust.signRequestedAt < SIGN_WINDOW_MS) {
    // The page was reloaded (phones discard background tabs) while the wallet still had the payment request.
    // Asking again could pay twice, so wait for the wallet's own broadcast instead.
    waitForWalletPayment();
    return;
  }
  if (s.status === 'open') return; // never funded: the next approval reuses it
  state.session = null; save();       // settled or refunded: done
}

async function init() {
  [state.config, state.catalog] = await Promise.all([api('/api/config'), api('/api/catalog')]);
  const c = state.config;
  // The rate shown is computed from the price actually charged per 4-second segment.
  const perMinute = c.priceSatsPerSegment * 15;
  const freeSec = c.freeSegments * 4;
  const free = freeSec % 60 === 0 ? `first ${freeSec === 60 ? 'minute' : `${freeSec / 60} minutes`}` : `first ${freeSec} seconds`;
  $('#rate').textContent = `${c.usdPerBch ? money(perMinute) : `${perMinute.toLocaleString()} sats`} / minute · ${free} free`;
  $('#freehead').textContent = `The ${free} ${freeSec === 60 ? 'is' : 'are'} free.`;
  $('#listener').hidden = !c.dev;
  $('#autosettle').textContent = c.autoSettle ? 'settles on its own after 10 idle minutes' : 'press Stop & settle when you are done';
  if (state.catalog[0]) play(state.catalog[0], false);
  renderHistory();
  await resume();

  const a = $('#audio');
  $('#playbtn').onclick = () => (a.paused ? a.play() : a.pause());
  $('#continue').onclick = () => { a.play().catch(showError); };
  a.addEventListener('playing', () => { $('#continue').hidden = true; });
  a.addEventListener('play', () => { $('#playbtn').classList.add('on'); $('#playbtn').ariaLabel = 'Pause'; });
  // While the free minute plays, quietly load the wallet code so "Connect wallet" is instant.
  a.addEventListener('playing', () => setTimeout(() => { walletLib(); verifyLib(); lib(); }, 3000), { once: true });
  a.addEventListener('pause', () => { $('#playbtn').classList.remove('on'); $('#playbtn').ariaLabel = 'Play'; lastPos = null; renderMeter(); });
  a.addEventListener('timeupdate', () => {
    // The free preview is over and nothing is funded yet: point at the wallet step.
    if (!$('[data-step=free]').hidden && a.currentTime >= state.config.freeSegments * 4 - 0.5) {
      $('.panel').classList.add('nudge');
      $('#freehead').textContent = 'The free preview is over.';
    }
    countHeard(); if (state.session?.status === 'funded') renderMeter(); else renderProgress(); });
  a.addEventListener('seeking', () => { lastPos = null; });
  a.addEventListener('ended', () => {
    const i = state.catalog.indexOf(state.track);
    if (state.catalog[i + 1]) play(state.catalog[i + 1]);
  });
  $('#bar').onclick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    a.currentTime = ((e.clientX - r.left) / r.width) * state.track.durationSeconds;
  };
  $('#connect').onclick = connectWallet;
  $('#approve').onclick = approve;
  $('#stop').onclick = $('#stop2').onclick = () => settle().catch(showError);
  $('#disconnect').onclick = async (e) => {
    e.preventDefault();
    $('#disconnect').hidden = true;
    $('#disconnectmsg').textContent = 'Disconnecting…';
    await (await walletLib()).disconnectWallet();
    state.wallet = null;
    $('#disconnectmsg').textContent = 'Wallet disconnected. You can also delete any old CashCast entries in your wallet.';
  };
  $('#again').onclick = () => { state.session = null; state.trust = null; state.bought.clear(); save(); if (state.wallet) { renderChips(); step('approve'); prepare(); } else step('free'); };
  $('#dismiss').onclick = () => { state.session = null; state.trust = null; save(); step('free'); };
  $('#refundnow').onclick = async () => {
    try {
      const r = await api(`/api/sessions/${state.session.id}/refund`, { method: 'POST' });
      $('#paidtotal').textContent = money(0); $('#returned').textContent = 'everything';
      step('settled');
      merge(r); await showReceipt('refund', r.refundTxid);
      state.session = null; save();
    } catch (e) { showError(e); }
  };
  initPairingHelp();
  $('#cancelpair').onclick = async (e) => { e.preventDefault(); (await walletLib()).cancelPairing(); step('free'); };
  $('#cancelsign').onclick = (e) => { e.preventDefault(); state.signAbort?.abort(); state.cancelWait = true; };
  $('#switchwallet').onclick = async (e) => { e.preventDefault(); await (await walletLib()).forgetWallet(); state.wallet = null; step('free'); connectWallet(); };
}

init().catch(showError);
