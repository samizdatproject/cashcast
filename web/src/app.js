// CashCast player. The free first minute plays at once; after that a throwaway session key in
// this browser signs a growing total, and the server sells one segment key per credit.
import Hls from 'hls.js/dist/hls.light.mjs';

// Crypto and wallet code load only when the listener decides to pay, so the free minute starts fast.
const lib = () => import('@bitauth/libauth');
const walletLib = () => import('./wallet.js');
const verifyLib = () => import('./verify.js');

const $ = (sel) => document.querySelector(sel);
const AHEAD = 5;                  // keys paid for ahead of the playing segment (≈20 s)
const STORE = 'cashcast-session';
const CLOSE_FEE_SATS = 700;       // when stopping before any paid key: covers the settlement fee so the rest returns now
const EXPLORER = 'https://blockchair.com/bitcoin-cash/transaction/';
const BLOCK_MINUTES = 10;

const state = {
  config: null, catalog: [], track: null, hls: null,
  session: null, sessionKey: null, wallet: null, budget: 0,
  bought: new Set(),              // paid keys this browser has fetched ("track/segment")
  busy: false, approving: false, connecting: false, signAbort: null,
};

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
    if (state.session) localStorage.setItem(STORE, JSON.stringify({ ...state.session, sessionKey: toHex(state.sessionKey) }));
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
}
function showError(e) { $('#error').textContent = e ? (e.message || String(e)) : ''; }

// ---------- payments ----------
// The price per segment is pinned in this browser when the listener approves; the server can
// never raise it. The number of keys to pay for is counted here too, so a lying server cannot
// make the browser sign away more than ~5 segments ahead.
function pinnedPrice() {
  const s = state.session;
  const pinned = s.pinnedPrice || state.config.priceSatsPerSegment;
  if (s.priceSatsPerSegment && s.priceSatsPerSegment > pinned) throw new Error('The server asked for a higher price than you approved; payments stopped.');
  return pinned;
}

async function signTotal(amount) {
  const s = state.session;
  const { secp256k1, sha256 } = await lib();
  const sig = toHex(secp256k1.signMessageHashSchnorr(state.sessionKey, sha256.hash(payMessage(s.funding.txid, s.funding.vout, amount))));
  Object.assign(s, await api(`/api/sessions/${s.id}/pay`, { method: 'POST', body: { amount, sig }, auth: true }));
  save();
}

// Keep `AHEAD` paid keys in hand, never past the end of the current track.
async function ensureCredits() {
  const s = state.session;
  if (!s || s.status !== 'funded' || state.busy) return;
  const price = pinnedPrice();
  const t = state.track;
  const boughtHere = [...state.bought].filter((k) => k.startsWith(`${t.trackId}/`)).length;
  const leftInTrack = Math.max(0, t.keyHashes.length - state.config.freeSegments - boughtHere);
  const paidCredits = Math.floor(s.paidAmount / price);
  // Keys used so far: our own count, or the server's (after a reload) but never more than we paid for.
  const used = Math.max(state.bought.size, Math.min(s.used || 0, paidCredits));
  const target = used + Math.min(AHEAD, leftInTrack);
  if (paidCredits >= target) return;
  const cap = Math.min(s.funding.satoshis, state.budgetCap || Infinity, state.config.maxSpend);
  const amount = Math.min(target, Math.floor(cap / price)) * price;
  if (amount <= s.paidAmount) { step('budget'); return; }
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
  Object.assign(state.session, await api(`/api/sessions/${state.session.id}`, { auth: true }));
  save();
  return state.session;
}

