// fetch-market-data.mjs — Vandelay morning data pull
//
// Writes into data/:
//   screen.json     every watchlist ticker measured: price, change, volume vs average, 52w band
//   earnings.json   the day's reporters with consensus EPS and market cap (Nasdaq, when reachable)
//   shorts.json     official settlement-date short interest (Nasdaq, when reachable)
//   failures.json   every request that did not return — declared, never hidden
//
// Run:  node fetch-market-data.mjs            (from the repo root)
//       node fetch-market-data.mjs 2026-09-04 (a specific calendar date)
// Node 18+. Needs ALPACA_KEY_ID and ALPACA_SECRET_KEY in the environment.
//
// SOURCE ORDER, learned from the 2026-09-04 runs:
//   Alpaca (data.alpaca.markets)  PRIMARY. A real API with a contract, and multi-symbol
//                   endpoints: all 94 names in ~4 requests instead of 188. Free Basic
//                   plan, IEX feed. Free historical data excludes the last 15 minutes,
//                   which an 08:35 pull does not care about.
//   Yahoo (query1.finance.yahoo.com)  FALLBACK ONLY, per-symbol, for names Alpaca does
//                   not return. Unofficial and changes without notice — never primary.
//   api.nasdaq.com  silently drops connections from GitHub runners. Still attempted for
//                   the earnings calendar and short interest, which nothing else provides
//                   keylessly; the breaker caps the cost at ~1 minute and failures.json
//                   records the block.
//
// Every row carries priceSource and barsSource, so a mixed run is auditable.
// The 08:35 ET window guard lives in the WORKFLOW, not here.

import { readFile, writeFile, mkdir } from "node:fs/promises";

const KEY = process.env.ALPACA_KEY_ID || "";
const SECRET = process.env.ALPACA_SECRET_KEY || "";
const ALPACA = "https://data.alpaca.markets/v2/stocks";
const YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart";
const NASDAQ = "https://api.nasdaq.com/api";
const UA = "VandelayResearch/1.0 (morning recap; contact: you@example.com)";
const TIMEOUT_MS = 15000;
const BREAK_AFTER = 6;
const CHUNK = 50; // symbols per multi-symbol request

const failures = [];
const nowISO = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRY_ON = [429, 500, 502, 503, 504];
const health = new Map();

const hostOf = (u) => { try { return new URL(u).host; } catch { return u; } };

function noteFailure(url, label, error) {
  const host = hostOf(url);
  const h = health.get(host) || { consecutive: 0, open: false };
  h.consecutive += 1;
  if (!h.open && h.consecutive >= BREAK_AFTER) {
    h.open = true; h.reason = error; h.at = nowISO();
    failures.push({ label: `host-down:${host}`, url: host,
      error: `${BREAK_AFTER} consecutive failures (last: ${error}) — remaining calls skipped`, at: nowISO() });
  }
  health.set(host, h);
  failures.push({ label, url, error, at: nowISO() });
}
const noteSuccess = (url) => { const h = health.get(hostOf(url)); if (h) { h.consecutive = 0; health.set(hostOf(url), h); } };
const isDown = (url) => health.get(hostOf(url))?.open === true;

async function getJSON(url, label, headers = {}) {
  if (isDown(url)) return null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", ...headers }, signal: ctl.signal });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        if (RETRY_ON.includes(res.status) && attempt < 2) { await sleep(1000 * (attempt + 1)); continue; }
        throw new Error(`HTTP ${res.status}${body ? ` — ${body.slice(0, 160)}` : ""}`);
      }
      noteSuccess(url);
      return await res.json();
    } catch (err) {
      const msg = err.name === "AbortError" ? `timeout after ${TIMEOUT_MS / 1000}s` : String(err.message || err);
      if (attempt < 2 && err.name === "AbortError") { await sleep(800); continue; }
      noteFailure(url, label, msg);
      return null;
    } finally { clearTimeout(timer); }
  }
  return null;
}

const alpacaHeaders = { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SECRET };
const round = (v, p = 2) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(p)));
const chunks = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

// --- Alpaca snapshots: latest trade, minute bar, daily bar, previous daily bar
async function snapshots(tickers) {
  const out = new Map();
  for (const group of chunks(tickers, CHUNK)) {
    const url = `${ALPACA}/snapshots?symbols=${group.join(",")}&feed=iex`;
    const d = await getJSON(url, `alpaca-snapshots:${group.length}`, alpacaHeaders);
    if (!d) continue;
    const rows = d.snapshots ?? d;
    for (const [sym, s] of Object.entries(rows || {})) if (s) out.set(sym, s);
    await sleep(200);
  }
  return out;
}

