// index.js
// Solana wallet snapshot + recent buys proxy
// - Balances via Helius (RPC) or public RPC
// - Prices via Jupiter with Birdeye fallback
// - Recent buys via Birdeye (computes USD when missing)

const express = require("express");
const cors = require("cors");
const { Connection, PublicKey, LAMPORTS_PER_SOL } = require("@solana/web3.js");
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = require("@solana/spl-token");

// ---------- ENV ----------
const PORT = Number(process.env.PORT || 3000);
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "";
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY || "";

// ---------- RPC ----------
const RPC_URL = HELIUS_API_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
  : "https://api.mainnet-beta.solana.com";
const conn = new Connection(RPC_URL, "confirmed");

// ---------- CONSTANTS ----------
const WSOL = "So11111111111111111111111111111111111111112";

// Basic fetch wrapper (Node 18+ has global fetch)
async function http(url, opt = {}) {
  const r = await fetch(url, opt);
  return r;
}

// ---------- Jupiter token metadata cache ----------
let jupMap = null;
let jupLoadPromise = null;

async function getJupMap() {
  if (jupMap) return jupMap;
  if (!jupLoadPromise) {
    jupLoadPromise = (async () => {
      try {
        const r = await http("https://token.jup.ag/all");
        const list = (await r.json()) || [];
        const m = new Map();
        for (const t of list) {
          m.set(t.address, {
            symbol: t.symbol || "",
            name: t.name || "",
            logoURI: t.logoURI || "",
          });
        }
        return m;
      } catch (e) {
        console.warn("[jup] token list failed:", e.message);
        return new Map();
      }
    })();
  }
  jupMap = await jupLoadPromise;
  return jupMap;
}

// ---------- Prices: Jupiter (primary) → Birdeye (fallback) ----------
async function getPrices(mints) {
  const uniq = [...new Set((mints || []).filter(Boolean))];
  const out = {};
  const BATCH = 50;

  async function jup(chunk) {
    const r = await http(`https://price.jup.ag/v4/price?ids=${chunk.join(",")}`);
    if (!r.ok) throw new Error(`jup ${r.status}`);
    const j = await r.json();
    const data = j?.data || {};
    for (const k of Object.keys(data)) {
      const px = Number(data[k]?.price);
      if (Number.isFinite(px)) out[k] = px;
    }
  }

  async function birdeye(chunk) {
    const r = await http(
      `https://public-api.birdeye.so/defi/multi_price?chain=solana&address=${chunk.join(",")}`,
      { headers: { "x-api-key": BIRDEYE_API_KEY } }
    );
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      console.warn(`[prices] birdeye ${r.status}: ${body?.slice(0, 300)}`);
      throw new Error(`birdeye ${r.status}`);
    }
    const j = await r.json();
    const data = j?.data || j?.results || {};
    for (const k of Object.keys(data)) {
      const v = data[k]?.value ?? data[k]?.price ?? data[k];
      const px = Number(v);
      if (Number.isFinite(px) && out[k] == null) out[k] = px;
    }
  }

  for (let i = 0; i < uniq.length; i += BATCH) {
    const chunk = uniq.slice(i, i + BATCH);
    try { await jup(chunk); } catch (e) { console.warn("[prices] jup chunk failed:", e.message); }
    const missing = chunk.filter((m) => out[m] == null);
    if (missing.length && BIRDEYE_API_KEY) {
      try { await birdeye(missing); } catch (_) {}
    }
  }
  return out;
}

// ---------- Helpers ----------
async function safeGetParsed(owner, programId, label) {
  try {
    const { value } = await conn.getParsedTokenAccountsByOwner(owner, { programId });
    return value || [];
  } catch (e) {
    console.warn(`[wallet] getParsed ${label}:`, e.message);
    return [];
  }
}

// ---------- Express ----------
const app = express();
app.use(cors());
app.use((req, _res, next) => { req.start = Date.now(); next(); });
app.use((req, res, next) => {
  res.on("finish", () => {
    const ms = Date.now() - req.start;
    console.log(
      `[${req.method}]${res.statusCode} ${req.originalUrl} clientIP="${(req.headers["x-forwarded-for"] || "").split(",")[0] || req.ip}" responseTimeMS=${ms} responseBytes=${res.getHeader("content-length") || 0} userAgent=${JSON.stringify(req.headers["user-agent"] || "")}`
    );
  });
  next();
});

// Health
app.get("/", (_req, res) => res.json({ ok: true, rpc: RPC_URL.includes("helius") ? "helius" : "solana" }));
app.get("/clientIP", (req, res) => res.json({ ip: (req.headers["x-forwarded-for"] || "").split(",")[0] || req.ip }));

