// A Bitcoin Cash network provider that fails over between several public Fulcrum servers.
// One stalled connection must never hang the app: every call has a short timeout and moves on
// to the next server. A broadcast that a node actively rejects is not retried elsewhere.
import { ElectrumNetworkProvider } from 'cashscript';

export const MAINNET_SERVERS = [
  'bch.imaginary.cash', 'electroncash.dk', 'fulcrum.greyh.at', 'bch.soul-dev.com',
  'blackie.c3-soft.com', 'electrum.imaginary.cash', 'bch.loping.net', 'fulcrum.jettscythe.xyz',
];

const TIMEOUT = Symbol('timeout');
function withTimeout(promise, ms) {
  let t;
  return Promise.race([promise, new Promise((_, reject) => { t = setTimeout(() => reject(Object.assign(new Error(`no answer within ${ms} ms`), { [TIMEOUT]: true })), ms); })])
    .finally(() => clearTimeout(t));
}
// Connection trouble (try another server) versus a real answer such as a rejected transaction.
const isRejection = (m) => /rejected|decode failed|missing|conflict|bad-txn|mandatory|non-final|dust|insufficient|already/i.test(m);
const isConnectionError = (e) => {
  const m = e?.message || '';
  if (isRejection(m)) return false;
  return Boolean(e?.[TIMEOUT]) || /timed out|timeout|ECONN|ENOTFOUND|EAI_AGAIN|socket|disconnect|connection|closed/i.test(m);
};

export class FailoverProvider {
  constructor(network = 'mainnet', hosts = MAINNET_SERVERS, { timeoutMs = 8_000, log = () => {} } = {}) {
    this.network = network;
    this.providers = hosts.map((hostname) => ({ hostname, p: new ElectrumNetworkProvider(network, { hostname }) }));
    this.current = 0;
    this.timeoutMs = timeoutMs;
    this.log = log;
  }

  async call(method, args) {
    let last;
    for (let k = 0; k < this.providers.length; k++) {
      const i = (this.current + k) % this.providers.length;
      const { hostname, p } = this.providers[i];
      try {
        const result = await withTimeout(p[method](...args), this.timeoutMs);
        if (i !== this.current) { this.log(`chain: switched to ${hostname}`); this.current = i; }
        return result;
      } catch (e) {
        if (!isConnectionError(e)) throw e; // a real answer (e.g. a rejected transaction)
        last = e;
        this.log(`chain: ${hostname} failed (${e.message}); trying the next server`);
      }
    }
    throw last;
  }

  // Ask every server for the block height at once and make the first to answer the current one.
  async warmUp() {
    try {
      const i = await Promise.any(this.providers.map(({ p }, n) => withTimeout(p.getBlockHeight(), this.timeoutMs).then(() => n)));
      if (i !== this.current) { this.log(`chain: using ${this.providers[i].hostname} (answered first)`); this.current = i; }
    } catch { this.log('chain: no server answered the warm-up'); }
  }

  getUtxos(address) { return this.call('getUtxos', [address]); }
  getUtxosForLockingBytecode(bytecode) { return this.call('getUtxosForLockingBytecode', [bytecode]); }
  getBlockHeight() { return this.call('getBlockHeight', []); }
  getRawTransaction(txid) { return this.call('getRawTransaction', [txid]); }
  sendRawTransaction(hex) { return this.call('sendRawTransaction', [hex]); }
}