// --- Alpaca daily bars: one year, all symbols, paginated
async function dailyBars(tickers) {
  const out = new Map();
  const start = new Date(Date.now() - 400 * 86400e3).toISOString().slice(0, 10);
  for (const group of chunks(tickers, CHUNK)) {
    let token = null;
    do {
      const url = `${ALPACA}/bars?symbols=${group.join(",")}&timeframe=1Day&start=${start}&limit=10000&adjustment=split&feed=iex${token ? `&page_token=${encodeURIComponent(token)}` : ""}`;
      const d = await getJSON(url, `alpaca-bars:${group.length}`, alpacaHeaders);
      if (!d) break;
      for (const [sym, bars] of Object.entries(d.bars || {})) {
        if (!out.has(sym)) out.set(sym, []);
        out.get(sym).push(...bars.map((b) => ({ date: String(b.t).slice(0, 10), high: b.h, low: b.l, close: b.c, vol: b.v })));
      }
      token = d.next_page_token || null;
      if (token) await sleep(200);
    } while (token);
    await sleep(200);
  }
  return out;
}

// --- Yahoo, per-symbol fallback for names Alpaca did not return
async function yahooRow(ticker) {
  const url = `${YAHOO}/${encodeURIComponent(ticker)}?range=1y&interval=1d&includePrePost=true`;
  const d = await getJSON(url, `yahoo:${ticker}`);
  const r = d?.chart?.result?.[0];
  if (!r?.timestamp?.length) return null;
  const q = r.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const c = q.close?.[i];
    if (c == null) continue;
    bars.push({ date: new Date(r.timestamp[i] * 1000).toISOString().slice(0, 10), high: q.high?.[i] ?? c, low: q.low?.[i] ?? c, close: c, vol: q.volume?.[i] ?? null });
  }
  const m = r.meta || {};
  return { bars, price: m.regularMarketPrice ?? null, prevClose: m.chartPreviousClose ?? null,
    stamp: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null };
}

function bandFrom(bars) {
  const w = (bars || []).slice(-252);
  if (w.length < 30) return {};
  const o = {
    hi52: round(Math.max(...w.map((b) => b.high ?? b.close))),
    lo52: round(Math.min(...w.map((b) => b.low ?? b.close))),
    historyThrough: w.at(-1).date,
    priorClose: round(w.at(-1).close),
    barsCounted: w.length,
  };
  const vols = w.slice(-20).map((b) => b.vol).filter((v) => v != null);
  if (vols.length) o.avgVol20 = Math.round(vols.reduce((a, b) => a + b, 0) / vols.length);
  if (w.length > 1) { const p = w.at(-2).close; if (p) o.priorSessionChangePct = round(((w.at(-1).close - p) / p) * 100); }
  return o;
}

// --- Nasdaq-only series. Attempted; the breaker caps the cost when blocked.
async function earningsToday(dateStr) {
  const d = await getJSON(`${NASDAQ}/calendar/earnings?date=${dateStr}`, "earnings-calendar");
  const rows = d?.data?.rows ?? d?.rows;
  if (!rows) return [];
  return rows.map((r) => ({ ticker: r.symbol, company: r.name, time: r.time ?? null,
    consensusEPS: r.epsForecast ?? null, marketCap: r.marketCap ?? null,
    fiscalQuarterEnding: r.fiscalQuarterEnding ?? null, lastYearEPS: r.lastYearEPS ?? null,
    lastYearReportDate: r.lastYearRptDt ?? null }));
}

async function shortInterest(ticker) {
  const d = await getJSON(`${NASDAQ}/quote/${ticker}/short-interest?assetclass=stocks`, `shorts:${ticker}`);
  const rows = d?.data?.shortInterestTable?.rows ?? d?.shortInterestTable?.rows;
  if (!rows?.length) return null;
  const r = rows[0];
  return { ticker, settlementDate: r.settlementDate ?? null, interest: r.interest ?? null,
    avgDailyShareVolume: r.avgDailyShareVolume ?? null, daysToCover: r.daysToCover ?? null, fetchedAt: nowISO() };
}

// --- run
const startedAt = Date.now();
const date = process.argv[2] || new Date().toISOString().slice(0, 10);
const screen = [];
const shorts = [];
let earnings = [];
let tickers = [];
let fatal = null;

if (!KEY || !SECRET) {
  failures.push({ label: "alpaca-credentials", error: "ALPACA_KEY_ID / ALPACA_SECRET_KEY not set in the environment — Alpaca skipped, Yahoo fallback only", at: nowISO() });
}

