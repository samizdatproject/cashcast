// Everything the server needs to know about the channel contract, in one place.
import { readFileSync } from 'node:fs';
import { Contract, SignatureTemplate, TransactionBuilder } from 'cashscript';
import {
  decodeCashAddress, encodeCashAddress, cashAddressToLockingBytecode, secp256k1, sha256, hexToBin, binToHex, utf8ToBin,
  bigIntToBinUint64LE, numberToBinUint32LE, flattenBinArray,
} from '@bitauth/libauth';

export const artifact = JSON.parse(readFileSync(new URL('../contracts/CashCastChannel.json', import.meta.url)));
export const DUST = 546n;
const TAG = utf8ToBin('CC01');

// The listener's refund address: any P2PKH cashaddr (plain or token-aware) → its 20-byte hash.
export function listenerPkh(address) {
  const d = decodeCashAddress(address);
  if (typeof d === 'string' || !d.type.startsWith('p2pkh') || d.payload.length !== 20) {
    throw new Error('listener address must be a P2PKH Bitcoin Cash address');
  }
  return d.payload;
}

// Output scripts are passed as raw bytecode, so the same code works on mainnet and in tests.
const p2pkhLock = (pkh) => flattenBinArray([hexToBin('76a914'), pkh, hexToBin('88ac')]);
export function lockOf(address) {
  const r = cashAddressToLockingBytecode(address);
  if (typeof r === 'string') throw new Error(r);
  return r.bytecode;
}

export function p2pkhAddress(pkh, prefix = 'bitcoincash') {
  return encodeCashAddress({ prefix, type: 'p2pkh', payload: pkh }).address;
}

export function channelContract(params, provider) {
  return new Contract(artifact, [hexToBin(params.userPkh), hexToBin(params.sessionPk), hexToBin(params.providerPk),
    BigInt(params.timeout), BigInt(params.maxRefundFee)], { provider });
}

// "CC01" ‖ funding txid (internal byte order) ‖ vout (LE) ‖ amount (LE): what the session key signs.
export function payMessage(txid, vout, amount) {
  return flattenBinArray([TAG, hexToBin(txid).reverse(), numberToBinUint32LE(vout), bigIntToBinUint64LE(BigInt(amount))]);
}

export function verifyPayment(sessionPkHex, txid, vout, amount, sigHex) {
  const sig = hexToBin(sigHex);
  if (sig.length !== 64) return false; // Schnorr only
  return secp256k1.verifySignatureSchnorr(sig, hexToBin(sessionPkHex), sha256.hash(payMessage(txid, vout, amount)));
}

// The settle transaction. Output 0 returns the listener's remainder (unless it is dust); the
// provider's share is split between the artist and the platform; the network fee comes out of
// the provider's share. Returns null when the share is too small to settle on its own.
export function buildSettle({ contract, provider, utxo, amount, sigHex, providerKey, userPkh, payouts, feeRate = 1.1 }) {
  const msg = payMessage(utxo.txid, utxo.vout, amount);
  const remainder = utxo.satoshis - BigInt(amount);
  const outputs = [];
  if (remainder >= DUST) outputs.push({ to: p2pkhLock(hexToBin(userPkh)), amount: remainder });
  const make = (outs, u = utxo) => {
    const tx = new TransactionBuilder({ provider })
      .addInput(u, contract.unlock.settle(new SignatureTemplate(providerKey), hexToBin(sigHex), msg));
    for (const o of outs) tx.addOutput(o);
    return tx;
  };
  // Measure the size on a draft with placeholder amounts. The draft spends an inflated copy of the
  // coin so the builder's fee checks pass; amounts do not change the size, and the draft is discarded.
  const sizeOf = (outs) => make(outs, { ...utxo, satoshis: utxo.satoshis + 100_000_000n }).build().length / 2;
  const feeFor = (outs) => BigInt(Math.ceil(sizeOf(outs) * feeRate));
  const share = utxo.satoshis - (remainder >= DUST ? remainder : 0n);
  const fee = feeFor([...outputs, ...payouts.map((p) => ({ to: lockOf(p.address), amount: DUST }))]);
  const total = share - fee;
  if (total < DUST) {
    // Too small to pay anyone: if it still covers the fee, settle anyway so the listener's
    // remainder comes back now instead of after the timeout. The share goes to the network fee.
    return outputs.length && share >= feeFor(outputs) ? make(outputs) : null;
  }
  // Each payout gets its basis points; the last one also gets the rounding remainder.
  const split = payouts.slice(0, -1).map((p) => ({ to: lockOf(p.address), amount: total * BigInt(p.bps) / 10_000n }));
  split.push({ to: lockOf(payouts[payouts.length - 1].address), amount: total - split.reduce((a, o) => a + o.amount, 0n) });
  // A part below dust cannot be relayed: the whole share then goes to the largest payout (the artist).
  const main = payouts.reduce((a, p) => (p.bps > a.bps ? p : a));
  const finalPayouts = split.some((o) => o.amount < DUST)
    ? [{ to: lockOf(main.address), amount: share - fee }]
    : split;
  return make([...outputs, ...finalPayouts]);
}

// The keyless refund after the timeout: one output, the whole balance minus a fee ≤ maxRefundFee.
export function buildRefund({ contract, utxo, userPkh, timeout, maxRefundFee, provider, feeRate = 1.2 }) {
  const make = (fee) => new TransactionBuilder({ provider })
    .addInput(utxo, contract.unlock.refund())
    .addOutput({ to: p2pkhLock(hexToBin(userPkh)), amount: utxo.satoshis - fee })
    .setLocktime(timeout);
  const size = make(BigInt(maxRefundFee)).build().length / 2;
  const fee = BigInt(Math.min(maxRefundFee, Math.ceil(size * feeRate)));
  return make(fee);
}

export { binToHex };
