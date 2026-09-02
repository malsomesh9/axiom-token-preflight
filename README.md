# Axiom Token Preflight

Full prototype for **Axiom (YC W25)**: a Solana token pre-trade guardrail that helps memecoin traders decide whether a specific trade size should be allowed, warned, or blocked before execution.

## Why Axiom

Axiom is a YC-backed crypto/web3 trading company. YC lists Axiom as active in crypto/web3, fintech, consumer finance, and trading. The Axiom founding engineer job page says the product supports Solana memecoins, Hyperliquid perpetuals, and yield, and that the company is hiring engineers who can move fast across TypeScript, Rust, Next.js, PostgreSQL, distributed systems, and blockchain systems.

Sources:

- https://www.ycombinator.com/companies/axiom/jobs/PYj0leR-founding-engineer
- https://www.ycombinator.com/companies/industry/crypto-web3
- https://docs.dexscreener.com/api/reference
- https://solana.com/docs/rpc

## Problem noticed

Memecoin trading is speed-first. That is good for volume, but it creates a real product risk for a trading app: users can place a trade that is too large for visible pool depth, or trade a token with obvious control risks, before they understand what they are accepting.

The concrete workflow problem:

> A user enters a token and wants to buy $X. Should Axiom allow it, warn them, or block/reduce the size?

The prototype checks:

- whether mint authority is still active
- whether freeze authority is active
- whether holder concentration is dangerous
- whether liquidity is thin
- whether the token is moving violently over 24h
- whether the user's intended trade size would create too much estimated price impact

This prototype turns those checks into a compact pre-trade dossier.

## What is built

- **Backend API**
  - `GET /api/tokens`: curated sample Solana tokens for demo flow.
  - `GET /api/scan?mint=<address>`: full risk scan.
  - `GET /api/scan?mint=<address>&tradeUsd=<amount>`: full risk scan plus trade-size execution decision.
  - `GET /api/history`: persisted recent scans from `data/scans.json`.
  - `POST /rpc`: raw RPC proxy for debugging.

- **Real data**
  - Solana RPC `getAccountInfo` with `jsonParsed` encoding.
  - Solana RPC `getTokenSupply`.
  - Solana RPC `getTokenLargestAccounts` when public RPC allows it.
  - DexScreener token-pair data for price, liquidity, volume, pair list, and 24h change.

- **Frontend**
  - Polished trader-facing dashboard.
  - One-click sample tokens.
  - Risk score and action recommendation.
  - Allow/warn/block execution decision for the entered trade size.
  - Estimated price impact, fee-buffered impact, clean size, and review size.
  - Authority, market, holder, findings, DEX-pair, and history panels.

## Run locally

```bash
npm start
```

Open http://localhost:4173.

Use a better Solana RPC provider if public RPC rate-limits holder concentration:

```bash
SOLANA_RPC_URL=https://your-rpc.example npm start
```

## Production next steps

- Use Axiom's private RPC/indexing layer for holder concentration and fresh pool discovery.
- Add token creator/funder clustering.
- Add LP lock/burn checks where relevant.
- Add simulation against intended trade size to estimate slippage.
- Replace the prototype depth formula with route simulation through Jupiter or Axiom's execution engine.
- Attach the preflight badge directly to the trade confirmation flow.

## Outreach note

Hi Axiom team,

I noticed Axiom is moving fast in Solana memecoin trading, where users often trade before seeing whether a token and trade size are actually safe to execute. I built **Axiom Token Preflight**, a backend-backed prototype that takes a Solana mint plus intended USD trade size, checks token authorities through live RPC, enriches with DexScreener market data, estimates pool-depth impact, and returns an allow/warn/block decision.

It is intentionally scoped, but it shows the way I work: study the product, notice a real user-risk problem, build a working version, handle messy data limitations, and explain the production path clearly.

Demo: [add link]  
Repo: [add link]

I would love to work on problems like this with Axiom.
