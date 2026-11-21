# CashCast

[![tests](https://github.com/samizdatproject/cashcast/actions/workflows/test.yml/badge.svg)](https://github.com/samizdatproject/cashcast/actions/workflows/test.yml)

**Pay by the second for content — music, video, podcasts — in Bitcoin Cash.** The demo plays music: the first seconds of every track are free (one minute by default; the live demo starts charging at 0:04). To keep listening, you approve a small budget once from your wallet; you pay only for the seconds you actually hear, and whatever you don't use comes back to your wallet automatically.

Live demo: https://cashcast.cls9.com · Built for [BCH BLAZE 2026](https://dorahacks.io/hackathon/blaze2026).

> We don't sell bytes. We sell decryption keys.

## Why

Streaming pays artists fractions of a cent per play, months later, through platforms that keep most of the money. Pay-per-play micropayments have never worked because card fees are larger than the payment. Bitcoin Cash makes a 0.1¢ payment cheap, but sending one transaction per second still isn't practical.

CashCast needs **one** on-chain transaction to open a listening session and **one** to close it, however long you listen. In between, payments are signatures, not transactions.

## How it works

1. **Encrypted audio, public.** Each track is cut into 4-second HLS segments. Every segment is AES-128 encrypted with its own key. The encrypted files can be served by any CDN; the manifest publishes `sha256(key)` for every segment, so a wrong key is provable.
2. **One approval.** The listener's wallet (via [WizardConnect](https://wizardconnect.cash)) funds a small CashScript contract, the *channel*, with the budget. This is the only thing the wallet signs.
3. **Pay as you listen.** The browser holds a throwaway *session key*. Every few seconds it signs a new running total: `"CC01" ‖ funding txid ‖ vout ‖ amount`. The server checks the signature and sells one segment key per paid segment. No transaction, no fee per payment.
4. **Settle once.** When the listener stops (or after 10 idle minutes), the server spends the channel with the latest signed total: the remainder goes back to the listener in output 0, the rest is split 90% artist / 10% CashCast.
5. **No trust needed.** After a timeout (144 blocks, about a day) anyone can send the whole channel back to the listener with no key at all. The contract permits nothing else.

```
listener wallet ──fund (1 tx)──► CashCastChannel ──settle (1 tx)──► listener remainder
                                    ▲                              ├► artist 90%
browser session key ──signed totals─┘ (off-chain)                  └► CashCast 10%
                                         after timeout: anyone ──► whole balance to listener
```

### The contract

[`contracts/CashCastChannel.cash`](contracts/CashCastChannel.cash): about 240 bytes, two spending paths.

- `settle(providerSig, paySig, payMsg)`: one input only, no tokens. CashCast's signature, plus a data signature by the listener's session key over a tagged message that names this exact outpoint. The total must be positive and at most the balance. Output 0 must return the remainder to the listener, unless the remainder is below the 546-sat dust limit.
- `refund()`: one input, one output, no tokens. Only after the block-height timeout; the output must pay the listener, and the fee is capped.

## Price

1¢ per minute, converted to sats at the live BCH/USD price when a session opens and fixed for that session. Budgets are 10¢, 25¢ or 50¢. A settlement costs about 550 sats in network fees (a fraction of a cent), paid out of CashCast's share.

**Business model:** 10% of every settled amount. It costs nothing to keep CashCast running while no one listens: no subscriptions, no ads, no accounts.

## Run it

Needs Node 20+ and ffmpeg.

```sh
npm install
npm test                       # 31 tests: covenant, packager, key server
npm run build:contract && npm run build:web

# local development on an in-memory chain (no real money)
node src/main.js               # http://localhost:8787

# package a track (writes media/<network>/<trackId>/)
node scripts/package.mjs song.mp3 my-track "Title" "Artist" "https://licence-url"

# real Bitcoin Cash
CASHCAST_NETWORK=mainnet \
CASHCAST_ARTIST_ADDRESS=bitcoincash:q... CASHCAST_PLATFORM_ADDRESS=bitcoincash:q... \
node src/main.js
```

Secrets (`secrets/master-<network>.key`, `secrets/provider-<network>.key`) are created on first start, mode 600, and never committed.

## Layout

| Path | What |
|---|---|
| `contracts/` | The channel covenant (CashScript 0.14) |
| `scripts/package.mjs` | ffmpeg → encrypted HLS + manifest with key commitments |
| `scripts/refund.mjs` | Keyless refund of a channel after its timeout |
| `src/server.js` | Key server (Fastify + SQLite): sessions, signed totals, keys, settlement, sweeper |
| `src/channel.js` | Payment message, signature check, settle/refund transaction builders |
| `web/` | Player (hls.js), WizardConnect funding |
| `test/` | Covenant tests on CashScript's mock chain, packager and server tests |

## Prior art

Pay-per-second streaming has been tried before: Streamium (2015, Bitcoin payment channels), Lightning streaming sats (Podcasting 2.0), Wavlake, and research such as FairStream (arXiv 2102.04685). As far as we know, CashCast is the first on Bitcoin Cash. BCH covenants make it simpler: one tiny contract per session, no Lightning node, keyless refunds enforced by the contract, and provable key delivery.

## Music

Demo catalogue: CC0 tracks by HoliznaCC0 and Komiku; see [CREDITS.md](CREDITS.md). In this demo the artist share goes to the CashCast team. In production, artists register their own Bitcoin Cash address.

## How this was built

Designed and directed by samizdatproject (solo). Much of the code was written with an AI coding assistant (Claude, by Anthropic), and every change was tested; the contract, server and browser each had a separate review (see [SECURITY.md](SECURITY.md)). Decisions, testing on mainnet and the demo are the builder's own.

## Licence

MIT
