// fetch-market-data.mjs — Vandelay morning data pull (keyless, no dependencies)
//
// Writes four files into data/:
//   screen.json     every watchlist ticker measured: last, change, volume vs average, 52w position
//   earnings.json   the day's reporters with consensus EPS, revenue and market cap
//   shorts.json     official settlement-date short interest for the watchlist
//   failures.json   every request that did not return — declared, never hidden
//
// Run:  node fetch-market-data.mjs            (from the repo root)
//       node fetch-market-data.mjs 2026-09-03 (a specific calendar date)
// Node 18+ (global fetch). No API keys. No npm install.
//
// The 08:35 ET window guard lives in the WORKFLOW, not here — so market data and news
// never disagree about whether this is the run of the day.
//
// CIRCUIT BREAKER: keyless endpoints sometimes block datacenter IPs outright. Without a
// breaker, 94 tickers x 2 hosts x an 8s timeout is over an hour of waiting to learn one
// fact. After 8 consecutive failures a host is declared down, every remaining call to it
// is skipped, and failures.json says so. A blocked host now costs about a minute.

import { readFile, writeFile, mkdir } from "node:fs/promises";

const UA = "VandelayResearch/1.0 (morning recap; contact: you@example.com)";
const NASDAQ = "https://api.nasdaq.com/api";
const TIMEOUT_MS = 8000;
const BREAK_AFTER = 8;

const failures = [];
const nowISO = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Per-host health. Retry only on transient HTTP statuses — a timeout is not worth
// a second 8-second wait when it is about to happen 93 more times.
const RETRY_ON = [429, 500, 502, 503, 504];
const health = new Map(); // host -> { consecutive, open, reason, at }

const hostOf = (url) => {
  try { return new URL(url).host; } catch { return url; }
};

function noteFailure(url, label, error) {
  const host = hostOf(url);
  const h = health.get(host) || { consecutive: 0, open: false };
  h.consecutive += 1;
  if (!h.open && h.consecutive >= BREAK_AFTER) {
    h.open = true;
    h.reason = error;
    h.at = nowISO();
    failures.push({
      label: `host-down:${host}`,
      url: host,
      error: `${BREAK_AFTER} consecutive failures (last: ${error}) — remaining calls to this host skipped`,
      at: nowISO(),
    });
  }
  health.set(host, h);
  failures.push({ label, url, error, at: nowISO() });
}

function noteSuccess(url) {
  const host = hostOf(url);
  const h = health.get(host);
  if (h) { h.consecutive = 0; health.set(host, h); }
}

function isDown(url) {
  return health.get(hostOf(url))?.open === true;
}

