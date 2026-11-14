// Covenant tests on CashScript's MockNetworkProvider (in-memory chain that runs the real BCH VM).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  Contract, MockNetworkProvider, SignatureTemplate, TransactionBuilder, randomUtxo, randomToken, FailedRequireError,
} from 'cashscript';
import {
  secp256k1, sha256, hash160, generatePrivateKey, hexToBin, utf8ToBin,
  bigIntToBinUint64LE, numberToBinUint32LE, flattenBinArray,
} from '@bitauth/libauth';

const artifact = JSON.parse(readFileSync(new URL('../contracts/CashCastChannel.json', import.meta.url)));
const source = readFileSync(new URL('../contracts/CashCastChannel.cash', import.meta.url), 'utf8').split('\n');

const TIMEOUT = 900_000;      // block height
const MAX_REFUND_FEE = 1_000n;
const FUNDING = 100_000n;
const FEE = 2_000n;           // network fee the provider leaves in its settle transactions (≈1 sat/byte)
const REFUND_FEE = 600n;      // a one-output refund is ≈310 bytes

function keypair() {
  const priv = generatePrivateKey();
  const pub = secp256k1.derivePublicKeyCompressed(priv);
  return { priv, pub, pkh: hash160(pub), lock: p2pkh(hash160(pub)) };
}
function p2pkh(pkh) { return flattenBinArray([hexToBin('76a914'), pkh, hexToBin('88ac')]); }

// The off-chain payment message the listener's session key signs: "CC01" ‖ txid ‖ vout ‖ amount.
function payMsg(utxo, amount) {
  const txidInternal = hexToBin(utxo.txid).reverse();
  return flattenBinArray([utf8ToBin('CC01'), txidInternal, numberToBinUint32LE(utxo.vout), bigIntToBinUint64LE(amount)]);
}
function dataSig(priv, msg) { return secp256k1.signMessageHashSchnorr(priv, sha256.hash(msg)); }

// Line number of `snippet` inside contract function `fn`, so each rejection is pinned to its rule.
function line(fn, snippet) {
  const start = source.findIndex((l) => l.includes(`function ${fn}(`));
  const i = source.findIndex((l, n) => n > start && l.includes(snippet));
  assert.ok(start >= 0 && i > start, `no "${snippet}" in ${fn}()`);
  return i + 1;
}

// The transaction must fail inside the BCH VM on exactly this contract rule.
async function rejectsAt(tx, fn, snippet) {
  const want = line(fn, snippet);
  await assert.rejects(tx.send(), (e) => {
    assert.ok(e instanceof FailedRequireError, `expected a failed require, got ${e.constructor.name}: ${e.message}`);
    assert.match(e.message, new RegExp(`CashCastChannel\\.cash:${want}\\b`), `expected line ${want} (${snippet})`);
    return true;
  });
}

function setup({ height = TIMEOUT - 100, funding = FUNDING, token } = {}) {
  const provider = new MockNetworkProvider();
  provider.setBlockHeight(height);
  const user = keypair(), session = keypair(), cashcast = keypair(), attacker = keypair();
  const contract = new Contract(artifact,
    [user.pkh, session.pub, cashcast.pub, BigInt(TIMEOUT), MAX_REFUND_FEE], { provider });
  const utxo = provider.addUtxo(contract.address, randomUtxo({ satoshis: funding, ...(token && { token }) }));
  const providerSig = new SignatureTemplate(cashcast.priv);
  return { provider, contract, utxo, user, session, cashcast, attacker, providerSig };
}

// A settle transaction: refund to the listener in output 0 (if any), CashCast's share after it.
function settle(s, { amount, msg, sigKey = s.session.priv, refund, refundTo = s.user.lock,
  providerSig = s.providerSig, utxo = s.utxo, extraInputs = [] }) {
  const m = msg ?? payMsg(utxo, amount);
  const remainder = utxo.satoshis - amount;
  const tx = new TransactionBuilder({ provider: s.provider, allowImplicitFungibleTokenBurn: true })
    .addInput(utxo, s.contract.unlock.settle(providerSig, dataSig(sigKey, m), m));
  for (const [u, unlocker] of extraInputs) tx.addInput(u, unlocker);
  const refundValue = refund ?? remainder;
  if (refundValue > 0n) tx.addOutput({ to: refundTo, amount: refundValue });
  const totalIn = utxo.satoshis + extraInputs.reduce((a, [u]) => a + u.satoshis, 0n);
  tx.addOutput({ to: s.cashcast.lock, amount: totalIn - refundValue - FEE });
  return tx;
}

