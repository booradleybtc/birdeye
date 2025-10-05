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
app.disable("etag");
app.use(cors({ origin: "*", maxAge: 0 }));
app.use((req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  next();
});

// tiny TTL cache
const cache = new Map();
const getCache = (k, ttl = 10000) => {
  const v = cache.get(k);
  if (v && Date.now() - v.ts < ttl) return v.data;
  return null;
};
const setCache = (k, data) => cache.set(k, { ts: Date.now(), data });

const BE = "https://public-api.birdeye.so";
const beHeaders = { "X-API-KEY": BIRDEYE_KEY, accept: "application/json" };
const WSOL = "So11111111111111111111111111111111111111112";

// Jupiter token list (symbols/logos/decimals)
let jupMap = new Map();
async function loadJup() {
  try {
    const r = await fetch("https://token.jup.ag/all");
    const list = await r.json();
    jupMap = new Map(list.map(t => [t.address, t]));
    console.log(`Loaded Jupiter list: ${list.length} tokens`);
  } catch (e) {
    console.error("Failed to load Jupiter list", e);
  }
}
await loadJup();
setInterval(loadJup, 24 * 60 * 60 * 1000);

// RPC
const conn = new Connection(RPC_URL, "confirmed");

// ---- Birdeye price helpers ----
async function getPrice(address) {
  try {
    const u = new URL(`${BE}/defi/price`);
    u.searchParams.set("address", address);
    const r = await fetch(u, { headers: beHeaders });
    if (!r.ok) return 0;
    const j = await r.json();
    const d = j.data;
    if (typeof d === "number") return d;
    if (d?.value != null) return Number(d.value) || 0;
    if (d?.price != null) return Number(d.price) || 0;
    return 0;
  } catch {
    return 0;
  }
}

async function getPrices(addresses) {
  const uniq = [...new Set(addresses)];
  const out = {};
  const BATCH = 6;
  for (let i = 0; i < uniq.length; i += BATCH) {
    const chunk = uniq.slice(i, i + BATCH);
    const vals = await Promise.all(chunk.map(a => getPrice(a)));
    chunk.forEach((a, idx) => (out[a] = vals[idx] || 0));
  }
  return out;
}

// ================= WALLET =================
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

    // SOL balance
    const lamports = await conn.getBalance(owner, "confirmed");
    const sol = lamports / LAMPORTS_PER_SOL;

    // SPL token accounts
    const { value } = await conn.getParsedTokenAccountsByOwner(owner, {
      programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    });

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

    const mints = [...new Set(tokens.map(t => t.mint))];

    // prices (tokens + WSOL for SOL)
    const priceMap = await getPrices([...mints, WSOL]);
    const solPrice = priceMap[WSOL] || 0;

    tokens = tokens
      .map(t => {
        const meta = jupMap.get(t.mint) || {};
        const priceUsd = Number(priceMap[t.mint] || 0);
        const usd = priceUsd * t.amount;
        return {
          mint: t.mint,
          symbol: meta.symbol || "",
          name: meta.name || "",
          logo: meta.logoURI || "",
          amount: t.amount,
          priceUsd,
          usd,
          decimals: t.decimals,
        };
      })
      .sort((a, b) => (b.usd || 0) - (a.usd || 0));

    // Show tokens even if price unknown; minUsd only hides priced ones
    const visible = tokens
      .filter(t => (t.priceUsd > 0 ? t.usd >= minUsd : true))
      .slice(0, maxTokens);

    const snapshot = {
      owner: ownerStr,
      updated: new Date().toISOString(),
      sol,
      solUsd: sol * solPrice,
      totalUsd: visible.reduce((s, t) => s + (t.usd || 0), sol * solPrice),
      tokens: visible,
    };

    setCache(key, snapshot);
    res.json(snapshot);
  } catch (e) {
    console.error("wallet error", e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ================= BUYS ===================
// ?type=token|pair&address=...&limit=10&minUsd=0
app.get("/buys", async (req, res) => {
  try {
    let typ = String(req.query.type ?? req.query.kind ?? "token").toLowerCase();
    if (typ !== "token" && typ !== "pair") typ = "token"; // guard 'undefined'
    const address = String(req.query.address || "").trim();
    const limit = Math.min(Number(req.query.limit ?? 10), 100);
    const minUsd = Number(req.query.minUsd ?? 0);
    if (!address) return res.status(400).json({ error: "Missing address" });

    const key = `buys:${typ}:${address}:${limit}:${minUsd}`;
    const cached = getCache(key, 10000);
    if (cached) return res.json(cached);

    async function fetchTrades(endpoint) {
      const url = new URL(`${BE}${endpoint}`);
      url.searchParams.set("address", address);
      url.searchParams.set("limit", String(Math.max(limit, 20)));
      const r = await fetch(url, { headers: beHeaders });
      if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
      const j = await r.json();
      return j.data || j.results || j.items || [];
    }

    let rows = [];
    try {
      rows = await fetchTrades("/defi/trades");
    } catch {
      try { rows = await fetchTrades("/defi/txs"); } catch {}
      if (!Array.isArray(rows)) rows = [];
    }

    const items = rows
      .map(x => {
        const side = [
          x.side, x.tradeType, x.type, x.action,
          (x.is_buy === true ? "buy" : ""), (x.isBuyer === true ? "buy" : "")
        ]
          .filter(Boolean)
          .map(s => String(s).toLowerCase())
          .join(" ");

        const isBuy = /\bbuy\b/.test(side);
        const usd = Number(x.volume_usd ?? x.usdValue ?? x.value_usd ?? x.totalUsd ?? 0) || 0;
        const qty = Number(x.amountToken ?? x.base_amount ?? x.amount ?? x.size ?? 0) || 0;
        const price = Number(x.priceUsd ?? x.price_usd ?? x.price ?? 0) || 0;
        const when =
          Number(x.ts) ||
          Number(x.blockUnixTime) ||
          (x.blockTime ? Number(x.blockTime) : 0) * 1000;
        return {
          isBuy,
          usd,
          qty,
          priceUsd: price,
          symbol: x.symbol || x.base_symbol || x.baseSymbol || "",
          dex: x.dex || x.market || x.source || "",
          tx: x.txHash || x.tx_hash || x.signature || "",
          time: when ? new Date(when).toISOString() : undefined,
        };
      })
      .filter(i => i.isBuy && i.usd >= minUsd)
      .slice(0, limit);

    const payload = { type: typ, address, items };
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