async function waitForFunding() {
  for (let i = 0; i < 150; i++) {
    if ((await refreshSession()).status === 'funded') return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('No payment seen yet. If your wallet sent it, reload in a minute.');
}

async function settle() {
  $('#audio').pause();
  // Stopped before any paid key: sign just the settlement fee so the rest comes back now,
  // instead of after the ~1 day timeout.
  if (state.session.status === 'funded' && state.session.paidAmount === 0 && state.session.funding.satoshis > CLOSE_FEE_SATS + 546) {
    await signTotal(CLOSE_FEE_SATS);
  }
  const s = await api(`/api/sessions/${state.session.id}/settle`, { method: 'POST', auth: true });
  Object.assign(state.session, s); save();
  if (s.status === 'settled') {
    $('#paidtotal').textContent = money(s.paidAmount);
    $('#returned').textContent = money(s.funding.satoshis - s.paidAmount);
    $('#settletx').href = EXPLORER + s.settleTxid;
    step('settled');
  } else {
    showWaiting(s);
  }
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
function play(track, autoplay = true) {
  state.track = track;
  state.hls?.destroy();
  const hls = new Hls({
    maxBufferLength: 12, maxMaxBufferLength: 16,          // don't fetch keys far ahead of what is paid
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
    if (frag?.sn >= state.config.freeSegments) state.bought.add(`${track.trackId}/${frag.sn}`);
    ensureCredits().catch(showError);
  });
  hls.on(Hls.Events.ERROR, (_, data) => {
    if (data.details !== Hls.ErrorDetails.KEY_LOAD_ERROR) return;
    // The player buffers ahead, so this happens before the free minute is over: keep playing
    // what is buffered; playback simply waits at the first unpaid segment.
    if (state.session?.status === 'funded') ensureCredits().then(() => state.hls?.startLoad()).catch(showError);
    else if (state.step === 'free') $('.panel').classList.add('nudge');
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

function renderMeter() {
  const s = state.session;
  if (!s || s.status !== 'funded') return;
  const budget = Math.min(s.funding.satoshis, state.config.maxSpend);
  $('#approved').textContent = money(s.funding.satoshis);
  $('#spent').textContent = money(s.paidAmount);
  $('#unspent').textContent = money(s.funding.satoshis - s.paidAmount);
  $('#gauge').style.width = `${Math.min(100, (s.paidAmount / budget) * 100)}%`;
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
        $('#relaystatus').textContent = 'connecting…';
        state.wallet = await w.connect($('#qr'), $('#walletlink'),
          (st) => { $('#relaystatus').textContent = st === 'connected' ? 'waiting for your wallet…' : (st || ''); });
      }
    }
    $('#walletname').textContent = state.wallet.walletName || 'your wallet';
    $('#refund').textContent = state.wallet.refundAddress;
    renderChips();
    step('approve');
  } catch (e) { if (e.name !== 'AbortError') showError(e); step('free'); }
  finally { state.connecting = false; }
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
    const satoshis = state.budget;
    const ownPkh = await ownRefundPkh();
    // Reuse an unfunded session only if it belongs to this wallet; otherwise start a new one.
    const reusable = state.session?.status === 'open' && state.session.params.userPkh === ownPkh;
    if (!reusable) await startSession(state.wallet.refundAddress);
    state.session.pinnedPrice = state.session.pinnedPrice || state.config.priceSatsPerSegment;
    state.budgetCap = satoshis;
    const { secp256k1 } = await lib();
    (await verifyLib()).checkChannel({ session: state.session, ownPkh, satoshis, dev: state.config.dev,
      ownSessionPk: toHex(secp256k1.derivePublicKeyCompressed(state.sessionKey)) });
    save();
    $('#signamount').textContent = `${money(satoshis)} (${satoshis.toLocaleString()} sats)`;
    $('#fundstep').textContent = 'Check your wallet';
    step('signing');
    if ((await refreshSession()).status !== 'funded') {
      if (state.config.dev) {
        await api('/api/dev/fund', { method: 'POST', body: { address: state.session.address, satoshis } });
      } else {
        // A funding signed earlier for this session is re-sent, never signed a second time.
        if (!state.session.signedHex) {
          state.signAbort = new AbortController();
          const signed = await (await walletLib()).fund({ contractAddress: state.session.address, satoshis, api, signal: state.signAbort.signal });
          state.session.signedHex = signed.hex; save();
        }
        $('#fundstep').textContent = 'Sending…';
        await api('/api/broadcast', { method: 'POST', body: { hex: state.session.signedHex } }).catch((e) => console.warn('broadcast:', e.message));
      }
      $('#fundstep').textContent = 'Waiting for the network…';
      await waitForFunding();
    }
    step('funded');
    $('.panel').classList.remove('nudge');
    await ensureCredits();
    renderMeter();
    $('#audio').play().catch(() => {});
    state.hls?.startLoad();
  } catch (e) { showError(e.name === 'AbortError' ? 'Cancelled.' : e); step('approve'); }
  finally { state.approving = false; state.signAbort = null; btn.disabled = false; btn.textContent = 'Approve'; }
}

// ---------- start ----------
async function resume() {
  const saved = loadSaved();
  if (!saved) return;
  state.sessionKey = fromHex(saved.sessionKey); delete saved.sessionKey;
  state.session = saved;
  try { await refreshSession(); } catch (e) {
    if (e.status === 401 || e.status === 404) { state.session = null; save(); }
    return; // transient error: keep the session for the next visit
  }
  const s = state.session;
  if (s.status === 'funded' && s.height < s.params.timeout - 12) { step('funded'); renderMeter(); return; }
  if (['funded', 'expired', 'closed', 'settling'].includes(s.status)) { showWaiting(s); return; }
  if (s.status === 'open') return; // never funded: the next approval reuses it
  state.session = null; save();       // settled or refunded: done
}

async function init() {
  [state.config, state.catalog] = await Promise.all([api('/api/config'), api('/api/catalog')]);
  const c = state.config;
  $('#rate').textContent = c.centsPerMinute && c.usdPerBch
    ? `${c.centsPerMinute}¢ / minute · first minute free`
    : `${c.priceSatsPerSegment} sats / 4 s · first minute free`;
  $('#listener').hidden = !c.dev;
  if (state.catalog[0]) play(state.catalog[0], false);
  await resume();

  const a = $('#audio');
  $('#playbtn').onclick = () => (a.paused ? a.play() : a.pause());
  a.addEventListener('play', () => { $('#playbtn').classList.add('on'); $('#playbtn').ariaLabel = 'Pause'; });
  a.addEventListener('pause', () => { $('#playbtn').classList.remove('on'); $('#playbtn').ariaLabel = 'Play'; });
  a.addEventListener('timeupdate', renderProgress);
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
  $('#again').onclick = () => { state.session = null; state.bought.clear(); save(); if (state.wallet) { renderChips(); step('approve'); } else step('free'); };
  $('#dismiss').onclick = () => { state.session = null; save(); step('free'); };
  $('#refundnow').onclick = async () => {
    try {
      const r = await api(`/api/sessions/${state.session.id}/refund`, { method: 'POST' });
      state.session = null; save();
      $('#paidtotal').textContent = money(0); $('#returned').textContent = 'everything';
      $('#settletx').href = EXPLORER + r.refundTxid; step('settled');
    } catch (e) { showError(e); }
  };
  $('#cancelpair').onclick = async (e) => { e.preventDefault(); (await walletLib()).cancelPairing(); step('free'); };
  $('#cancelsign').onclick = (e) => { e.preventDefault(); state.signAbort?.abort(); };
  $('#switchwallet').onclick = async (e) => { e.preventDefault(); (await walletLib()).forgetWallet(); state.wallet = null; step('free'); connectWallet(); };
}

init().catch(showError);
