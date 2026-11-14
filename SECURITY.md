# Security notes

## What protects the listener

All of this is enforced by the contract, not by the CashCast server:

- **CashCast can take at most what the listener signed.** A settlement needs a data signature by the listener's session key over `"CC01" ‖ txid ‖ vout ‖ amount`. The amount is bound to this exact channel (txid and vout), so a signature cannot be replayed on another channel.
- **The rest always comes back.** Output 0 of a settlement must pay the listener at least `balance − amount`. It may be omitted only when it would be below the 546-sat dust limit.
- **One channel per transaction.** Both spending paths require exactly one input, so one refund output can never be counted for two channels.
- **Keyless refund.** After the block-height timeout anyone can return the whole balance to the listener. The refund must have exactly one output, paid to the listener; the fee is capped (`maxRefundFee`), so a bot cannot skim it.
- **Tokens are untouchable.** A token sent to a channel by mistake cannot be spent by either path.

The listener's app rebuilds the channel address from parameters it checks itself, and funds only the plain (non-token) address.

## What the listener trusts CashCast for

- **Key delivery.** CashCast could take a payment and not send the key. Exposure is bounded: the browser pays only about 5 segments (about 20 seconds) ahead. Every key is committed in the manifest as `sha256(key)`, so a wrong key is provable.
- **The session key lives in the browser** (localStorage). If it leaks, someone can sign totals up to the channel balance. It is a throwaway key, used for one session and nothing else.

## What protects CashCast

- **Settlement before the timeout.** Keys stop being sold 12 blocks before the timeout. A sweeper settles idle sessions (10 minutes) and sessions near their timeout. At or after the timeout CashCast never broadcasts a settlement that could lose to the refund; the channel is returned to the listener instead.
- **No races.** A session is frozen (`settling`) before its total is read, so no keys can be bought after the settled total is fixed, and two settlements cannot both broadcast.
- **Unconfirmed funding is accepted** (BCH 0-conf) with a per-session spending cap (`maxSpend`, default 500,000 sats), which bounds the loss from a double-spent funding.
- **Rate limits** on session creation, wallet lookups and broadcasts.
- **Secrets:** strict validation of the master secret (a bad value can never become an empty key), separate secrets per network, mode-600 files, never committed.

## Reviews

- **Contract:** independent review on 2026-11-14 found no critical or high issues. Fixed: refund skimming through a second output, the minimum refund output, token handling, and a domain tag on payment messages. Every rejection in the tests is pinned to the `require` line that must fail.
- **Server:** independent review on 2026-11-14. Fixed: missing automatic settlement (critical), a settle/pay race (high), unconfirmed-funding exposure, master-secret validation, rate limits, startup validation of the payout configuration, and refusing to reuse a `trackId` (key reuse).

## Known limitations

- The free-minute keys are free by design; anyone can decrypt the first minute of every track.
- A listener who stops paying keeps the keys already bought (up to about 20 seconds ahead).
- Prices use a public BCH/USD feed (Kraken, CoinGecko). If both fail, prices fall back to sats.

## Reporting

Please open a GitHub issue, or for anything sensitive contact the maintainer through the GitHub profile.
