const form = document.querySelector("#scan-form");
const mintInput = document.querySelector("#mint");
const tradeSizeInput = document.querySelector("#trade-size");
const statusEl = document.querySelector("#status");
const samplesEl = document.querySelector("#samples");
const scoreEl = document.querySelector("#score");
const riskLabelEl = document.querySelector("#risk-label");
const recommendedActionEl = document.querySelector("#recommended-action");
const tokenNameEl = document.querySelector("#token-name");
const tokenMetaEl = document.querySelector("#token-meta");
const priceEl = document.querySelector("#price");
const liquidityEl = document.querySelector("#liquidity");
const volumeEl = document.querySelector("#volume");
const changeEl = document.querySelector("#change");
const mintAuthorityEl = document.querySelector("#mint-authority");
const freezeAuthorityEl = document.querySelector("#freeze-authority");
const executionDecisionEl = document.querySelector("#execution-decision");
const executionReasonEl = document.querySelector("#execution-reason");
const priceImpactEl = document.querySelector("#price-impact");
const impactCostEl = document.querySelector("#impact-cost");
const cleanSizeEl = document.querySelector("#clean-size");
const reviewSizeEl = document.querySelector("#review-size");
const findingsList = document.querySelector("#findings-list");
const scanTimeEl = document.querySelector("#scan-time");
const topHolderEl = document.querySelector("#top-holder");
const topTenEl = document.querySelector("#top-ten");
const holderStatusEl = document.querySelector("#holder-status");
const holdersBody = document.querySelector("#holders-body");
const pairsList = document.querySelector("#pairs-list");
const pairCountEl = document.querySelector("#pair-count");
const historyList = document.querySelector("#history-list");

const shortAddress = (address) => {
  if (!address) return "None";
  return `${address.slice(0, 5)}...${address.slice(-5)}`;
};

const formatUsd = (value, maximumFractionDigits = 2) => {
  if (value === null || value === undefined) return "--";
  if (value > 0 && value < 0.01) return `$${value.toPrecision(3)}`;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits,
  }).format(value);
};

const formatNumber = (value) => {
  if (value === null || value === undefined) return "--";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(Number(value));
};

const formatPct = (value) => {
  if (value === null || value === undefined) return "--";
  return `${Number(value).toFixed(2)}%`;
};

const api = async (path) => {
  const response = await fetch(path);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? "Request failed.");
  return payload;
};

const setLoading = (isLoading) => {
  form.querySelector("button[type='submit']").disabled = isLoading;
  document.body.classList.toggle("is-loading", isLoading);
};

const setStatus = (message, tone = "neutral") => {
  statusEl.textContent = message;
  statusEl.dataset.tone = tone;
};

const setVerdict = (verdict) => {
  const level = verdict?.level ?? "neutral";
  const label = level === "high" ? "High risk" : level === "medium" ? "Needs review" : level === "low" ? "Cleaner" : "Waiting";
  scoreEl.textContent = verdict ? verdict.score : "--";
  riskLabelEl.textContent = label;
  riskLabelEl.className = `pill ${level}`;
  recommendedActionEl.textContent = verdict?.action ?? "Run a scan to generate an action.";
};

const renderExecution = (execution) => {
  executionDecisionEl.textContent = execution?.decision ?? "--";
  executionDecisionEl.className = execution?.level ?? "";
  executionReasonEl.textContent =
    execution?.reason ?? "Enter a trade size to estimate whether the current pool depth can handle it.";
  priceImpactEl.textContent = formatPct(execution?.priceImpactPct);
  impactCostEl.textContent =
    execution?.estimatedCostPct === null || execution?.estimatedCostPct === undefined
      ? "No usable pool depth returned."
      : `Estimated impact plus 0.30% fee buffer: ${formatPct(execution.estimatedCostPct)}.`;
  cleanSizeEl.textContent = formatUsd(execution?.cleanMaxUsd, 0);
  reviewSizeEl.textContent = formatUsd(execution?.reviewMaxUsd, 0);
};

const renderFindings = (findings = []) => {
  findingsList.replaceChildren();
  if (!findings.length) {
    const item = document.createElement("li");
    item.className = "empty";
    item.innerHTML = "<strong>No findings yet</strong><span>Run a scan to generate the risk report.</span>";
    findingsList.appendChild(item);
    return;
  }

  findings.forEach((finding) => {
    const item = document.createElement("li");
    item.className = finding.tone;
    item.innerHTML = `<strong>${finding.title}</strong><span>${finding.body}</span>`;
    findingsList.appendChild(item);
  });
};