// ---------- /wallet ----------
app.get("/wallet", async (req, res) => {
  const ownerStr = String(req.query.address || "").trim();
  const minUsd = Number(req.query.minUsd ?? 0);
  const maxTokens = Math.max(1, Number(req.query.maxTokens ?? 25));
  if (!ownerStr) return res.status(400).json({ error: "Missing address" });

  try {
    const owner = new PublicKey(ownerStr);
    const jmap = await getJupMap();

    // SOL
    let sol = 0;
    try { sol = (await conn.getBalance(owner, "confirmed")) / LAMPORTS_PER_SOL; }
    catch (e) { console.warn("[wallet] getBalance:", e.message); }

    // Token accounts (legacy + Token-2022)
    const [legacy, t22] = await Promise.all([
      safeGetParsed(owner, TOKEN_PROGRAM_ID, "Tokenkeg"),
      safeGetParsed(owner, TOKEN_2022_PROGRAM_ID, "Token-2022"),
    ]);
    const accounts = [...legacy, ...t22];

    const tokensRaw = accounts
      .map((acc) => {
        const info = acc?.account?.data?.parsed?.info;
        const ta = info?.tokenAmount;
        return {
          mint: info?.mint,
          amount: Number(ta?.uiAmount || 0),
          decimals: Number(ta?.decimals || 0),
        };
      })
      .filter((t) => t?.mint && t.amount > 0);

    const mints = [...new Set(tokensRaw.map((t) => t.mint))];
    const priceMap = await getPrices([...mints, WSOL]);
    const solPrice = Number(priceMap[WSOL] || 0);

    const tokens = tokensRaw
      .map((t) => {
        const meta = jmap.get(t.mint) || {};
        const priceUsd = Number(priceMap[t.mint] || 0);
        const usd = priceUsd * t.amount;
        const logo = meta.logoURI || `https://img.jup.ag/128/${t.mint}.png`;
        return {
          mint: t.mint,
          symbol: meta.symbol || "",
          name: meta.name || "",
          image: logo,
          logo,
          amount: t.amount,
          decimals: t.decimals,
          priceUsd,
          usd,
        };
      })
      .sort((a, b) => (b.usd || 0) - (a.usd || 0));

    // Only filter by minUsd if we actually know the price
    const visible = tokens
      .filter((t) => (t.priceUsd > 0 ? t.usd >= minUsd : true))
      .slice(0, maxTokens);

    const totalUsd = (solPrice * sol) +
      visible.reduce((s, t) => s + (Number.isFinite(t.usd) ? t.usd : 0), 0);

    return res.json({
      owner: ownerStr,
      updated: new Date().toISOString(),
      sol,
      solUsd: sol * solPrice,
      totalUsd,
      tokens: visible,
      priceProvider: { jupiter: true, birdeye: Boolean(BIRDEYE_API_KEY) },
    });
  } catch (e) {
    console.error("[wallet] fatal:", e);
    return res.status(200).json({
      owner: ownerStr, updated: new Date().toISOString(),
      sol: 0, solUsd: 0, totalUsd: 0, tokens: [],
      warning: String(e?.message || e),
    });
  }
});

// ---------- /buys ----------
app.get("/buys", async (req, res) => {
  const type = String(req.query.type || "token"); // "token" | "wallet"
  const address = String(req.query.address || "").trim();
  const limit = Math.max(1, Math.min(50, Number(req.query.limit ?? 10)));
  const minUsd = Number(req.query.minUsd ?? 0);

  if (!address) return res.status(400).json({ error: "Missing address" });
  if (!BIRDEYE_API_KEY) return res.json({ buys: [], warning: "No BIRDEYE_API_KEY set" });

  try {
    const url =
      type === "wallet"
        ? `https://public-api.birdeye.so/defi/txns/address?chain=solana&address=${address}&type=buy&sort=desc&limit=${limit}`
        : `https://public-api.birdeye.so/defi/txns/token?chain=solana&address=${address}&type=buy&sort=desc&limit=${limit}`;

    const r = await http(url, { headers: { "x-api-key": BIRDEYE_API_KEY } });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      console.warn(`[buys] birdeye ${r.status}: ${body?.slice(0, 300)}`);
      return res.json({ buys: [], warning: `Birdeye ${r.status}` });
    }
    const j = await r.json();
    const rows = j?.data?.items || j?.data || j?.items || [];

    // Price any mints we see so we can compute USD
    const toPrice = new Set();
    rows.forEach((tx) => {
      if (tx?.tokenMint) toPrice.add(tx.tokenMint);
      if (tx?.baseMint) toPrice.add(tx.baseMint);
      if (tx?.mint) toPrice.add(tx.mint);
    });
    const pmap = await getPrices([...toPrice]);
    const jmap = await getJupMap();

    const buys = rows
      .map((tx) => {
        const mint = tx.tokenMint || tx.baseMint || tx.mint || "";
        const amount = Number(tx?.amount || tx?.tokenAmount || tx?.baseAmount || 0) || 0;
        const px = Number(tx?.priceUsd) || Number(pmap[mint] || 0);
        const usdRaw =
          Number(tx?.valueUsd) || (Number.isFinite(px) && px > 0 ? amount * px : undefined);

        const meta = jmap.get(mint) || {};
        const logo = meta.logoURI || (mint ? `https://img.jup.ag/128/${mint}.png` : "");
        return {
          sig: tx.signature || tx.txHash || tx.sig || "",
          ts: tx.blockUnixTime || tx.ts || tx.time || 0,
          mint,
          symbol: meta.symbol || "",
          name: meta.name || "",
          image: logo,
          amount,
          priceUsd: Number.isFinite(px) && px > 0 ? px : undefined,
          usd: Number.isFinite(usdRaw) ? usdRaw : undefined,
          owner: tx.owner || tx.trader || tx.user || "",
        };
      })
      .filter((b) => (b.usd == null ? true : b.usd >= minUsd))
      .slice(0, limit);

    return res.json({ buys });
  } catch (e) {
    console.error("[buys] fatal:", e);
    return res.json({ buys: [], warning: String(e?.message || e) });
  }
});

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`Service on :${PORT} → ${RPC_URL}`);
});
