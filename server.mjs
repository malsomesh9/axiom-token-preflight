import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const PORT = Number(process.env.PORT ?? 4173);
const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.mainnet.solana.com";
const ROOT = process.cwd();
const DATA_DIR = join(ROOT, "data");
const HISTORY_PATH = join(DATA_DIR, "scans.json");
const CACHE_TTL_MS = 45_000;

const SAMPLE_TOKENS = [
  {
    symbol: "BONK",
    name: "Bonk",
    mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    thesis: "large memecoin with active Solana trading",
  },
  {
    symbol: "JUP",
    name: "Jupiter",
    mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    thesis: "core Solana trading infrastructure token",
  },
  {
    symbol: "RAY",
    name: "Raydium",
    mint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
    thesis: "DEX token with deep Solana history",
  },
  {
    symbol: "WIF",
    name: "dogwifhat",
    mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
    thesis: "memecoin with meaningful market attention",
  },
];

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const memoryCache = new Map();

const send = (response, statusCode, body, headers = {}) => {
  response.writeHead(statusCode, headers);
  response.end(body);
};

const sendJson = (response, statusCode, payload) => {
  send(response, statusCode, JSON.stringify(payload, null, 2), {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
};

const readBody = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const numberOrNull = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const cached = async (key, loader) => {
  const current = memoryCache.get(key);
  if (current && Date.now() - current.createdAt < CACHE_TTL_MS) return current.value;
  const value = await loader();
  memoryCache.set(key, { value, createdAt: Date.now() });
  return value;
};

const rpc = async (method, params) => {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    method,
    params,
  });

  let lastPayload;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
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
  const url = `https://api.dexscreener.com/token-pairs/v1/solana/${mint}`;
  const response = await fetch(url, { headers: { accept: "application/json" } });

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

  return {
    pairs: normalized.slice(0, 8),
    bestPair: normalized[0] ?? null,
    totals,
  };
};

