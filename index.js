// index.js
/* eslint-disable no-console */
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

// ----------- CONFIG -----------
const PORT = process.env.PORT || 10000;
const RPC_URL =
  process.env.RPC_URL ||
  "https://api.mainnet-beta.solana.com"; // Prefer your Helius RPC here
const BIRDEYE_KEY = process.env.BIRDEYE_API_KEY;
const ALLOWED = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

if (!BIRDEYE_KEY) {
  console.warn("⚠️ Missing BIRDEYE_API_KEY env var.");
}

const app = express();
app.use(express.json({ limit: "1mb" }));

// CORS
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || ALLOWED.includes("*") || ALLOWED.includes(origin)) {
        return cb(null, true);
      }
      return cb(new Error("Not allowed by CORS"), false);
    },
    credentials: false,
  })
);

// ----------- HELPERS -----------

// super tiny TTL cache in memory
const cache = new Map();
function setCache(key, value, ttlMs = 60_000) {
  cache.set(key, { value, exp: Date.now() + ttlMs });
}
function getCache(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.exp) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

async function rpc(method, params) {
  const body = { jsonrpc: "2.0", id: crypto.randomUUID(), method, params };
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`RPC ${method} failed: ${res.status} ${txt}`);
  }
  const json = await res.json();
  if (json.error) throw new Error(`RPC error: ${json.error.message}`);
  return json.result;
}

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnB7yVqjvG9S7";
const SOL_MINT = "So11111111111111111111111111111111111111112"; // for pricing

async function getTokenAccountsByOwner(owner, programId) {
  return rpc("getTokenAccountsByOwner", [
    owner,
    { programId },
    { encoding: "jsonParsed", commitment: "confirmed" },
  ]);
}

async function getSolBalance(owner) {
  const r = await rpc("getBalance", [owner, { commitment: "confirmed" }]);
  return (r?.value ?? 0) / 1e9; // lamports -> SOL
}

