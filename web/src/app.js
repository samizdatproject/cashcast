// CashCast player. Plays the free first minute at once; after that a throwaway session key in this
// browser signs a growing total, and the server sells one segment key per credit.
import Hls from 'hls.js/dist/hls.light.mjs';
// Crypto and wallet code load only when the listener decides to pay, so the free minute starts fast.
const lib = () => import('@bitauth/libauth');
const walletLib = () => import('./wallet.js');
const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => Uint8Array.from(h.match(/../g) || [], (x) => parseInt(x, 16));

const $ = (sel) => document.querySelector(sel);
const AHEAD = 5;                 // keys paid for ahead of the playing segment (≈20 s)
const STORE = 'cashcast-session';

const state = { config: null, catalog: [], track: null, hls: null, session: null, sessionKey: null, busy: false,
  bought: new Set() }; // paid keys this browser has fetched ("track/segment")

// ---------- helpers ----------
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
  } catch { /* storage unavailable: the session simply won't survive a reload */ }
}
function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (saved && saved.status !== 'settled') { state.sessionKey = fromHex(saved.sessionKey); delete saved.sessionKey; state.session = saved; }
  } catch { /* ignore */ }
}
const u32le = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const u64le = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
function payMessage(txid, vout, amount) {
  const parts = [new TextEncoder().encode('CC01'), fromHex(txid).reverse(), u32le(vout), u64le(amount)];
  const out = new Uint8Array(48); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const fmtSats = (s) => `${Number(s).toLocaleString()} sats`;
const fmtTime = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

// ---------- payments ----------
// Keep `AHEAD` paid keys in hand. The signed total is the only thing that ever leaves this key.
async function ensureCredits() {
  const s = state.session;
  if (!s || s.status !== 'funded' || state.busy) return;
  // Keys are fetched by the player directly, so count them here too (the server's `used` lags).
  // Never prepay past the end of the current track.
  const t = state.track;
  const boughtHere = [...state.bought].filter((k) => k.startsWith(`${t.trackId}/`)).length;
  const leftInTrack = Math.max(0, t.keyHashes.length - state.config.freeSegments - boughtHere);
  const target = Math.max(s.used, state.bought.size) + Math.min(AHEAD, leftInTrack);
  if (s.credits >= target) return;
  const amount = Math.min(target * state.config.priceSatsPerSegment, s.funding.satoshis);
  if (amount <= s.paidAmount) { showCard('budget'); return; }
  state.busy = true;
  try {
    const { secp256k1, sha256 } = await lib();
    const msg = payMessage(s.funding.txid, s.funding.vout, amount);
    const sig = toHex(secp256k1.signMessageHashSchnorr(state.sessionKey, sha256.hash(msg)));
    Object.assign(s, await api(`/api/sessions/${s.id}/pay`, { method: 'POST', body: { amount, sig }, auth: true }));
    save(); render();
  } finally { state.busy = false; }
}

async function startSession(listenerAddress) {
  const { generatePrivateKey, secp256k1 } = await lib();
  state.sessionKey = generatePrivateKey();
  const sessionPk = toHex(secp256k1.derivePublicKeyCompressed(state.sessionKey));
  state.session = await api('/api/sessions', { method: 'POST', body: { listenerAddress, sessionPk } });
  state.bought.clear();
  save(); render();
}

async function waitForFunding() {
  for (let i = 0; i < 120; i++) {
    const s = await api(`/api/sessions/${state.session.id}`, { auth: true });
    Object.assign(state.session, s); save(); render();
    if (s.status === 'funded') return;
    await new Promise((r) => setTimeout(r, 2500));
  }
  throw new Error('No payment seen yet. If you paid, wait a moment and reload.');
}

async function stopAndSettle() {
  if (!state.session) return;
  $('#audio').pause();
  const s = await api(`/api/sessions/${state.session.id}/settle`, { method: 'POST', auth: true });
  Object.assign(state.session, s); save(); render(); showCard('settled');
}

// ---------- playback ----------
function play(track) {
  state.track = track;
  if (state.hls) state.hls.destroy();
  const hls = new Hls({
    maxBufferLength: 12, maxMaxBufferLength: 16,          // don't fetch keys far ahead of what is paid
    keyLoadPolicy: { default: { maxTimeToFirstByteMs: 8000, maxLoadTimeMs: 20000,
      timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 },
      errorRetry: { maxNumRetry: 8, retryDelayMs: 1500, maxRetryDelayMs: 4000 } } },
    xhrSetup(xhr, url) {
      if (url.includes('/k/') && state.session) {
        xhr.setRequestHeader('authorization', `Bearer ${state.session.token}`);
        xhr.setRequestHeader('x-cashcast-session', state.session.id);
      }
    },
  });
  hls.loadSource(`/media/${track.trackId}/index.m3u8`);
  hls.attachMedia($('#audio'));
  hls.on(Hls.Events.FRAG_CHANGED, (_, { frag }) => {
    if (frag.sn >= state.config.freeSegments - 4 && state.session?.status !== 'funded') showCard('continue');
    ensureCredits().catch(showError);
  });
  hls.on(Hls.Events.KEY_LOADED, (_, { frag }) => {
    if (frag?.sn >= state.config.freeSegments) state.bought.add(`${track.trackId}/${frag.sn}`);
    ensureCredits().catch(showError);
  });
  hls.on(Hls.Events.ERROR, (_, data) => {
    if (data.details === Hls.ErrorDetails.KEY_LOAD_ERROR) {
      // The player buffers ahead, so this happens before the free minute is over: keep playing
      // what is buffered and offer to continue; playback simply waits at the first unpaid segment.
      if (state.session?.status === 'funded') ensureCredits().then(() => state.hls?.startLoad()).catch(showError);
      else showCard('continue');
    }
  });
  state.hls = hls;
  $('#audio').play().catch(() => { /* autoplay blocked: the user presses play */ });
  render();
}