const percentFromRaw = (part, total) => {
  if (!total || total === 0n) return null;
  const basisPoints = (part * 10000n) / total;
  return Number(basisPoints) / 100;
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

  let level = "block";
  let decision = "No route";
  let reason = "No liquid Solana DEX pair was returned for this token.";

  if (priceImpactPct !== null && priceImpactPct <= 1.5) {
    level = "allow";
    decision = "Allow";
    reason = "Estimated impact is inside a normal pre-trade threshold.";
  } else if (priceImpactPct !== null && priceImpactPct <= 5) {
    level = "warn";
    decision = "Warn";
    reason = "Trade is possible, but impact is high enough to require confirmation.";
  } else if (priceImpactPct !== null) {
    level = "block";
    decision = "Block";
    reason = "Trade size is too large for the best visible pool depth.";
  }

  return {
    tradeUsd,
    decision,
    level,
    reason,
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
    findings.push({
      tone: "danger",
      title: "Mint authority active",
      body: "The issuer may still be able to expand supply. This should trigger a visible warning before size.",
    });
  } else {
    findings.push({
      tone: "good",
      title: "Mint authority renounced",
      body: "Supply cannot be expanded through the mint authority.",
    });
  }

  if (mintInfo.freezeAuthority) {
    score += 24;
    findings.push({
      tone: "danger",
      title: "Freeze authority active",
      body: "The authority may be able to freeze token accounts. That is a serious control-risk signal.",
    });
  } else {
    findings.push({
      tone: "good",
      title: "Freeze authority disabled",
      body: "A common centralized control path is absent.",
    });
  }

  if (holders.topOnePct === null) {
    score += 6;
    findings.push({
      tone: "warn",
      title: "Holder concentration limited",
      body: "The public RPC did not return largest-account data. A production version should use a private RPC/indexer.",
    });
  } else if (holders.topOnePct >= 20) {
    score += 20;
    findings.push({
      tone: "danger",
      title: "Top holder is large",
      body: `Largest token account holds ${holders.topOnePct.toFixed(2)}% of supply.`,
    });
  } else if (holders.topOnePct >= 10) {
    score += 10;
    findings.push({
      tone: "warn",
      title: "Top holder deserves review",
      body: `Largest token account holds ${holders.topOnePct.toFixed(2)}% of supply.`,
    });
  } else {
    findings.push({
      tone: "good",
      title: "No giant top holder",
      body: `Largest token account holds ${holders.topOnePct.toFixed(2)}% of supply.`,
    });
  }

  if (holders.topTenPct !== null && holders.topTenPct >= 55) score += 18;
  else if (holders.topTenPct !== null && holders.topTenPct >= 35) score += 9;

  if (liquidityUsd > 0 && liquidityUsd < 50_000) {
    score += 14;
    findings.push({
      tone: "warn",
      title: "Thin liquidity",
      body: `Tracked liquidity is about $${Math.round(liquidityUsd).toLocaleString()}. Slippage and exit risk can be high.`,
    });
  } else if (liquidityUsd >= 50_000) {
    findings.push({
      tone: "good",
      title: "Market data found",
      body: `DexScreener tracks about $${Math.round(liquidityUsd).toLocaleString()} liquidity and $${Math.round(volume24h).toLocaleString()} 24h volume.`,
    });
  } else {
    score += 12;
    findings.push({
      tone: "warn",
      title: "No DEX market found",
      body: "DexScreener did not return a Solana pair for this token.",
    });
  }

  if (priceChange24h !== null && Math.abs(priceChange24h) >= 35) {
    score += 10;
    findings.push({
      tone: "warn",
      title: "High 24h volatility",
      body: `Best-pair price moved ${priceChange24h.toFixed(2)}% over 24h.`,
    });
  }

  if (execution.priceImpactPct === null) {
    score += 18;
    findings.push({
      tone: "danger",
      title: "No executable route",
      body: "The trade cannot be preflighted because no usable pool depth was found.",
    });
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
    findings.push({
      tone: "good",
      title: "Trade size fits depth",
      body: `$${Math.round(execution.tradeUsd).toLocaleString()} is within the clean-depth band for the best visible pool.`,
    });
  }

  warnings.forEach((warning) => findings.push({ tone: "warn", title: "Data caveat", body: warning }));

  const boundedScore = Math.min(100, Math.max(0, Math.round(score)));
  let level = boundedScore >= 65 ? "high" : boundedScore >= 32 ? "medium" : "low";
  if (execution.level === "block") level = "high";
  else if (execution.level === "warn" && level === "low") level = "medium";
  const action =
    execution.level === "block"
      ? "Block this trade size or ask the trader to reduce size."
      : level === "high"
      ? "Block or require explicit confirmation before trade."
      : execution.level === "warn" || level === "medium"
        ? "Show warning and ask trader to review details."
        : "Allow trade with compact risk badge.";

  return { score: boundedScore, level, action, findings };
};

const loadHistory = async () => {
  try {
    return JSON.parse(await readFile(HISTORY_PATH, "utf8"));
  } catch {
    return [];
  }
};

const saveHistory = async (entry) => {
  await mkdir(DATA_DIR, { recursive: true });
  const history = await loadHistory();
  const next = [entry, ...history.filter((item) => item.mint !== entry.mint)].slice(0, 20);
  await writeFile(HISTORY_PATH, JSON.stringify(next, null, 2));
};