const renderHolders = (holders) => {
  holdersBody.replaceChildren();
  topHolderEl.textContent = formatPct(holders?.topOnePct);
  topTenEl.textContent = formatPct(holders?.topTenPct);
  holderStatusEl.textContent = holders?.available ? "Live RPC" : "Limited";

  if (!holders?.available) {
    const row = document.createElement("tr");
    row.innerHTML = `<td colspan="3">Largest-account data is unavailable from the current public RPC.</td>`;
    holdersBody.appendChild(row);
    return;
  }

  holders.rows.forEach((holder, index) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${index + 1}</td>
      <td title="${holder.address}">${shortAddress(holder.address)}</td>
      <td>${formatPct(holder.pct)}</td>
    `;
    holdersBody.appendChild(row);
  });
};

const renderPairs = (market) => {
  pairsList.replaceChildren();
  const pairs = market?.pairs ?? [];
  pairCountEl.textContent = `${pairs.length} pairs`;

  if (!pairs.length) {
    const empty = document.createElement("p");
    empty.className = "empty-copy";
    empty.textContent = "No Solana DEX pairs returned by DexScreener.";
    pairsList.appendChild(empty);
    return;
  }

  pairs.slice(0, 5).forEach((pair) => {
    const card = document.createElement("a");
    card.className = "pair-row";
    card.href = pair.url;
    card.target = "_blank";
    card.rel = "noreferrer";
    card.innerHTML = `
      <div>
        <strong>${pair.dexId}</strong>
        <span>${pair.baseToken?.symbol ?? "TOKEN"} / ${pair.quoteToken?.symbol ?? "QUOTE"}</span>
      </div>
      <div>
        <span>Liquidity</span>
        <strong>${formatUsd(pair.liquidityUsd, 0)}</strong>
      </div>
      <div>
        <span>24h vol</span>
        <strong>${formatUsd(pair.volume24h, 0)}</strong>
      </div>
    `;
    pairsList.appendChild(card);
  });
};

const renderHistory = async () => {
  const { scans } = await api("/api/history");
  historyList.replaceChildren();

  if (!scans.length) {
    const empty = document.createElement("p");
    empty.className = "empty-copy";
    empty.textContent = "Scans will appear here after the first preflight.";
    historyList.appendChild(empty);
    return;
  }

  scans.forEach((scan) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "history-row";
    button.dataset.mint = scan.mint;
    button.innerHTML = `
      <span>
        <strong>${scan.symbol}</strong>
        ${shortAddress(scan.mint)}
      </span>
      <b class="${scan.level}">${scan.score}</b>
    `;
    button.addEventListener("click", () => {
      mintInput.value = scan.mint;
      tradeSizeInput.value = scan.tradeUsd ?? tradeSizeInput.value;
      form.requestSubmit();
    });
    historyList.appendChild(button);
  });
};

const renderScan = (scan) => {
  const bestPair = scan.market.bestPair;
  const totals = scan.market.totals;

  setVerdict(scan.verdict);
  tokenNameEl.textContent = `${scan.symbol} · ${scan.name}`;
  tokenMetaEl.textContent = `${scan.network} · ${shortAddress(scan.mint)} · ${scan.mintInfo.decimals} decimals`;
  priceEl.textContent = formatUsd(bestPair?.priceUsd, bestPair?.priceUsd && bestPair.priceUsd < 0.01 ? 8 : 4);
  liquidityEl.textContent = formatUsd(totals?.liquidityUsd, 0);
  volumeEl.textContent = formatUsd(totals?.volume24h, 0);
  changeEl.textContent = bestPair?.priceChange24h === null || bestPair?.priceChange24h === undefined ? "--" : formatPct(bestPair.priceChange24h);
  changeEl.className = bestPair?.priceChange24h < 0 ? "negative" : "positive";
  mintAuthorityEl.textContent = scan.mintInfo.mintAuthority ? shortAddress(scan.mintInfo.mintAuthority) : "Renounced";
  freezeAuthorityEl.textContent = scan.mintInfo.freezeAuthority ? shortAddress(scan.mintInfo.freezeAuthority) : "Disabled";
  scanTimeEl.textContent = new Date(scan.scannedAt).toLocaleString();

  renderExecution(scan.execution);
  renderFindings(scan.verdict.findings);
  renderHolders(scan.holders);
  renderPairs(scan.market);
};

const runScan = async (mint, tradeUsd) => {
  setLoading(true);
  setStatus("Scanning token risk and trade-size depth...");

  try {
    const scan = await api(`/api/scan?mint=${encodeURIComponent(mint)}&tradeUsd=${encodeURIComponent(tradeUsd)}`);
    renderScan(scan);
    await renderHistory();
    setStatus("Preflight complete.", "good");
  } catch (error) {
    setStatus(error.message, "bad");
    renderFindings([{ tone: "warn", title: "Scan failed", body: error.message }]);
  } finally {
    setLoading(false);
  }
};

const loadSamples = async () => {
  const { tokens } = await api("/api/tokens");
  samplesEl.replaceChildren();
  tokens.forEach((token) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.mint = token.mint;
    button.innerHTML = `<strong>${token.symbol}</strong><span>${token.thesis}</span>`;
    button.addEventListener("click", () => {
      mintInput.value = token.mint;
      form.requestSubmit();
    });
    samplesEl.appendChild(button);
  });
};

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const mint = mintInput.value.trim();
  const tradeUsd = tradeSizeInput.value.trim() || "250";
  if (!mint) {
    setStatus("Paste a Solana token mint first.", "bad");
    return;
  }
  void runScan(mint, tradeUsd);
});

renderFindings();
await loadSamples();
await renderHistory();

if (new URLSearchParams(window.location.search).get("scan") === "1") {
  form.requestSubmit();
}