try {
  const wl = JSON.parse(await readFile("watchlist.json", "utf8"));
  tickers = wl.tickers || [];

  const [snaps, bars] = KEY && SECRET
    ? [await snapshots(tickers), await dailyBars(tickers)]
    : [new Map(), new Map()];

  for (const t of tickers) {
    const row = { ticker: t, fetchedAt: nowISO() };
    const s = snaps.get(t);
    let barSet = bars.get(t) || null;

    if (s) {
      row.priceSource = "alpaca";
      const trade = s.latestTrade || s.minuteBar || null;
      if (trade) {
        row.last = round(trade.p ?? trade.c);
        row.quoteStamp = trade.t || null;      // the exchange's own timestamp
      }
      if (s.dailyBar) { row.sessionVolume = s.dailyBar.v ?? null; row.sessionOpen = round(s.dailyBar.o); }
      if (s.prevDailyBar) row.previousClose = round(s.prevDailyBar.c);
    }

    if (!barSet?.length) {
      const y = await yahooRow(t);
      if (y?.bars?.length) {
        barSet = y.bars;
        row.barsSource = "yahoo";
        if (row.last == null && y.price != null) {
          row.last = round(y.price); row.quoteStamp = y.stamp; row.priceSource = "yahoo";
        }
        if (row.previousClose == null && y.prevClose != null) row.previousClose = round(y.prevClose);
      }
      await sleep(120);
    } else {
      row.barsSource = "alpaca";
    }

    Object.assign(row, bandFrom(barSet));

    const base = row.previousClose ?? row.priorClose;
    if (row.last != null && base) {
      row.change = round(row.last - base);
      row.changePct = round(((row.last - base) / base) * 100);
    }
    if (row.avgVol20 && row.sessionVolume) row.relVol = round(row.sessionVolume / row.avgVol20);

    // Band position: recomputed every run from the endpoints, on a named price.
    const price = row.last ?? row.priorClose ?? null;
    if (price != null && row.hi52 != null && row.lo52 != null && row.hi52 > row.lo52) {
      row.priceUsedForBand = price;
      row.bandBasis = row.last != null ? `${row.priceSource} print` : "prior close (no live print)";
      row.pct52w = round(((price - row.lo52) / (row.hi52 - row.lo52)) * 100, 1);
    }
    if (row.last == null && !barSet?.length) {
      failures.push({ label: `measure:${t}`, error: "no data from Alpaca or Yahoo", at: nowISO() });
    }
    screen.push(row);
  }

  earnings = await earningsToday(date);

  for (const t of tickers) {
    const s = await shortInterest(t);
    if (s) shorts.push(s);
    if (isDown(`${NASDAQ}/x`)) break; // blocked — stop rather than log 94 identical skips
    await sleep(150);
  }
} catch (err) {
  fatal = { error: String(err.stack || err.message || err), at: nowISO() };
}

await mkdir("data", { recursive: true });

const hosts = {};
for (const [host, h] of health) hosts[host] = { circuitOpen: !!h.open, reason: h.reason || null, openedAt: h.at || null };

const meta = { date, generatedAt: nowISO(), tickersRequested: tickers.length, runSeconds: Math.round((Date.now() - startedAt) / 1000) };
const withPrice = screen.filter((r) => r.last != null).length;
const withBand = screen.filter((r) => r.pct52w != null).length;
const bySource = {};
for (const r of screen) if (r.priceSource) bySource[r.priceSource] = (bySource[r.priceSource] || 0) + 1;

await writeFile("data/screen.json", JSON.stringify({ ...meta, measured: withPrice, withBand, priceSources: bySource, rows: screen }, null, 2));
await writeFile("data/earnings.json", JSON.stringify({ ...meta, count: earnings.length, rows: earnings }, null, 2));
await writeFile("data/shorts.json", JSON.stringify({ ...meta, count: shorts.length, rows: shorts }, null, 2));
await writeFile("data/failures.json", JSON.stringify({ ...meta, fatal, hosts, count: failures.length, failures }, null, 2));

console.log(`prices ${withPrice}/${tickers.length} (${JSON.stringify(bySource)}) · bands ${withBand}/${tickers.length} · earnings ${earnings.length} · shorts ${shorts.length} · failures ${failures.length} · ${meta.runSeconds}s`);
for (const [host, h] of Object.entries(hosts)) if (h.circuitOpen) console.error(`HOST DOWN: ${host} — ${h.reason}`);
if (fatal) console.error(fatal.error);
