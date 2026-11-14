// The browser checks the channel itself before the wallet signs anything: the contract address
// must be rebuilt from the listener's own refund key and session key, CashCast's pinned key, and
// sane limits. A dishonest or hacked server can then never redirect the budget.
import { Contract } from 'cashscript';
import artifact from '../../contracts/CashCastChannel.json';

// CashCast's settlement key, pinned into the page at build time (empty in local development).
const PINNED_PROVIDER_PK = typeof CASHCAST_PROVIDER_PK === 'string' ? CASHCAST_PROVIDER_PK : '';

export const LIMITS = {
  maxBudgetSats: 1_000_000,  // hard cap on what the page will ever ask a wallet to send (~$2)
  maxRefundFee: 2_000,       // the keyless refund may never spend more than this on fees
  maxTimeoutBlocks: 200,     // the money is never locked for more than ~1.5 days
  minTimeoutBlocks: 24,
};

// Block height estimated from the clock (one block per 10 minutes from a known point), so the
// timeout check does not depend on the server's word.
const REF = { height: 977_366, time: Date.UTC(2026, 10, 14, 19, 49) / 1000 };
export const estimatedHeight = () => REF.height + Math.floor((Date.now() / 1000 - REF.time) / 600);

export function checkChannel({ session, ownPkh, ownSessionPk, satoshis, dev }) {
  const p = session.params;
  const fail = (why) => { throw new Error(`Refusing to pay: ${why}. Please reload and try again.`); };
  if (p.userPkh !== ownPkh) fail('the refund address is not your wallet');
  if (p.sessionPk !== ownSessionPk) fail('the session key is not this browser\'s');
  if (!dev && PINNED_PROVIDER_PK && p.providerPk !== PINNED_PROVIDER_PK) fail('unknown CashCast key');
  if (!Number.isInteger(p.timeout) || p.timeout >= 500_000_000) fail('bad timeout');
  if (!dev) {
    const ahead = p.timeout - estimatedHeight();
    if (ahead > LIMITS.maxTimeoutBlocks || ahead < LIMITS.minTimeoutBlocks) fail(`unexpected timeout (${ahead} blocks away)`);
  }
  if (!(p.maxRefundFee >= 400 && p.maxRefundFee <= LIMITS.maxRefundFee)) fail('refund fee limit out of range');
  if (!(satoshis >= p.maxRefundFee + 546 + 1_000 && satoshis <= LIMITS.maxBudgetSats)) fail('budget out of range');
  const network = session.address.startsWith('bitcoincash:') ? 'mainnet' : 'chipnet';
  const rebuilt = new Contract(artifact, [p.userPkh, p.sessionPk, p.providerPk, BigInt(p.timeout), BigInt(p.maxRefundFee)],
    { provider: { network } }).address;
  if (rebuilt !== session.address) fail('the contract address does not match its parameters');
}
