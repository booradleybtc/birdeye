// index.js
import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";

const PORT = process.env.PORT || 10000;
const BIRDEYE_KEY = process.env.BIRDEYE_KEY;
const RPC_URL = process.env.RPC_URL;

if (!BIRDEYE_KEY) throw new Error("Missing BIRDEYE_KEY");
if (!RPC_URL) throw new Error("Missing RPC_URL");

const app = express();

// CORS + disable caching/etags to avoid 304s in Framer
app.disable("etag");
app.use(cors({ origin: "*", maxAge: 0 }));
app.use((req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  next();
});

// --- tiny in-memory cache to reduce 429s ---
const cache = new Map(); // key -> { ts, data }
const getCache = (key, ttlMs = 10000) => {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < ttlMs) return hit.data;
  return null;
};
const setCache = (key, data) => cache.set(key, { ts: Date.now(), data });

// --- shared helpers ---
const BE = "https://public-api.birdeye.so";
const beHeaders = { "X-API-KEY": BIRDEYE_KEY, accept: "application/json" };

// Load Jupiter token list once (symbols, logos, decimals)
let jupMap = new Map();
async function loadJup() {
  try {
    const r = await fetch("https://token.jup.ag/all");
    const list = await r.json();
    jupMap = new Map(list.map(t => [t.address, t]));
    console.log(`Loaded Jupiter list: ${list.length} tokens`);
  } catch (e) {
    console.error("Failed to load Jupiter token list", e);
  }
}
await loadJup();
// refresh daily
setInterval(loadJup, 24 * 60 * 60 * 1000);

// --- RPC connection ---
const conn = new Connection(RPC_URL, "confirmed");

