// Create a real mainnet test channel for the owner's wallet. Prints only the public address.
// Keys are written to secrets/ (mode 600, git-ignored) and never printed.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { Contract, ElectrumNetworkProvider } from 'cashscript';
import { decodeCashAddress, generatePrivateKey, secp256k1, binToHex } from '@bitauth/libauth';

const [listenerAddress, name = 'test-channel-1', blocks = '6'] = process.argv.slice(2);
const out = new URL(`../secrets/${name}.json`, import.meta.url);
if (existsSync(out)) throw new Error(`${name} already exists`);

const decoded = decodeCashAddress(listenerAddress);
if (typeof decoded === 'string') throw new Error(decoded);
if (!decoded.type.startsWith('p2pkh')) throw new Error(`listener address must be P2PKH, got ${decoded.type}`);

const artifact = JSON.parse(readFileSync(new URL('../contracts/CashCastChannel.json', import.meta.url)));
const provider = new ElectrumNetworkProvider('mainnet');
const height = await provider.getBlockHeight();
const timeout = height + Number(blocks);

const providerKey = generatePrivateKey(), sessionKey = generatePrivateKey();
const params = {
  listenerAddress, userPkh: binToHex(decoded.payload),
  sessionPk: binToHex(secp256k1.derivePublicKeyCompressed(sessionKey)),
  providerPk: binToHex(secp256k1.derivePublicKeyCompressed(providerKey)),
  timeout, maxRefundFee: '1000', createdAtHeight: height,
};
const contract = new Contract(artifact,
  [params.userPkh, params.sessionPk, params.providerPk, BigInt(timeout), 1000n], { provider });
writeFileSync(out, JSON.stringify({ ...params, address: contract.address,
  providerKey: binToHex(providerKey), sessionKey: binToHex(sessionKey) }, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ address: contract.address, timeout, currentHeight: height }, null, 2));
process.exit(0);
