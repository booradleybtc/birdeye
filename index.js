import express from "express";
import cors from "cors";

const API_KEY = process.env.BIRDEYE_API_KEY;        // set in Render
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map(s => s.trim());

if (!API_KEY) throw new Error("Missing BIRDEYE_API_KEY");

const app = express();
const PORT = process.env.PORT || 3000;

// CORS (restrict to your Framer domain if you want)
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes("*") || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error("Blocked by CORS"));
  }
}));

// very small in-memory cache to reduce API calls
const cache = new Map();
const get = (k) => {
  const v = cache.get(k);
  if (!v || v.exp < Date.now()) { cache.delete(k); return null; }
  return v.data;
};
const put = (k, data, ttlMs) => cache.set(k, { data, exp: Date.now() + ttlMs });

app.get("/birdeye", async (req, res) => {
  try {
    const { type, address, limit = "100" } = req.query;
    if (!type || !address) return res.status(400).json({ error: "type and address required" });

    let path = "";
    if (type === "token")   path = `/defi/txs/token?chain=solana&address=${address}&limit=${limit}&sort_type=desc`;
    else if (type === "pair") path = `/defi/txs/pair?chain=solana&address=${address}&limit=${limit}&sort_type=desc`;
    else if (type === "markets") path = `/defi/v2/markets?address=${address}`;
    else return res.status(400).json({ error: "invalid type" });

    const key = `be:${path}`;
    const cached = get(key);
    if (cached) return res.set("Cache-Control", "public, max-age=5").json(cached);

    const r = await fetch("https://public-api.birdeye.so" + path, {
      headers: {
        accept: "application/json",
        "x-api-key": API_KEY,
        "x-chain": "solana",
      },
    });

    const text = await r.text();
    res.status(r.status).set("Cache-Control", path.includes("/markets") ? "public, max-age=30" : "public, max-age=5");
    try {
      const json = JSON.parse(text);
      if (r.ok) put(key, json, path.includes("/markets") ? 30_000 : 5_000);
      return res.json(json);
    } catch {
      return res.send(text);
    }
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

app.get("/healthz", (_req, res) => res.send("ok"));
app.listen(PORT, () => console.log(`Birdeye proxy listening on :${PORT}`));