// =============== WALLET SNAPSHOT =================
app.get("/wallet", async (req, res) => {
  try {
    const ownerStr = String(req.query.address || "").trim();
    const minUsd = Number(req.query.minUsd ?? 0);
    const maxTokens = Number(req.query.maxTokens ?? 25);
    if (!ownerStr) return res.status(400).json({ error: "Missing address" });
    const owner = new PublicKey(ownerStr);

    const key = `wallet:${ownerStr}:${minUsd}:${maxTokens}`;
    const cached = getCache(key, 10000);
    if (cached) return res.json(cached);

    // Native SOL
    const lamports = await conn.getBalance(owner, "confirmed");
    const sol = lamports / LAMPORTS_PER_SOL;

    // SPL tokens (parsed)
    const { value } = await conn.getParsedTokenAccountsByOwner(owner, {
      programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
    });

    // Map accounts -> amounts
    let tokens = value
      .map(v => {
        const info = v.account.data.parsed.info;
        const mint = info.mint;
        const tk = info.tokenAmount;
        const amount = Number(tk.uiAmount || 0);
        const decimals = Number(tk.decimals || 0);
        return { mint, amount, decimals };
      })
      .filter(t => t.amount > 0);

    // Enrich with Jupiter meta and Birdeye price
    const mints = [...new Set(tokens.map(t => t.mint))];
    // Fetch prices from Birdeye in batch (graceful if it fails)
    let prices = {};
    try {
      const u = new URL(`${BE}/defi/price`);
      u.searchParams.set("address", mints.join(","));
      const pr = await fetch(u, { headers: beHeaders });
      const pj = await pr.json();
      // Birdeye returns { data: { [mint]: { value: price } } } or array – normalize:
      const d = pj.data || {};
      for (const k of Object.keys(d)) {
        const val = d[k]?.value ?? d[k]?.price ?? d[k];
        if (typeof val === "number") prices[k] = val;
      }
    } catch (_) {}

    // Compose rows
    tokens = tokens
      .map(t => {
        const meta = jupMap.get(t.mint) || {};
        const price = prices[t.mint] ?? 0;
        return {
          mint: t.mint,
          symbol: meta.symbol || "",
          name: meta.name || "",
          logo: meta.logoURI || "",
          amount: t.amount,
          priceUsd: price,
          usd: price * t.amount,
          decimals: t.decimals
        };
      })
      .sort((a, b) => (b.usd || 0) - (a.usd || 0));

    // Trim + filter by minUsd
    const visible = tokens.filter(t => (t.usd || 0) >= minUsd).slice(0, maxTokens);

    const solPrice = prices["So11111111111111111111111111111111111111112"] ?? prices["SOL"] ?? 0;
    const snapshot = {
      owner: ownerStr,
      updated: new Date().toISOString(),
      sol,
      solUsd: sol * solPrice,
      totalUsd: visible.reduce((s, t) => s + (t.usd || 0), sol * solPrice),
      tokens: visible
    };

    setCache(key, snapshot);
    res.json(snapshot);
  } catch (e) {
    console.error("wallet error", e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// =============== RECENT BUYS =====================
// Accepts ?type=token|pair&address=...&limit=10&minUsd=0
app.get("/buys", async (req, res) => {
  try {
    const type = String(req.query.type || req.query.kind || "token").toLowerCase();
    const address = String(req.query.address || "").trim();
    const limit = Math.min(Number(req.query.limit ?? 10), 100);
    const minUsd = Number(req.query.minUsd ?? 0);
    if (!address) return res.status(400).json({ error: "Missing address" });

    const key = `buys:${type}:${address}:${limit}:${minUsd}`;
    const cached = getCache(key, 10000);
    if (cached) return res.json(cached);

    // Birdeye trades endpoint; supports token or pair address
    // Docs vary; we try /defi/trades first, then fallback to /defi/txs if needed.
    async function fetchTrades(endpoint) {
      const url = new URL(`${BE}${endpoint}`);
      url.searchParams.set("address", address);
      url.searchParams.set("limit", String(Math.max(limit, 20))); // fetch extra, we'll filter
      const r = await fetch(url, { headers: beHeaders });
      if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
      const j = await r.json();
      return j.data || j.results || j.items || [];
    }

    let rows = [];
    try {
      rows = await fetchTrades("/defi/trades");
    } catch {
      // fallback(s)
      try { rows = await fetchTrades("/defi/txs"); } catch {}
      if (!Array.isArray(rows)) rows = [];
    }

    // Normalize & filter buys (Birdeye names differ across endpoints)
    const items = rows
      .map(x => {
        // possible shapes:
        // { side: "buy"|"sell", priceUsd, amountToken, symbol, txHash, dex, ts }
        // { is_buy: true/false, price, volume_usd, base_mint, quote_mint, tx_hash, market, blockUnixTime }
        const side = (x.side || (x.is_buy ? "buy" : "sell") || "").toString().toLowerCase();
        const isBuy = side === "buy" || x.is_buy === true;
        const usd = Number(x.volume_usd ?? x.usdValue ?? x.value_usd ?? 0);
        const qty = Number(x.amountToken ?? x.base_amount ?? x.amount ?? 0);
        const price = Number(x.priceUsd ?? x.price_usd ?? x.price ?? 0);
        const when =
          Number(x.ts) ||
          Number(x.blockUnixTime) ||
          (x.blockTime ? Number(x.blockTime) : 0) * 1000;
        return {
          isBuy,
          usd,
          qty,
          priceUsd: price,
          symbol: x.symbol || x.base_symbol || "",
          dex: x.dex || x.market || "",
          tx: x.txHash || x.tx_hash || "",
          time: when ? new Date(when).toISOString() : undefined
        };
      })
      .filter(i => i.isBuy && i.usd >= minUsd)
      .slice(0, limit);

    const payload = { type, address, items };
    setCache(key, payload);
    res.json(payload);
  } catch (e) {
    console.error("buys error", e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// health
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "wallet + buys proxy", time: new Date().toISOString() });
});

app.listen(PORT, () => console.log(`proxy listening on :${PORT}`));
