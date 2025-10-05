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
app.use((_, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  next();
});

// tiny TTL cache
const cache = new Map();
const getCache = (k, ttl = 10000) => {
  const v = cache.get(k);
  return v && Date.now() - v.ts < ttl ? v.data : null;
};
const setCache = (k, data) => cache.set(k, { ts: Date.now(), data });

const BE = "https://public-api.birdeye.so";
const beHeaders = { "X-API-KEY": BIRDEYE_KEY, accept: "application/json" };
const WSOL = "So11111111111111111111111111111111111111112";
const TOKEN_LEGACY = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

// Jupiter token list for nice names/logos
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

const conn = new Connection(RPC_URL, "confirmed");

// --------- Birdeye price helpers ----------
async function beJson(url) {
  const r = await fetch(url, { headers: beHeaders });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}
async function getPrice(address) {
  try {
    const u = new URL(`${BE}/defi/price`);
    u.searchParams.set("address", address);
    const j = await beJson(u);
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

// ---------- WALLET ----------
app.get("/wallet", async (req, res) => {
  try {
    const ownerStr = String(req.query.address || "").trim();
    const minUsd = Number(req.query.minUsd ?? 0);
    const maxTokens = Number(req.query.maxTokens ?? 25);
    if (!ownerStr) return res.status(400).json({ error: "Missing address" });
    const owner = new PublicKey(ownerStr);

    const cacheKey = `wallet:${ownerStr}:${minUsd}:${maxTokens}`;
    const cached = getCache(cacheKey, 10000);
    if (cached) return res.json(cached);

    // SOL balance
    const lamports = await conn.getBalance(owner, "confirmed");
    const sol = lamports / LAMPORTS_PER_SOL;

    // SPL accounts from BOTH programs
    const [legacy, t22] = await Promise.all([
      conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_LEGACY }),
      conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022 }),
    ]);
    const accounts = [...legacy.value, ...t22.value];

    let tokens = accounts
      .map(v => {
        const info = v.account.data.parsed.info;
        const mint = info.mint;
        const ta = info.tokenAmount;
        const amount = Number(ta.uiAmount || 0);
        const decimals = Number(ta.decimals || 0);
        return { mint, amount, decimals };
      })
      .filter(t => t.amount > 0);

    const mints = [...new Set(tokens.map(t => t.mint))];

    // prices (tokens + WSOL for SOL USD)
    const priceMap = await getPrices([...mints, WSOL]);
    const solPrice = priceMap[WSOL] || 0;

    tokens = tokens
      .map(t => {
        const meta = jupMap.get(t.mint) || {};
        const priceUsd = Number(priceMap[t.mint] || 0);
        const usd = priceUsd * t.amount;
        // fallback logo to Jupiter CDN even if not in list
        const logo =
          meta.logoURI ||
          `https://img.jup.ag/128/${t.mint}.png`;
        const symbol = meta.symbol || (meta.name ? meta.name.slice(0, 10) : "");
        return {
          mint: t.mint,
          symbol,
          name: meta.name || "",
          logo,
          amount: t.amount,
          priceUsd,
          usd,
          decimals: t.decimals,
        };
      })
      .sort((a, b) => (b.usd || 0) - (a.usd || 0));

    // show unknown-price tokens too; minUsd only hides priced ones
    const visible = tokens
      .filter(t => (t.priceUsd > 0 ? t.usd >= minUsd : true))
      .slice(0, Math.max(1, maxTokens));

    const payload = {
      owner: ownerStr,
      updated: new Date().toISOString(),
      sol,
      solUsd: sol * solPrice,
      totalUsd: (sol * solPrice) + visible.reduce((s, t) => s + (t.usd || 0), 0),
      tokens: visible,
    };

    setCache(cacheKey, payload);
    res.json(payload);
  } catch (e) {
    console.error("wallet error", e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ---------- BUYS ----------
async function birdeyeTrades(addr) {
  // try /defi/trades then /defi/txs
  try {
    const u = new URL(`${BE}/defi/trades`);
    u.searchParams.set("address", addr);
    u.searchParams.set("limit", "200");
    const j = await beJson(u);
    return j.data || j.results || [];
  } catch {}
  try {
    const u = new URL(`${BE}/defi/txs`);
    u.searchParams.set("address", addr);
    u.searchParams.set("limit", "200");
    const j = await beJson(u);
    return j.data || j.results || [];
  } catch {}
  return [];
}

async function birdeyePairsForToken(mint) {
  try {
    const u = new URL(`${BE}/defi/markets`);
    u.searchParams.set("address", mint);
    const j = await beJson(u);
    const rows = j.data || j.results || [];
    // normalize to just pair addresses if present
    return rows
      .map(r => r.pairAddress || r.address || r.market || r.pair || "")
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ?type=token|pair&address=...&limit=10&minUsd=0
app.get("/buys", async (req, res) => {
  try {
    let typ = String(req.query.type ?? req.query.kind ?? "token").toLowerCase();
    if (typ !== "token" && typ !== "pair") typ = "token";
    const address = String(req.query.address || "").trim();
    const limit = Math.min(Number(req.query.limit ?? 10), 100);
    const minUsd = Number(req.query.minUsd ?? 0);
    if (!address) return res.status(400).json({ error: "Missing address" });

    const cacheKey = `buys:${typ}:${address}:${limit}:${minUsd}`;
    const cached = getCache(cacheKey, 10000);
    if (cached) return res.json(cached);

    let rows = await birdeyeTrades(address);

    // if token and nothing came back, resolve pairs and try those
    if (typ === "token" && (!rows || rows.length === 0)) {
      const pairs = await birdeyePairsForToken(address);
      for (const p of pairs.slice(0, 3)) {
        const more = await birdeyeTrades(p);
        rows = rows.concat(more);
        if (rows.length >= limit) break;
      }
    }

    const items = (rows || [])
      .map(x => {
        const sideStr = [
          x.side, x.tradeType, x.type, x.action,
          (x.is_buy === true ? "buy" : ""),
          (x.isBuyer === true ? "buy" : "")
        ]
          .filter(Boolean)
          .map(s => String(s).toLowerCase())
          .join(" ");
        const isBuy = /\bbuy\b/.test(sideStr);

        const usd = Number(
          x.volume_usd ?? x.usdValue ?? x.value_usd ?? x.totalUsd ?? 0
        ) || 0;
        const qty = Number(x.amountToken ?? x.base_amount ?? x.amount ?? x.size ?? 0) || 0;
        const price = Number(x.priceUsd ?? x.price_usd ?? x.price ?? 0) || 0;
        const symbol = x.symbol || x.base_symbol || x.baseSymbol || "";
        const dex = x.dex || x.market || x.source || "";
        const tx = x.txHash || x.tx_hash || x.signature || "";
        const tms =
          Number(x.ts) ||
          Number(x.blockUnixTime) ||
          (x.blockTime ? Number(x.blockTime) * 1000 : 0);
        return {
          isBuy, usd, qty, priceUsd: price, symbol, dex, tx,
          time: tms ? new Date(tms).toISOString() : undefined,
        };
      })
      .filter(i => i.isBuy && i.usd >= minUsd)
      .sort((a, b) => (b.time || "").localeCompare(a.time || ""))
      .slice(0, limit);

    const payload = { type: typ, address, items };
    setCache(cacheKey, payload);
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
