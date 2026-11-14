// WizardConnect: pair the listener's wallet with a QR code, read its addresses, and ask it to sign
// the one funding transaction (wallet coins → channel contract, change back to the wallet).
import { initiateDappRelay } from '@wizardconnect/core';
import { sourceOutputToRelay, transactionToHex } from '@wizardconnect/core/hdwalletv1-serialize';
import { DappConnectionManager } from '@wizardconnect/dapp';
import {
  hash160, encodeCashAddress, cashAddressToLockingBytecode, hexToBin, decodeTransaction, hashTransaction,
  decodeHdPublicKey, deriveHdPathRelative,
} from '@bitauth/libauth';
import qrcode from 'qrcode-generator';

const RECEIVE = 0, CHANGE = 1;
const SCAN = 10;          // addresses per branch to look for coins
const FEE_RATE = 1.2;     // sat/byte, a little above the 1 sat/byte relay minimum
const DUST = 546;

let manager = null, relay = null;

// Wallets share one xpub per branch. The library maps the names "receive"/"change"; if a wallet
// names them differently, derive from the shared xpubs ourselves (first = receive, second = change).
const fallbackNodes = new Map();
function pubkeyAt(branch, index) {
  const pk = manager.getPubkey(branch, BigInt(index));
  if (pk) return pk;
  const node = fallbackNodes.get(branch);
  if (!node) return undefined;
  const child = deriveHdPathRelative(node, String(index));
  return typeof child === 'string' ? undefined : child.publicKey;
}
function addressAt(branch, index) {
  const pk = pubkeyAt(branch, index);
  return pk && encodeCashAddress({ prefix: 'bitcoincash', type: 'p2pkh', payload: hash160(pk) }).address;
}
function loadFallbackNodes() {
  fallbackNodes.clear();
  const paths = manager.getSessionPaths();
  const decoded = paths.map((p) => ({ name: p.name, d: decodeHdPublicKey(p.xpub) }));
  for (const { name, d } of decoded) if (typeof d === 'string') console.warn('[cashcast] bad xpub for', name, d);
  const nodes = decoded.filter((x) => typeof x.d !== 'string');
  const byName = (n) => nodes.find((x) => x.name.toLowerCase().includes(n))?.d.node;
  const receive = byName('receive') ?? nodes[0]?.d.node, change = byName('change') ?? nodes[1]?.d.node ?? receive;
  if (receive) fallbackNodes.set(RECEIVE, receive);
  if (change) fallbackNodes.set(CHANGE, change);
}

// Show a QR code (and a link for wallets on the same device); resolve once the wallet is ready.
export function connect(qrElement, linkElement, onStatus) {
  return new Promise((resolve, reject) => {
    manager?.removeAllListeners();
    relay?.cleanup();
    manager = new DappConnectionManager('CashCast', `${location.origin}/icon.svg`, { session: false });
    relay = initiateDappRelay(({ client, status }) => { manager.updateConnection(client, status); onStatus?.(status); });
    manager.attachRelay(relay);
    const qr = qrcode(0, 'M');
    qr.addData(relay.qrUri);
    qr.make();
    qrElement.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    linkElement.href = relay.uri;
    // Some wallets (Selene) send a first wallet_ready with no paths and a second one with the
    // xpubs once they have seen dapp_ready. Wait for the one we can derive an address from.
    const giveUp = setTimeout(() => reject(new Error('The wallet connected but did not share an address. Please try again.')), 30_000);
    const onReady = () => {
      loadFallbackNodes();
      const refundAddress = addressAt(RECEIVE, 0);
      if (!refundAddress) return; // keep waiting for the next wallet_ready
      clearTimeout(giveUp);
      manager.off('walletready', onReady);
      resolve({ walletName: manager.walletName, refundAddress });
    };
    manager.on('walletready', onReady);
    manager.once('disconnect', (_, message) => reject(new Error(message || 'wallet disconnected')));
  });
}

// Build the funding transaction, have the wallet sign it, and return the signed hex.
export async function fund({ contractAddress, satoshis, api }) {
  const paths = [];
  for (const branch of [RECEIVE, CHANGE]) for (let i = 0; i < SCAN; i++) paths.push({ branch, i, address: addressAt(branch, i) });
  const byAddress = new Map(paths.filter((p) => p.address).map((p) => [p.address, p]));
  const coins = (await api('/api/utxos', { method: 'POST', body: { addresses: [...byAddress.keys()] } }))
    .sort((a, b) => b.satoshis - a.satoshis);

  const contractLock = cashAddressToLockingBytecode(contractAddress).bytecode;
  const changeAddress = addressAt(CHANGE, 0);
  const changeLock = cashAddressToLockingBytecode(changeAddress).bytecode;
  // Pick the largest coins until they cover budget + fee (P2PKH input ≈ 148 bytes).
  const chosen = []; let total = 0;
  const feeFor = (nIn, nOut) => Math.ceil((10 + nIn * 148 + nOut * 44) * FEE_RATE);
  for (const c of coins) {
    chosen.push(c); total += c.satoshis;
    if (total >= satoshis + feeFor(chosen.length, 2)) break;
  }
  const feeWithChange = feeFor(chosen.length, 2);
  if (total < satoshis + feeFor(chosen.length, 1)) throw new Error(`Not enough funds in the wallet (need ${satoshis + feeWithChange} sats)`);
  const change = total - satoshis - feeWithChange;

  const inputs = chosen.map((c) => ({
    outpointTransactionHash: hexToBin(c.txid), outpointIndex: c.vout, sequenceNumber: 0xffffffff, unlockingBytecode: new Uint8Array(),
  }));
  const outputs = [{ lockingBytecode: contractLock, valueSatoshis: BigInt(satoshis) }];
  if (change >= DUST) outputs.push({ lockingBytecode: changeLock, valueSatoshis: BigInt(change) });
  const sourceOutputs = chosen.map((c, n) => ({
    ...inputs[n], valueSatoshis: BigInt(c.satoshis), lockingBytecode: cashAddressToLockingBytecode(c.address).bytecode,
  }));
  const inputPaths = chosen.map((c, n) => {
    const p = byAddress.get(c.address);
    return [n, p.branch === RECEIVE ? 'receive' : 'change', p.i];
  });

  const res = await manager.signTransaction({
    transaction: {
      transaction: transactionToHex(inputs, outputs),
      sourceOutputs: sourceOutputs.map(sourceOutputToRelay),
      broadcast: false,
      userPrompt: `CashCast listening budget: ${satoshis.toLocaleString()} sats. Unspent money returns to you automatically.`,
    },
    inputPaths,
  });
  if (res.error || !res.signedTransaction) throw new Error(res.error || 'The wallet did not sign');
  const signed = res.signedTransaction;
  // Check the wallet signed what we asked: same outputs, nothing added.
  const tx = decodeTransaction(hexToBin(signed));
  if (typeof tx === 'string') throw new Error(`wallet returned an invalid transaction: ${tx}`);
  if (tx.outputs.length !== outputs.length || tx.outputs[0].valueSatoshis !== BigInt(satoshis)) throw new Error('wallet changed the transaction');
  return { hex: signed, txid: hashTransaction(hexToBin(signed)) };
}
