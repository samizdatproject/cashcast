// Keyless refund of a channel after its timeout: sends the whole balance (minus a small fee) back
// to the listener's address. No private key is involved; the contract forces the destination.
//
//   node scripts/refund.mjs <sessionId>          check only (prints what it would do)
//   node scripts/refund.mjs <sessionId> --send   build and broadcast the refund
import { join } from 'node:path';
import { ElectrumNetworkProvider, TransactionBuilder } from 'cashscript';
import { hexToBin, flattenBinArray } from '@bitauth/libauth';
import { openDb } from '../src/db.js';
import { channelContract } from '../src/channel.js';

const [id, flag] = process.argv.slice(2);
if (!id) throw new Error('usage: refund.mjs <sessionId> [--send]');
const root = new URL('..', import.meta.url).pathname;
const db = openDb(join(root, 'cashcast-mainnet.db'));
const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
if (!s) throw new Error(`no session ${id}`);

const provider = new ElectrumNetworkProvider('mainnet');
const providerPk = (await import('@bitauth/libauth')).secp256k1.derivePublicKeyCompressed(
  hexToBin((await import('node:fs')).readFileSync(join(root, 'secrets', 'provider-mainnet.key'), 'utf8').trim()));
const contract = channelContract({ userPkh: s.user_pkh, sessionPk: s.session_pk, providerPk: Buffer.from(providerPk).toString('hex'),
  timeout: s.timeout, maxRefundFee: s.max_refund_fee }, provider);
if (contract.address !== s.address) throw new Error('rebuilt contract address does not match the session');

const height = await provider.getBlockHeight();
const coins = await provider.getUtxos(contract.address);
console.log(`channel ${s.address}\nrefund to ${s.listener_address}\nheight ${height}, refundable from block ${s.timeout + 1}`);
console.log(`coins: ${coins.map((c) => `${c.satoshis} sats`).join(', ') || 'none'}`);
if (height < s.timeout) { console.log(`Not yet: ${s.timeout - height} more blocks (about ${Math.ceil((s.timeout - height) * 10 / 60)} hours).`); process.exit(0); }

const userLock = flattenBinArray([hexToBin('76a914'), hexToBin(s.user_pkh), hexToBin('88ac')]);
for (const coin of coins) {
  if (coin.token) { console.log('skipping a token coin'); continue; }
  const fee = 400n; // a one-output refund is ~330 bytes; must stay ≤ maxRefundFee
  const tx = new TransactionBuilder({ provider })
    .addInput(coin, contract.unlock.refund())
    .addOutput({ to: userLock, amount: coin.satoshis - fee })
    .setLocktime(s.timeout);
  if (flag !== '--send') { console.log(`would return ${coin.satoshis - fee} sats (fee ${fee}). Run again with --send.`); continue; }
  const { txid } = await tx.send();
  console.log(`refunded ${coin.satoshis - fee} sats: ${txid}`);
  db.prepare("UPDATE sessions SET status='refunded' WHERE id=?").run(id);
}
process.exit(0);
