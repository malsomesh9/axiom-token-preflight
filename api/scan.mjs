const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.mainnet.solana.com";

const SAMPLE_TOKENS = [
  ["BONK", "Bonk", "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"],
  ["JUP", "Jupiter", "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"],
  ["RAY", "Raydium", "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R"],
  ["WIF", "dogwifhat", "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm"],
].map(([symbol, name, mint]) => ({ symbol, name, mint }));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const numberOrNull = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const rpc = async (method, params) => {
  let lastPayload;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        method,
        params,
      }),
    });
    const payload = await response.json();
    lastPayload = payload;
    if (response.status !== 429 && !payload.error) return payload.result;
    if (attempt < 3) await sleep(500 * (attempt + 1));
  }
  throw new Error(lastPayload?.error?.message ?? `RPC ${method} failed`);
};

const safeRpc = async (method, params) => {
  try {
    return { ok: true, value: await rpc(method, params) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
};

const fetchDexScreener = async (mint) => {
  const response = await fetch(`https://api.dexscreener.com/token-pairs/v1/solana/${mint}`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`DexScreener returned ${response.status}`);
  const pairs = await response.json();
  if (!Array.isArray(pairs)) return { pairs: [], bestPair: null, totals: null };

  const normalized = pairs
    .filter((pair) => pair.chainId === "solana")
    .map((pair) => ({
      dexId: pair.dexId ?? "unknown",
      pairAddress: pair.pairAddress,
      baseToken: pair.baseToken,
      quoteToken: pair.quoteToken,
      priceUsd: numberOrNull(pair.priceUsd),
      liquidityUsd: numberOrNull(pair.liquidity?.usd),
      volume24h: numberOrNull(pair.volume?.h24),
      txns24h: Number(pair.txns?.h24?.buys ?? 0) + Number(pair.txns?.h24?.sells ?? 0),
      priceChange24h: numberOrNull(pair.priceChange?.h24),
      fdv: numberOrNull(pair.fdv),
      marketCap: numberOrNull(pair.marketCap),
      createdAt: pair.pairCreatedAt ? new Date(pair.pairCreatedAt).toISOString() : null,
      url: pair.url,
    }))
    .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));

  const totals = normalized.reduce(
    (sum, pair) => ({
      liquidityUsd: sum.liquidityUsd + (pair.liquidityUsd ?? 0),
      volume24h: sum.volume24h + (pair.volume24h ?? 0),
      txns24h: sum.txns24h + pair.txns24h,
    }),
    { liquidityUsd: 0, volume24h: 0, txns24h: 0 },
  );

  return { pairs: normalized.slice(0, 8), bestPair: normalized[0] ?? null, totals };
};

const percentFromRaw = (part, total) => {
  if (!total || total === 0n) return null;
  return Number((part * 10000n) / total) / 100;
};

const normalizeTradeUsd = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 250;
  return Math.min(parsed, 1_000_000);
};

const buildExecution = (market, tradeUsd) => {
  const bestPair = market.bestPair;
  const liquidityUsd = bestPair?.liquidityUsd ?? 0;
  const quoteDepthUsd = liquidityUsd / 2;
  const priceImpactPct = quoteDepthUsd > 0 ? (tradeUsd / (quoteDepthUsd + tradeUsd)) * 100 : null;
  const estimatedCostPct = priceImpactPct === null ? null : priceImpactPct + 0.3;
  const cleanMaxUsd = quoteDepthUsd * 0.01;
  const reviewMaxUsd = quoteDepthUsd * 0.03;

  if (priceImpactPct === null) {
    return {
      tradeUsd,
      decision: "No route",
      level: "block",
      reason: "No liquid Solana DEX pair was returned for this token.",
      liquidityUsd,
      quoteDepthUsd,
      priceImpactPct,
      estimatedCostPct,
      cleanMaxUsd,
      reviewMaxUsd,
    };
  }

  const level = priceImpactPct <= 1.5 ? "allow" : priceImpactPct <= 5 ? "warn" : "block";
  return {
    tradeUsd,
    decision: level === "allow" ? "Allow" : level === "warn" ? "Warn" : "Block",
    level,
    reason:
      level === "allow"
        ? "Estimated impact is inside a normal pre-trade threshold."
        : level === "warn"
          ? "Trade is possible, but impact is high enough to require confirmation."
          : "Trade size is too large for the best visible pool depth.",
    pairAddress: bestPair?.pairAddress ?? null,
    dexId: bestPair?.dexId ?? null,
    quoteSymbol: bestPair?.quoteToken?.symbol ?? null,
    liquidityUsd,
    quoteDepthUsd,
    priceImpactPct,
    estimatedCostPct,
    cleanMaxUsd,
    reviewMaxUsd,
  };
};