test('honest settle: CashCast takes the signed total, the rest returns to the listener', async () => {
  const s = setup();
  assert.ok((await settle(s, { amount: 30_000n }).send()).txid);
  const back = await s.provider.getUtxosForLockingBytecode(s.user.lock);
  assert.equal(back[0].satoshis, 70_000n);
});

test('CashCast cannot claim more than the listener signed', async () => {
  const s = setup();
  // Session key signed 30,000 but CashCast submits 50,000 with that signature.
  const sig = dataSig(s.session.priv, payMsg(s.utxo, 30_000n));
  const tx = new TransactionBuilder({ provider: s.provider })
    .addInput(s.utxo, s.contract.unlock.settle(s.providerSig, sig, payMsg(s.utxo, 50_000n)))
    .addOutput({ to: s.user.lock, amount: 50_000n })
    .addOutput({ to: s.cashcast.lock, amount: 50_000n - FEE });
  await rejectsAt(tx, 'settle', 'checkDataSig');
});

test('a total signed by any other key is rejected', async () => {
  await rejectsAt(settle(setup(), { amount: 30_000n, sigKey: keypair().priv }), 'settle', 'checkDataSig');
});

test('only CashCast can settle (provider signature required)', async () => {
  const s = setup();
  await rejectsAt(settle(s, { amount: 30_000n, providerSig: new SignatureTemplate(s.attacker.priv) }), 'settle', 'checkSig(');
});

test('the refund output cannot be short-changed or redirected', async () => {
  await rejectsAt(settle(setup(), { amount: 30_000n, refund: 69_999n }), 'settle', 'tx.outputs[0].value >= remainder');
  const s = setup();
  await rejectsAt(settle(s, { amount: 30_000n, refundTo: s.attacker.lock }), 'settle', 'LockingBytecodeP2PKH');
});

test('dust: the refund may be left out only when it is below 546 sats', async () => {
  assert.ok((await settle(setup(), { amount: FUNDING - 545n, refund: 0n }).send()).txid);
  await rejectsAt(settle(setup(), { amount: FUNDING - 546n, refund: 0n }), 'settle', 'LockingBytecodeP2PKH');
  assert.ok((await settle(setup(), { amount: FUNDING - 546n }).send()).txid);
});

test('a signed total cannot be replayed on another channel (other vout, other txid)', async () => {
  const s = setup();
  const sibling = s.provider.addUtxo(s.contract.address, { txid: s.utxo.txid, vout: s.utxo.vout + 1, satoshis: FUNDING });
  const msgForFirst = payMsg(s.utxo, 30_000n);
  await rejectsAt(settle(s, { amount: 30_000n, msg: msgForFirst, utxo: sibling }), 'settle', 'outpointIndex');
  const other = s.provider.addUtxo(s.contract.address, randomUtxo({ satoshis: FUNDING }));
  await rejectsAt(settle(s, { amount: 30_000n, msg: msgForFirst, utxo: other }), 'settle', 'outpointTransactionHash');
});

test('malformed totals are rejected: wrong length, wrong tag, more than the balance, negative', async () => {
  const s = setup();
  const good = payMsg(s.utxo, 30_000n);
  await rejectsAt(settle(s, { amount: 30_000n, msg: good.slice(0, 47) }), 'settle', 'payMsg.length');
  await rejectsAt(settle(s, { amount: 30_000n, msg: flattenBinArray([good, new Uint8Array([0])]) }), 'settle', 'payMsg.length');
  const wrongTag = good.slice(); wrongTag[3] = 0x32; // "CC02"
  await rejectsAt(settle(s, { amount: 30_000n, msg: wrongTag }), 'settle', 'tag ==');
  await rejectsAt(settle(s, { amount: FUNDING + 1n, refund: 0n }), 'settle', 'amount <= value');
  const negative = good.slice(); negative[47] |= 0x80; // top bit set → negative script number
  await rejectsAt(settle(s, { amount: 30_000n, msg: negative }), 'settle', 'amount > 0');
});