const buildScan = async (mint, tradeUsdInput) => {
  const cleanedMint = mint.trim();
  const tradeUsd = normalizeTradeUsd(tradeUsdInput);
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(cleanedMint)) {
    const error = new Error("Invalid Solana mint address.");
    error.statusCode = 400;
    throw error;
  }

  return cached(`scan:${cleanedMint}:${tradeUsd}`, async () => {
    const [accountResult, supplyResult, holdersResult, marketResult] = await Promise.all([
      safeRpc("getAccountInfo", [cleanedMint, { encoding: "jsonParsed", commitment: "confirmed" }]),
      safeRpc("getTokenSupply", [cleanedMint, { commitment: "confirmed" }]),
      safeRpc("getTokenLargestAccounts", [cleanedMint, { commitment: "confirmed" }]),
      fetchDexScreener(cleanedMint).catch((error) => ({
        error: error.message,
        pairs: [],
        bestPair: null,
        totals: null,
      })),
    ]);

    if (!accountResult.ok) throw new Error(accountResult.error);
    const parsed = accountResult.value?.value?.data?.parsed;
    if (!parsed || parsed.type !== "mint") {
      const error = new Error("That address is not a parsed SPL token mint.");
      error.statusCode = 400;
      throw error;
    }
    if (!supplyResult.ok) throw new Error(supplyResult.error);

    const mintInfo = parsed.info;
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
    const market = {
      pairs: marketResult.pairs ?? [],
      bestPair: marketResult.bestPair ?? null,
      totals: marketResult.totals ?? null,
    };
    const warnings = [];

    if (!holdersResult.ok) warnings.push(`Largest-account lookup failed: ${holdersResult.error}`);
    if (marketResult.error) warnings.push(`DEX market lookup failed: ${marketResult.error}`);

    const execution = buildExecution(market, tradeUsd);
    const verdict = scoreScan({ mintInfo, holders, market, execution, warnings });
    const sample = SAMPLE_TOKENS.find((token) => token.mint === cleanedMint);

    const scan = {
      id: `${Date.now()}-${cleanedMint.slice(0, 8)}`,
      scannedAt: new Date().toISOString(),
      mint: cleanedMint,
      name: market.bestPair?.baseToken?.name ?? sample?.name ?? "Unknown token",
      symbol: market.bestPair?.baseToken?.symbol ?? sample?.symbol ?? "UNKNOWN",
      network: "solana-mainnet",
      rpcUrl: RPC_URL,
      mintInfo: {
        decimals: mintInfo.decimals,
        isInitialized: mintInfo.isInitialized,
        mintAuthority: mintInfo.mintAuthority,
        freezeAuthority: mintInfo.freezeAuthority,
        supply: supplyResult.value.value.uiAmountString,
        rawSupply: supplyResult.value.value.amount,
      },
      holders,
      market,
      execution,
      verdict,
    };

    await saveHistory({
      id: scan.id,
      scannedAt: scan.scannedAt,
      mint: scan.mint,
      name: scan.name,
      symbol: scan.symbol,
      score: scan.verdict.score,
      level: scan.verdict.level,
      tradeUsd: scan.execution.tradeUsd,
      decision: scan.execution.decision,
      priceUsd: scan.market.bestPair?.priceUsd ?? null,
      liquidityUsd: scan.market.totals?.liquidityUsd ?? null,
    });

    return scan;
  });
};

const handleApi = async (response, url) => {
  try {
    if (url.pathname === "/api/tokens") {
      sendJson(response, 200, { tokens: SAMPLE_TOKENS });
      return;
    }

    if (url.pathname === "/api/history") {
      sendJson(response, 200, { scans: await loadHistory() });
      return;
    }

    if (url.pathname === "/api/scan") {
      const mint = url.searchParams.get("mint");
      const tradeUsd = url.searchParams.get("tradeUsd");
      if (!mint) {
        sendJson(response, 400, { error: "Missing mint query parameter." });
        return;
      }
      sendJson(response, 200, await buildScan(mint, tradeUsd));
      return;
    }

    sendJson(response, 404, { error: "Unknown API route." });
  } catch (error) {
    sendJson(response, error.statusCode ?? 500, { error: error.message });
  }
};

const proxyRpc = async (request, response) => {
  try {
    const body = await readBody(request);
    const rpcResponse = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    send(response, rpcResponse.status, await rpcResponse.text(), {
      "content-type": rpcResponse.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    });
  } catch (error) {
    sendJson(response, 502, {
      jsonrpc: "2.0",
      error: { code: -32000, message: error.message },
    });
  }
};

const serveStatic = async (request, response, url) => {
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = normalize(join(ROOT, requestedPath));

  if (!filePath.startsWith(ROOT)) {
    send(response, 403, "Forbidden");
    return;
  }

  try {
    const file = await readFile(filePath);
    send(response, 200, request.method === "HEAD" ? "" : file, {
      "content-type": contentTypes[extname(filePath)] ?? "application/octet-stream",
    });
  } catch {
    send(response, 404, "Not found");
  }
};

createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (url.pathname.startsWith("/api/")) {
    void handleApi(response, url);
    return;
  }

  if (url.pathname === "/rpc" && request.method === "POST") {
    void proxyRpc(request, response);
    return;
  }

  if (request.method === "GET" || request.method === "HEAD") {
    void serveStatic(request, response, url);
    return;
  }

  send(response, 405, "Method not allowed");
}).listen(PORT, () => {
  console.log(`Axiom Token Preflight running at http://localhost:${PORT}`);
  console.log(`Solana RPC: ${RPC_URL}`);
});