const scoreScan = ({ mintInfo, holders, market, execution, warnings }) => {
  const findings = [];
  let score = 0;
  const liquidityUsd = market.totals?.liquidityUsd ?? 0;
  const volume24h = market.totals?.volume24h ?? 0;
  const priceChange24h = market.bestPair?.priceChange24h ?? null;

  if (mintInfo.mintAuthority) {
    score += 32;
    findings.push({ tone: "danger", title: "Mint authority active", body: "The issuer may still be able to expand supply." });
  } else {
    findings.push({ tone: "good", title: "Mint authority renounced", body: "Supply cannot be expanded through the mint authority." });
  }

  if (mintInfo.freezeAuthority) {
    score += 24;
    findings.push({ tone: "danger", title: "Freeze authority active", body: "The authority may be able to freeze token accounts." });
  } else {
    findings.push({ tone: "good", title: "Freeze authority disabled", body: "A common centralized control path is absent." });
  }

  if (holders.topOnePct === null) {
    score += 6;
    findings.push({ tone: "warn", title: "Holder concentration limited", body: "The public RPC did not return largest-account data." });
  }

  if (liquidityUsd >= 50_000) {
    findings.push({
      tone: "good",
      title: "Market data found",
      body: `DexScreener tracks about $${Math.round(liquidityUsd).toLocaleString()} liquidity and $${Math.round(volume24h).toLocaleString()} 24h volume.`,
    });
  } else {
    score += 12;
    findings.push({ tone: "warn", title: "Thin or missing liquidity", body: "Visible DEX liquidity is low or unavailable." });
  }

  if (priceChange24h !== null && Math.abs(priceChange24h) >= 35) score += 10;

  if (execution.priceImpactPct === null) {
    score += 18;
    findings.push({ tone: "danger", title: "No executable route", body: "No usable pool depth was found." });
  } else if (execution.priceImpactPct > 5) {
    score += 24;
    findings.push({
      tone: "danger",
      title: "Trade size breaks depth",
      body: `$${Math.round(execution.tradeUsd).toLocaleString()} would move the best visible pool by about ${execution.priceImpactPct.toFixed(2)}%.`,
    });
  } else if (execution.priceImpactPct > 1.5) {
    score += 12;
    findings.push({
      tone: "warn",
      title: "Trade needs confirmation",
      body: `$${Math.round(execution.tradeUsd).toLocaleString()} would create about ${execution.priceImpactPct.toFixed(2)}% estimated price impact.`,
    });
  } else {
    findings.push({ tone: "good", title: "Trade size fits depth", body: "Trade is within the clean-depth band for the best visible pool." });
  }

  warnings.forEach((warning) => findings.push({ tone: "warn", title: "Data caveat", body: warning }));

  const boundedScore = Math.min(100, Math.max(0, Math.round(score)));
  let level = boundedScore >= 65 ? "high" : boundedScore >= 32 ? "medium" : "low";
  if (execution.level === "block") level = "high";
  else if (execution.level === "warn" && level === "low") level = "medium";
  const action =
    execution.level === "block"
      ? "Block this trade size or ask the trader to reduce size."
      : execution.level === "warn" || level === "medium"
        ? "Show warning and ask trader to review details."
        : "Allow trade with compact risk badge.";

  return { score: boundedScore, level, action, findings };
};

export default async function handler(request, response) {
  try {
    const mint = String(request.query.mint ?? "").trim();
    const tradeUsd = normalizeTradeUsd(request.query.tradeUsd);
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
      response.status(400).json({ error: "Invalid Solana mint address." });
      return;
    }

    const [accountResult, supplyResult, holdersResult, marketResult] = await Promise.all([
      safeRpc("getAccountInfo", [mint, { encoding: "jsonParsed", commitment: "confirmed" }]),
      safeRpc("getTokenSupply", [mint, { commitment: "confirmed" }]),
      safeRpc("getTokenLargestAccounts", [mint, { commitment: "confirmed" }]),
      fetchDexScreener(mint).catch((error) => ({ error: error.message, pairs: [], bestPair: null, totals: null })),
    ]);

    if (!accountResult.ok) throw new Error(accountResult.error);
    if (!supplyResult.ok) throw new Error(supplyResult.error);

    const parsed = accountResult.value?.value?.data?.parsed;
    if (!parsed || parsed.type !== "mint") {
      response.status(400).json({ error: "That address is not a parsed SPL token mint." });
      return;
    }

    const rawSupply = BigInt(supplyResult.value.value.amount);
    const holderRows =
      holdersResult.ok && holdersResult.value?.value
        ? holdersResult.value.value.map((holder) => ({
            address: holder.address,
            amount: holder.amount,
            uiAmountString: holder.uiAmountString,
            pct: percentFromRaw(BigInt(holder.amount), rawSupply),
          }))
        : [];
    const topTenRaw = holderRows.slice(0, 10).reduce((sum, holder) => sum + BigInt(holder.amount), 0n);
    const holders = {
      available: holderRows.length > 0,
      topOnePct: holderRows[0]?.pct ?? null,
      topTenPct: holderRows.length ? percentFromRaw(topTenRaw, rawSupply) : null,
      rows: holderRows.slice(0, 10),
    };
    const market = { pairs: marketResult.pairs ?? [], bestPair: marketResult.bestPair ?? null, totals: marketResult.totals ?? null };
    const warnings = [];
    if (!holdersResult.ok) warnings.push(`Largest-account lookup failed: ${holdersResult.error}`);
    if (marketResult.error) warnings.push(`DEX market lookup failed: ${marketResult.error}`);

    const execution = buildExecution(market, tradeUsd);
    const verdict = scoreScan({ mintInfo: parsed.info, holders, market, execution, warnings });
    const sample = SAMPLE_TOKENS.find((token) => token.mint === mint);

    response.status(200).json({
      id: `${Date.now()}-${mint.slice(0, 8)}`,
      scannedAt: new Date().toISOString(),
      mint,
      name: market.bestPair?.baseToken?.name ?? sample?.name ?? "Unknown token",
      symbol: market.bestPair?.baseToken?.symbol ?? sample?.symbol ?? "UNKNOWN",
      network: "solana-mainnet",
      rpcUrl: RPC_URL,
      mintInfo: {
        decimals: parsed.info.decimals,
        isInitialized: parsed.info.isInitialized,
        mintAuthority: parsed.info.mintAuthority,
        freezeAuthority: parsed.info.freezeAuthority,
        supply: supplyResult.value.value.uiAmountString,
        rawSupply: supplyResult.value.value.amount,
      },
      holders,
      market,
      execution,
      verdict,
    });
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
}