test('two channels cannot share one refund output in a single settle', async () => {
  const s = setup();
  const second = s.provider.addUtxo(s.contract.address, randomUtxo({ satoshis: FUNDING }));
  const m2 = payMsg(second, 30_000n);
  const unlock2 = s.contract.unlock.settle(s.providerSig, dataSig(s.session.priv, m2), m2);
  // One 70,000 refund would satisfy each input's own check; the second 70,000 would be stolen.
  await rejectsAt(settle(s, { amount: 30_000n, extraInputs: [[second, unlock2]] }), 'settle', 'tx.inputs.length == 1');
});

test('a token sent to the channel by mistake cannot be taken by settle', async () => {
  const s = setup({ token: randomToken() });
  await rejectsAt(settle(s, { amount: 30_000n }), 'settle', 'tokenCategory');
});

function refundTx(s, { locktime = TIMEOUT, to = s.user.lock, fee = REFUND_FEE, sequence, extraOutput } = {}) {
  const tx = new TransactionBuilder({ provider: s.provider, allowImplicitFungibleTokenBurn: true })
    .addInput(s.utxo, s.contract.unlock.refund(), sequence === undefined ? undefined : { sequence });
  const back = s.utxo.satoshis - fee - (extraOutput ?? 0n);
  tx.addOutput({ to, amount: back });
  if (extraOutput) tx.addOutput({ to: s.attacker.lock, amount: extraOutput });
  return tx.setLocktime(locktime);
}

test('keyless refund works after the timeout and pays the listener', async () => {
  const s = setup({ height: TIMEOUT + 1 });
  assert.ok((await refundTx(s).send()).txid);
  const back = await s.provider.getUtxosForLockingBytecode(s.user.lock);
  assert.equal(back[0].satoshis, FUNDING - REFUND_FEE);
});

test('refund is valid from the block after the timeout height, not before', async () => {
  assert.ok((await refundTx(setup({ height: TIMEOUT })).send()).txid);
  await rejectsAt(refundTx(setup({ height: TIMEOUT + 1 }), { locktime: TIMEOUT - 1 }), 'refund', 'tx.time >= timeout');
  // While the chain is below the timeout, the refund is not final and cannot be mined at all.
  await assert.rejects(refundTx(setup({ height: TIMEOUT - 10 })).send());
  // A final sequence number disables the locktime, so the time check fails.
  await rejectsAt(refundTx(setup({ height: TIMEOUT + 1 }), { sequence: 0xffffffff }), 'refund', 'tx.time >= timeout');
});

test('refund cannot be redirected, overpay the fee, or skim through a second output', async () => {
  const s = setup({ height: TIMEOUT + 1 });
  await rejectsAt(refundTx(s, { to: s.attacker.lock }), 'refund', 'LockingBytecodeP2PKH');
  await rejectsAt(refundTx(s, { fee: MAX_REFUND_FEE + 1n }), 'refund', 'maxRefundFee');
  // A bot keeps 600 sats in its own output while staying within the 1,000-sat fee allowance.
  await rejectsAt(refundTx(s, { fee: 400n, extraOutput: 600n }), 'refund', 'tx.outputs.length == 1');
});

test('two channels cannot share one refund output', async () => {
  const s = setup({ height: TIMEOUT + 1 });
  const second = s.provider.addUtxo(s.contract.address, randomUtxo({ satoshis: FUNDING }));
  const tx = new TransactionBuilder({ provider: s.provider })
    .addInput(s.utxo, s.contract.unlock.refund())
    .addInput(second, s.contract.unlock.refund())
    .addOutput({ to: s.user.lock, amount: FUNDING - 1_000n })
    .addOutput({ to: s.attacker.lock, amount: FUNDING - 1_000n })
    .setLocktime(TIMEOUT);
  await rejectsAt(tx, 'refund', 'tx.inputs.length == 1');
});

test('a token sent to the channel by mistake cannot be taken by refund', async () => {
  const s = setup({ height: TIMEOUT + 1, token: randomToken() });
  await rejectsAt(refundTx(s), 'refund', 'tokenCategory');
});

test('contract and transaction sizes (for fee planning)', () => {
  const s = setup();
  const settleBytes = settle(s, { amount: 30_000n }).build().length / 2;
  const r = setup({ height: TIMEOUT + 1 });
  const refundBytes = refundTx(r).build().length / 2;
  console.log(`contract ${s.contract.bytesize} bytes; settle tx ${settleBytes} bytes; refund tx ${refundBytes} bytes`);
  assert.ok(s.contract.bytesize < 300);
  assert.ok(settleBytes < 700 && refundBytes < BigInt(REFUND_FEE) * 1n + 1n);
});
