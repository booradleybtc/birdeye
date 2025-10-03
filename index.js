// index.js
import express from "express";
import cors from "cors";

const API_KEY = process.env.BIRDEYE_API_KEY;
const ALLOWED = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map(s => s.trim());

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED.includes("*") || ALLOWED.includes(origin)) return cb(null, true);
    return cb(new Error("Blocked by CORS"));
  },
}));

const cache = new Map();
const get = k => {
  const v = cache.get(k);
  if (!v || v.exp < Date.now()) return null;
  return v.data;
};
const put = (k, data, ttl) => cache.set(k, { data, exp: Date.now() + ttl });

const handler = async (req, res, next) => {
  try {
    const { type, address, limit = "100" } = req.query;
    if (!type || !address) return res.status(400).json({ error: "type and address required" });
    if (!API_KEY) return res.status(500).json({ error: "Missing BIRDEYE_API_KEY" });

    let path = "";
    if (type === "token")   path = `/defi/txs/token?chain=solana&address=${address}&limit=${limit}&sort_type=desc`;
    else if (type === "pair") path = `/defi/txs/pair?chain=solana&address=${address}&limit=${limit}&sort_type=desc`;
    else if (type === "markets") path = `/defi/v2/markets?address=${address}`;
    else return res.status(400).json({ error: "invalid type" });

    const key = `be:${path}`;
    const cached = get(key);
    if (cached) return res.set("Cache-Control","public, max-age=5").json(cached);

    const r = await fetch("https://public-api.birdeye.so" + path, {
      headers: { accept: "application/json", "x-api-key": API_KEY, "x-chain": "solana" },
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
    next(e);
  }
};

app.get("/birdeye", handler);
app.get("/", handler);
app.get("/healthz", (_req, res) => res.send("ok"));
app.use((err, _req, res, _next) => {
  console.error("proxy error:", err);
  res.status(500).json({ error: String(err?.message || err) });
});

app.listen(PORT, () => console.log(`Birdeye proxy listening on :${PORT}`));