// ---------- UI ----------
function showError(e) { $('#error').textContent = e.message || String(e); }
function showCard(name) {
  for (const c of document.querySelectorAll('.card')) c.hidden = c.dataset.card !== name;
}

function render() {
  const list = $('#tracks');
  list.innerHTML = '';
  for (const t of state.catalog) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.className = t === state.track ? 'track on' : 'track';
    b.innerHTML = `<span class="t"></span><span class="a"></span><span class="d">${fmtTime(t.durationSeconds)}</span>`;
    b.querySelector('.t').textContent = t.title;
    b.querySelector('.a').textContent = t.artist;
    b.onclick = () => play(t);
    li.append(b); list.append(li);
  }
  const s = state.session, c = state.config;
  $('#now').textContent = state.track ? `${state.track.title} — ${state.track.artist}` : 'Pick a track';
  if (state.track) $('#license').href = state.track.license;
  $('#rate').textContent = `${c.priceSatsPerSegment} sats per 4 seconds · first ${(c.freeSegments * 4) / 60} minute free`;
  if (s?.status === 'funded') {
    const spent = s.paidAmount, budget = s.funding.satoshis;
    $('#meter').hidden = false;
    $('#approved').textContent = fmtSats(budget);
    $('#spent').textContent = fmtSats(spent);
    $('#unspent').textContent = fmtSats(budget - spent);
    $('#fundtx').href = `https://blockchair.com/bitcoin-cash/transaction/${s.funding.txid}`;
  } else $('#meter').hidden = true;
  if (s?.settleTxid) {
    $('#settletx').href = `https://blockchair.com/bitcoin-cash/transaction/${s.settleTxid}`;
    $('#returned').textContent = fmtSats(s.funding.satoshis - s.paidAmount);
  }
}

async function init() {
  [state.config, state.catalog] = await Promise.all([api('/api/config'), api('/api/catalog')]);
  restore();
  render();
  if (state.catalog[0]) play(state.catalog[0]);

  // Step 1: pair the wallet (QR code). Step 2: approve the budget (one signature in the wallet).
  $('#connect').onclick = async () => {
    if (state.connecting) return;
    state.connecting = true;
    try {
      showError('');
      if (state.config.dev) { state.wallet = { walletName: 'dev', refundAddress: $('#listener').value.trim() }; showCard('approve'); return; }
      const w = await walletLib();
      showCard('pair');
      state.wallet = await w.connect($('#qr'), $('#walletlink'), (st) => { $("#relaystatus").textContent = `relay ${st?.status || st}`; });
      $('#walletname').textContent = state.wallet.walletName || 'your wallet';
      $('#refund').textContent = state.wallet.refundAddress;
      showCard('approve');
    } catch (e) { showError(e); showCard('continue'); }
    finally { state.connecting = false; }
  };
  // One approval at a time: a double click must never open two sessions or sign twice.
  $('#approve').onclick = async () => {
    if (state.approving) return;
    state.approving = true;
    const btn = $('#approve'); btn.disabled = true; btn.textContent = 'Approving…';
    try {
      showError('');
      const satoshis = Number($('#budget').value);
      if (!state.session) await startSession(state.wallet.refundAddress);
      showCard('funding');
      $('#contract').textContent = state.session.address;
      if (state.config.dev) {
        await api('/api/dev/fund', { method: 'POST', body: { address: state.session.address, satoshis } });
      } else {
        $('#fundstep').textContent = 'Approve the payment in your wallet…';
        const signed = await (await walletLib()).fund({ contractAddress: state.session.address, satoshis, api });
        $('#fundstep').textContent = 'Sending…';
        // If sending fails (e.g. the wallet already broadcast it), the payment may still have
        // arrived; waitForFunding below finds out either way.
        await api('/api/broadcast', { method: 'POST', body: { hex: signed.hex } }).catch((e) => console.warn('broadcast:', e.message));
      }
      $('#fundstep').textContent = 'Waiting for the network…';
      await waitForFunding();
      showCard('none');
      await ensureCredits();
      $('#audio').play().catch(() => {});
      state.hls?.startLoad();
    } catch (e) { showError(e); showCard('approve'); }
    finally { state.approving = false; btn.disabled = false; btn.textContent = 'Approve budget'; }
  };
  $('#early').onclick = (e) => { e.preventDefault(); if (state.session?.status !== 'funded') showCard('continue'); };
  $('#stop').onclick = () => stopAndSettle().catch(showError);
  $('#new').onclick = () => { state.session = null; state.bought.clear(); save(); showCard('none'); render(); };
  $('#listener').hidden = !state.config.dev;
  if (state.session?.status === 'funded') showCard('none');
}

init().catch(showError);
