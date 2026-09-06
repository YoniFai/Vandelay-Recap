// fetch-etf-bars.mjs — ETF daily-bar artifact for the ROT-01 rotation sleeve.
//
// Writes ONE file:  data/etf_bars.json  (FULL-WINDOW REPLACE, on SUCCESS only).
//
// Isolated from fetch-market-data.mjs on purpose: this must never touch
// screen/earnings/shorts/failures computation. It reads etf_symbols.json,
// pulls Alpaca daily bars for the 13 ETFs, and persists the raw bars the
// rotation sleeve needs (OpenD cannot serve them — history-kline quota is
// saturated by the 94-name universe).
//
// Run:  node fetch-etf-bars.mjs
// Node 18+. Needs ALPACA_KEY_ID and ALPACA_SECRET_KEY in the environment
// (CI secrets only — no local keys).
//
// FAIL LOUD, NEVER SILENT: this is a single daily attempt. A failed or partial
// fetch must NOT overwrite a good prior file with a fresh-stamped empty/short
// one — that would destroy day D-1's data AND fool the Part B staleness guard
// into thinking the file is current. So the write is gated on a health check
// (all requested symbols present, each >= MIN_BARS); on failure the prior file
// is left untouched and the process exits non-zero, so the Action step logs red
// and the commit step finds no change to push. The staleness guard in Part B is
// the backstop: a missed day leaves D-1 in place and trips >2-session hard-fail.
//
// WHY adjustment=all (total-return), NOT split: split-only leaves the ex-div
// price drop in place, which fires false RS-momentum ticks on the high-yield
// sectors (XLU, XLP, XLRE, XLE). Back-adjusted history changes at every
// ex-div date, so this file is a FULL REPLACE, never an append.
//
// The Alpaca endpoint/auth here are byte-identical to the proven
// fetch-market-data.mjs dailyBars() (same host, same headers, same
// pagination) — the only change is adjustment=all in place of split.

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";

const KEY = process.env.ALPACA_KEY_ID || "";
const SECRET = process.env.ALPACA_SECRET_KEY || "";
// Base is overridable for offline self-test; defaults to the real Alpaca host.
const ALPACA = process.env.ALPACA_DATA_BASE || "https://data.alpaca.markets/v2/stocks";
const UA = "VandelayResearch/1.0 (etf bars; contact: you@example.com)";
const TIMEOUT_MS = 15000;
const RETRY_ON = [429, 500, 502, 503, 504];
const FEED = "iex";
const ADJUSTMENT = "all";
const MIN_BARS = 130; // coverage floor the rotation sleeve requires, per symbol

const nowISO = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const alpacaHeaders = { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SECRET };

async function getJSON(url, label) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", ...alpacaHeaders }, signal: ctl.signal });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        if (RETRY_ON.includes(res.status) && attempt < 2) { await sleep(1000 * (attempt + 1)); continue; }
        throw new Error(`HTTP ${res.status}${body ? ` — ${body.slice(0, 160)}` : ""}`);
      }
      return await res.json();
    } catch (err) {
      const msg = err.name === "AbortError" ? `timeout after ${TIMEOUT_MS / 1000}s` : String(err.message || err);
      if (attempt < 2 && err.name === "AbortError") { await sleep(800); continue; }
      failures.push({ label, url, error: msg, at: nowISO() });
      return null;
    } finally { clearTimeout(timer); }
  }
  return null;
}

