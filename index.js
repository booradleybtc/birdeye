import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

const PORT = process.env.PORT || 10000;
const RPC_URL = process.env.RPC_URL;
const BIRDEYE_KEY = process.env.BIRDEYE_KEY;

if (!RPC_URL) throw new Error("Missing RPC_URL");
if (!BIRDEYE_KEY) throw new Error("Missing BIRDEYE_KEY");

const app = express();
app.use(cors());
app.get("/", (_req, res) => res.json({ ok: true, service: "wallet + buys proxy", time: new Date().toISOString() }));

/* ------------------------- tiny cache to dodge 429s ------------------------ */
const cache = new Map(); // key -> { until, data }
const getCache = (k) => {
  const v = cache.get(k);
  return v && v.until > Date.now() ? v.data : null;
};
const setCache = (k, data, ms = 8000) => cache.set(k, { until: Date.now() + ms, data });

/* ---------------------------- Birdeye helper ------------------------------- */
const BIRDEYE_BASE = "https://public-api.birdeye.so";
const birdHeaders = { "X-API-KEY": BIRDEYE_KEY, "x-chain": "solana" };

async function bird(pathAndQuery, cacheMs = 6000) {
  const url = `${BIRDEYE_BASE}${pathAndQuery}`;
  const hit = getCache(url);
  if (hit) return hit;
  const r = await fetch(url, { headers: birdHeaders });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Birdeye ${pathAndQuery} failed: ${r.status} ${text}`);
  }
  const json = await r.json();
  setCache(url, json, cacheMs);
  return json;
}

/* ------------------------------ /birdeye passthrough ----------------------- */
/* Supports:
   type=markets -> /defi/markets?address=<mint or pair>
   type=token_txs -> /defi/v3/token/txs?address=<mint>&limit=...
   type=pair_txs  -> /defi/v3/pair/txs?address=<pair>&limit=...
   type=price     -> /defi/price?address=<mint>
*/
app.get("/birdeye", async (req, res) => {
  try {
    const { type, address, limit = 50 } = req.query;
    if (!type || !address) return res.status(400).json({ error: "type and address are required" });

    let path = null;
    if (type === "markets") path = `/defi/markets?address=${address}`;
    else if (type === "token_txs") path = `/defi/v3/token/txs?address=${address}&limit=${limit}`;
    else if (type === "pair_txs") path = `/defi/v3/pair/txs?address=${address}&limit=${limit}`;
    else if (type === "price") path = `/defi/price?address=${address}`;
    else return res.status(400).json({ error: "unsupported type" });

    const data = await bird(path);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

/* ----------------------------- /buys (filtered) ---------------------------- */
/* kind=token|pair, address=<mint or pair>, limit=50 */
app.get("/buys", async (req, res) => {
  try {
    const { kind = "token", address, limit = 50 } = req.query;
    if (!address) return res.status(400).json({ error: "address is required" });
    const path =
      kind === "pair"
        ? `/defi/v3/pair/txs?address=${address}&limit=${limit}`
        : `/defi/v3/token/txs?address=${address}&limit=${limit}`;

    const raw = await bird(path);
    const items = (raw?.data?.items || raw?.data || raw?.items || [])
      .filter((t) => {
        // Birdeye objects vary slightly by endpoint/version; normalize:
        const side = (t.side || t.type || t.tx_type || "").toString().toLowerCase();
        const isBuy = t.is_buy === true || side === "buy";
        // Some payloads use `amount_usd` / `value_usd`, keep both
        t.usd = t.amount_usd ?? t.value_usd ?? t.usd ?? null;
        t.qty = t.amount ?? t.qty ?? t.base_amount ?? null;
        return isBuy;
      })
      .slice(0, Number(limit));

    res.json({ items, srcCount: items.length });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

/* ---------------------------- /wallet (snapshot) --------------------------- */
/* Returns non-zero token balances across both programs + Birdeye USD */
const conn = new Connection(RPC_URL, "confirmed");

async function getTokenAccounts(owner, programId) {
  const resp = await conn.getParsedTokenAccountsByOwner(owner, { programId });
  return resp.value
    .map(({ pubkey, account }) => {
      try {
        const info = account.data.parsed.info;
        const amt = info.tokenAmount;
        return {
          account: pubkey.toBase58(),
          mint: info.mint,
          decimals: Number(amt.decimals),
          uiAmount: Number(amt.uiAmountString ?? amt.uiAmount ?? 0),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((t) => t.uiAmount > 0);
}

async function priceUsd(mint) {
  try {
    const p = await bird(`/defi/price?address=${mint}`, 15000);
    return p?.data?.value ?? p?.data?.price ?? null;
  } catch {
    return null;
  }
}

app.get("/wallet", async (req, res) => {
  try {
    const { address, max = 40 } = req.query;
    if (!address) return res.status(400).json({ error: "address required" });
    const owner = new PublicKey(address.toString());

    const [v0, v22] = await Promise.all([
      getTokenAccounts(owner, TOKEN_PROGRAM_ID),
      getTokenAccounts(owner, TOKEN_2022_PROGRAM_ID),
    ]);
    const balances = [...v0, ...v22].slice(0, Number(max));

    // Fetch prices with tiny concurrency to avoid 429s
    const out = [];
    for (const t of balances) {
      const usd = await priceUsd(t.mint);
      out.push({ ...t, priceUsd: usd, valueUsd: usd ? usd * t.uiAmount : null });
      await new Promise((r) => setTimeout(r, 120)); // throttle a bit
    }

    res.json({ address, count: out.length, tokens: out });
  } catch (e) {
    res.status(500).json({ error: `RPC error: ${String(e.message || e)}` });
  }
});

/* -------------------------------------------------------------------------- */
app.listen(PORT, () => console.log(`proxy listening on :${PORT}`));