async function birdeye(path, params = {}) {
  const url = new URL(`https://public-api.birdeye.so${path}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  });
  const key = `be:${url.toString()}`;
  const cached = getCache(key);
  if (cached) return cached;

  // simple retry/backoff for 429
  let lastErr;
  for (let i = 0; i < 3; i++) {
    const res = await fetch(url, {
      headers: {
        accept: "application/json",
        "x-chain": "solana",
        "X-API-KEY": BIRDEYE_KEY || "",
      },
    });
    if (res.status === 429) {
      await new Promise(r => setTimeout(r, 300 * (i + 1)));
      lastErr = new Error("Birdeye rate limited");
      continue;
    }
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(
        `Birdeye ${path} failed: ${res.status} ${txt || res.statusText}`
      );
    }
    const json = await res.json();
    setCache(key, json, 30_000);
    return json;
  }
  throw lastErr || new Error("Birdeye request failed");
}

// fetch price for a single mint (kept simple & robust)
async function getPriceUSD(mint) {
  if (!mint) return null;
  const key = `price:${mint}`;
  const cached = getCache(key);
  if (cached !== null) return cached;

  // Birdeye single-price endpoint
  // docs typically: /defi/price?address=<mint>
  const data = await birdeye("/defi/price", { address: mint });
  const price = data?.data?.value ?? data?.data?.price ?? null;
  setCache(key, price, 45_000);
  return price;
}

// ----------- ROUTES -----------

// health
app.get("/", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "wallet + buys proxy",
    time: new Date().toISOString(),
  });
});

// 1) Wallet snapshot (balances + USD)
app.get("/wallet", async (req, res) => {
  try {
    const owner = String(req.query.address || "").trim();
    const minUsd = Number(req.query.minUsd ?? 0); // filter dust
    const maxTokens = Math.min(Number(req.query.maxTokens ?? 50), 200);

    if (!owner) return res.status(400).json({ error: "address required" });

    // gather SPL balances from both token programs
    const [classic, t22] = await Promise.all([
      getTokenAccountsByOwner(owner, TOKEN_PROGRAM),
      getTokenAccountsByOwner(owner, TOKEN_2022),
    ]);

    const rows = []
      .concat(classic?.value || [], t22?.value || [])
      .map((it) => it?.account?.data?.parsed?.info)
      .filter(Boolean);

    // aggregate by mint
    const mapByMint = new Map();
    for (const r of rows) {
      const mint = r?.mint;
      const ta = r?.tokenAmount;
      if (!mint || !ta) continue;
      const ui = Number(ta.uiAmountString ?? ta.uiAmount ?? 0);
      if (!mapByMint.has(mint)) {
        mapByMint.set(mint, {
          mint,
          amount: 0,
          decimals: ta.decimals ?? 0,
        });
      }
      const agg = mapByMint.get(mint);
      agg.amount += ui;
      // keep max decimals seen
      agg.decimals = Math.max(agg.decimals, ta.decimals ?? 0);
    }

    // include SOL
    let solAmount = 0;
    try {
      solAmount = await getSolBalance(owner);
      if (solAmount > 0) {
        mapByMint.set(SOL_MINT, { mint: SOL_MINT, amount: solAmount, decimals: 9 });
      }
    } catch (_) {}

    // turn into array, cap tokens to price (top balances first)
    let items = Array.from(mapByMint.values()).sort(
      (a, b) => b.amount - a.amount
    );
    items = items.slice(0, maxTokens);

    // price each mint (sequential but cached; keeps under Birdeye limits)
    let totalUsd = 0;
    for (const it of items) {
      const price = await getPriceUSD(it.mint);
      const usd = price ? price * it.amount : null;
      it.price = price;
      it.usd = usd;
      if (usd) totalUsd += usd;
    }

    // optional dust filter
    if (minUsd > 0) {
      items = items.filter((it) => (it.usd || 0) >= minUsd);
    }

    res.json({
      address: owner,
      count: items.length,
      totalUsd,
      tokens: items.sort((a, b) => (b.usd || 0) - (a.usd || 0)),
      updatedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error("wallet error:", e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// 2) Last 10 buys (Birdeye)
app.get("/buys", async (req, res) => {
  try {
    const type = (req.query.type || "token").toString(); // token | pair
    const address = (req.query.address || "").toString();
    const limit = Math.min(Number(req.query.limit || 10), 100);

    if (!address) return res.status(400).json({ error: "address required" });
    if (!["token", "pair"].includes(type))
      return res.status(400).json({ error: "invalid type" });

    const data = await birdeye("/defi/trades", {
      address,
      type,
      offset: 0,
      limit,
      sort_type: "desc",
    });

    // normalize: keep only buys
    const rows = (data?.data?.items || []).filter(
      (t) => (t?.side || "").toLowerCase() === "buy"
    );

    const out = rows.map((t) => ({
      tx: t?.txHash || t?.txHashAll || t?.tx || "",
      time: t?.blockUnixTime || t?.blockTime || null,
      price: t?.price || t?.priceUsd || null,
      amountToken: t?.baseAmount ?? t?.amount ?? null,
      amountQuote: t?.quoteAmount ?? null,
      maker: t?.maker || null,
      taker: t?.taker || null,
      market: t?.marketId || t?.pairAddress || null,
      dex: t?.dex || t?.dexName || null,
    }));

    res.json({ type, address, count: out.length, items: out });
  } catch (e) {
    const msg = String(e.message || e);
    const is429 = /rate limited|429/.test(msg);
    console.error("buys error:", msg);
    res.status(is429 ? 429 : 500).json({ error: msg });
  }
});

// 3) Your original passthrough (kept for compatibility)
app.get("/birdeye", async (req, res) => {
  try {
    const type = String(req.query.type || "token");
    const address = String(req.query.address || "");
    const limit = Math.min(Number(req.query.limit || 100), 500);

    if (!address) return res.status(400).json({ error: "address required" });
    if (!["token", "pair", "markets"].includes(type))
      return res.status(400).json({ error: "invalid type" });

    if (type === "markets") {
      const data = await birdeye("/defi/markets", { address, chain: "solana" });
      return res.json(data);
    }

    const data = await birdeye("/defi/trades", {
      type,
      address,
      limit,
      offset: 0,
      sort_type: "desc",
    });
    res.json(data);
  } catch (e) {
    const msg = String(e.message || e);
    const is429 = /rate limited|429/.test(msg);
    console.error("proxy error:", msg);
    res.status(is429 ? 429 : 500).json({ error: msg });
  }
});

app.listen(PORT, () => {
  console.log(`Wallet + Birdeye proxy listening on :${PORT}`);
});