async function req(url, label, headers) {
  if (isDown(url)) return null; // breaker open — do not wait on a host we know is dead
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers, signal: ctl.signal });
      if (!res.ok) {
        if (RETRY_ON.includes(res.status) && attempt === 0) {
          await sleep(1000);
          continue;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      noteSuccess(url);
      return res;
    } catch (err) {
      const msg = err.name === "AbortError" ? `timeout after ${TIMEOUT_MS / 1000}s` : String(err.message || err);
      noteFailure(url, label, msg);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

async function getJSON(url, label) {
  const res = await req(url, label, { "User-Agent": UA, Accept: "application/json" });
  if (!res) return null;
  try {
    const body = await res.json();
    return body?.data ?? body;
  } catch {
    // A keyless endpoint that has moved answers 200 with an HTML block page.
    noteFailure(url, label, "response was not JSON");
    return null;
  }
}

async function getText(url, label) {
  const res = await req(url, label, { "User-Agent": UA });
  if (!res) return null;
  try {
    return await res.text();
  } catch (err) {
    noteFailure(url, label, String(err.message || err));
    return null;
  }
}

const num = (v) => {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
};

// --- one ticker: quote, extended-hours print, and its own 52-week band from raw daily bars
async function measure(ticker) {
  const row = { ticker, fetchedAt: nowISO() };

  const info = await getJSON(
    `${NASDAQ}/quote/${ticker}/info?assetclass=stocks`,
    `quote:${ticker}`
  );
  if (info) {
    const p = info.primaryData || {};
    const s = info.secondaryData || null;
    row.last = num(p.lastSalePrice);
    row.changePct = num(p.percentageChange);
    row.change = num(p.netChange);
    row.volume = num(p.volume);
    row.marketStatus = info.marketStatus || null;
    row.quoteStamp = p.lastTradeTimestamp || null;
    if (s) {
      row.extendedLast = num(s.lastSalePrice);
      row.extendedChangePct = num(s.percentageChange);
      row.extendedStamp = s.lastTradeTimestamp || null;
    }
  }

  // raw daily bars -> 52-week high/low, band position, 20-day average volume
  const csv = await getText(
    `https://stooq.com/q/d/l/?s=${ticker.toLowerCase()}.us&i=d`,
    `history:${ticker}`
  );
  if (csv && csv.includes(",")) {
    const lines = csv.trim().split("\n").slice(1);
    const bars = lines
      .map((l) => l.split(","))
      .filter((c) => c.length >= 6)
      .map((c) => ({ date: c[0], high: num(c[2]), low: num(c[3]), close: num(c[4]), vol: num(c[5]) }))
      .filter((b) => b.close !== null);
    const window = bars.slice(-252);
    if (window.length > 30) {
      const highs = window.map((b) => b.high ?? b.close);
      const lows = window.map((b) => b.low ?? b.close);
      row.hi52 = Math.max(...highs);
      row.lo52 = Math.min(...lows);
      // No quote? The last daily close still gives a usable level and band position.
      const price = row.extendedLast ?? row.last ?? window.at(-1).close;
      row.priceUsedForBand = price;
      row.bandBasis = row.extendedLast
        ? "extended print"
        : row.last != null
          ? "last / prior close"
          : "daily bar close (no live quote)";
      if (row.hi52 > row.lo52 && price !== null) {
        row.pct52w = Number((((price - row.lo52) / (row.hi52 - row.lo52)) * 100).toFixed(1));
      }
      const last20 = window.slice(-20).map((b) => b.vol).filter((v) => v !== null);
      if (last20.length) {
        row.avgVol20 = Math.round(last20.reduce((a, b) => a + b, 0) / last20.length);
        if (row.volume) row.relVol = Number((row.volume / row.avgVol20).toFixed(2));
      }
      row.historyThrough = window.at(-1).date;
      row.barClose = window.at(-1).close;
      if (window.length > 1) {
        const prev = window.at(-2).close;
        if (prev) row.barChangePct = Number((((window.at(-1).close - prev) / prev) * 100).toFixed(2));
      }
    }
  }
  return row;
}

async function shortInterest(ticker) {
  const d = await getJSON(
    `${NASDAQ}/quote/${ticker}/short-interest?assetclass=stocks`,
    `shorts:${ticker}`
  );
  const rows = d?.shortInterestTable?.rows;
  if (!rows?.length) return null;
  const r = rows[0];
  return {
    ticker,
    settlementDate: r.settlementDate ?? null,
    interest: r.interest ?? null,
    avgDailyShareVolume: r.avgDailyShareVolume ?? null,
    daysToCover: r.daysToCover ?? null,
    fetchedAt: nowISO(),
  };
}

async function earningsToday(dateStr) {
  const d = await getJSON(`${NASDAQ}/calendar/earnings?date=${dateStr}`, "earnings-calendar");
  if (!d?.rows) return [];
  return d.rows.map((r) => ({
    ticker: r.symbol,
    company: r.name,
    time: r.time ?? null,              // "time-pre-market" | "time-after-hours"
    consensusEPS: r.epsForecast ?? null,
    marketCap: r.marketCap ?? null,
    fiscalQuarterEnding: r.fiscalQuarterEnding ?? null,
    lastYearEPS: r.lastYearEPS ?? null,
    lastYearReportDate: r.lastYearRptDt ?? null,
  }));
}

// --- run
const startedAt = Date.now();
const date = process.argv[2] || new Date().toISOString().slice(0, 10);
const screen = [];
const shorts = [];
let earnings = [];
let tickers = [];
let fatal = null;

try {
  const wl = JSON.parse(await readFile("watchlist.json", "utf8"));
  tickers = wl.tickers || [];

  // Earnings calendar first: one call, and it tells us immediately whether Nasdaq
  // answers this runner at all.
  earnings = await earningsToday(date);

  for (const t of tickers) {
    try {
      screen.push(await measure(t));
    } catch (err) {
      failures.push({ label: `measure:${t}`, error: String(err.message || err), at: nowISO() });
      screen.push({ ticker: t, fetchedAt: nowISO() });
    }
    await sleep(250); // stay polite; ~94 tickers ~ 1 minute
  }

  for (const t of tickers) {
    try {
      const s = await shortInterest(t);
      if (s) shorts.push(s);
    } catch (err) {
      failures.push({ label: `shorts:${t}`, error: String(err.message || err), at: nowISO() });
    }
    await sleep(200);
  }
} catch (err) {
  // Whatever went wrong, the files below still get written — an empty data/ folder
  // with no failures.json is the one outcome that leaves us blind.
  fatal = { error: String(err.stack || err.message || err), at: nowISO() };
}

await mkdir("data", { recursive: true });

const hosts = {};
for (const [host, h] of health) {
  hosts[host] = { circuitOpen: !!h.open, reason: h.reason || null, openedAt: h.at || null };
}

const meta = {
  date,
  generatedAt: nowISO(),
  tickersRequested: tickers.length,
  runSeconds: Math.round((Date.now() - startedAt) / 1000),
};

const withQuote = screen.filter((r) => r.last != null).length;
const withBand = screen.filter((r) => r.pct52w != null).length;

await writeFile(
  "data/screen.json",
  JSON.stringify({ ...meta, measured: withQuote, withBand, rows: screen }, null, 2)
);
await writeFile(
  "data/earnings.json",
  JSON.stringify({ ...meta, count: earnings.length, rows: earnings }, null, 2)
);
await writeFile("data/shorts.json", JSON.stringify({ ...meta, rows: shorts }, null, 2));
await writeFile(
  "data/failures.json",
  JSON.stringify({ ...meta, fatal, hosts, count: failures.length, failures }, null, 2)
);

console.log(
  `quotes ${withQuote}/${tickers.length} · bands ${withBand}/${tickers.length} · earnings ${earnings.length} · shorts ${shorts.length} · failures ${failures.length} · ${meta.runSeconds}s`
);
for (const [host, h] of Object.entries(hosts)) {
  if (h.circuitOpen) console.error(`HOST DOWN: ${host} — ${h.reason}`);
}
if (fatal) console.error(fatal.error);