// Alpaca daily bars: all ETFs in one multi-symbol request, paginated.
async function dailyBars(symbols, start) {
  const out = new Map();
  for (const s of symbols) out.set(s, []);
  let token = null;
  do {
    const url = `${ALPACA}/bars?symbols=${symbols.join(",")}&timeframe=1Day&start=${start}`
      + `&limit=10000&adjustment=${ADJUSTMENT}&feed=${FEED}`
      + `${token ? `&page_token=${encodeURIComponent(token)}` : ""}`;
    const d = await getJSON(url, `alpaca-etf-bars:${symbols.length}`);
    if (!d) break;
    for (const [sym, bars] of Object.entries(d.bars || {})) {
      if (!out.has(sym)) out.set(sym, []);
      for (const b of bars) {
        out.get(sym).push({ d: String(b.t).slice(0, 10), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
      }
    }
    token = d.next_page_token || null;
    if (token) await sleep(200);
  } while (token);
  return out;
}

// --- run
const startedAt = Date.now();
const start = new Date(Date.now() - 400 * 86400e3).toISOString().slice(0, 10);
let symbols = [];
let fatal = null;
const bars = {};
const perSymbolBars = {};

if (!KEY || !SECRET) {
  failures.push({ label: "alpaca-credentials", error: "ALPACA_KEY_ID / ALPACA_SECRET_KEY not set — no ETF bars fetched (CI secrets required)", at: nowISO() });
}

try {
  const list = JSON.parse(await readFile("etf_symbols.json", "utf8"));
  symbols = list.symbols || [];

  if (KEY && SECRET && symbols.length) {
    const got = await dailyBars(symbols, start);
    for (const s of symbols) {
      const arr = (got.get(s) || []).sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
      bars[s] = arr;
      perSymbolBars[s] = arr.length;
    }
  } else {
    for (const s of symbols) { bars[s] = []; perSymbolBars[s] = 0; }
  }
} catch (err) {
  fatal = { error: String(err.stack || err.message || err), at: nowISO() };
}

const symbolsBelow130 = Object.entries(perSymbolBars).filter(([, n]) => n < MIN_BARS).map(([s]) => s);
const dates = Object.values(bars).flat().map((b) => b.d);
const latestBar = dates.length ? dates.sort().at(-1) : null;
const cov = symbols.map((s) => `${s}:${perSymbolBars[s] ?? 0}`).join(" ");

const artifact = {
  feed: FEED,
  adjustment: ADJUSTMENT,
  source: "alpaca",
  schema: 1,
  generatedAt: nowISO(),
  start,
  minBars: MIN_BARS,
  latestBar,
  // `v` is IEX-only and PARTIAL (single-venue fragment volume, not the
  // consolidated tape). Downstream MUST ignore it. Kept only for coarse sanity.
  volumeNote: "v is IEX-partial (single-venue) — NOT consolidated volume; downstream ignores it",
  symbolsRequested: symbols.length,
  symbolsWithBars: Object.values(perSymbolBars).filter((n) => n > 0).length,
  symbolsBelow130,
  perSymbolBars,
  failuresCount: failures.length,
  failures,
  runSeconds: Math.round((Date.now() - startedAt) / 1000),
  bars,
};

// Health gate: only replace the prior file on a clean, complete fetch.
const healthy = !fatal && symbols.length > 0 && symbols.every((s) => (perSymbolBars[s] || 0) >= MIN_BARS);

await mkdir("data", { recursive: true });

if (healthy) {
  // Atomic replace: write a temp file, then rename over the live artifact.
  const tmp = "data/etf_bars.json.tmp";
  await writeFile(tmp, JSON.stringify(artifact, null, 2));
  await rename(tmp, "data/etf_bars.json");
  console.log(`etf_bars WROTE: ${artifact.symbolsWithBars}/${symbols.length} symbols · latest ${latestBar} · below130 [none] · failures ${failures.length} · ${artifact.runSeconds}s`);
  console.log(cov);
} else {
  // Do NOT overwrite. Leave the prior file (if any) in place; fail loud.
  console.error(`etf_bars NOT WRITTEN — unhealthy fetch, prior file left untouched. `
    + `below130=[${symbolsBelow130.join(",") || "none"}] symbolsWithBars=${artifact.symbolsWithBars}/${symbols.length} `
    + `fatal=${fatal ? "yes" : "no"} failures=${failures.length}`);
  console.error(cov);
  if (fatal) console.error(fatal.error);
  process.exit(1);
}
