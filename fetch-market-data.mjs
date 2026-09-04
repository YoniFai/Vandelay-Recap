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

import { readFile, writeFile, mkdir } from "node:fs/promises";

const UA = "VandelayResearch/1.0 (morning recap; contact: you@example.com)";
const NASDAQ = "https://api.nasdaq.com/api";
const failures = [];
const nowISO = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One retry on the transient statuses these keyless endpoints throw under load,
// and a hard timeout so a hanging socket can never stall the whole job.
const RETRY_ON = [429, 500, 502, 503, 504];

async function req(url, label, headers) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      const res = await fetch(url, { headers, signal: ctl.signal });
      if (!res.ok) {
        if (RETRY_ON.includes(res.status) && attempt === 0) {
          await sleep(1200);
          continue;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      return res;
    } catch (err) {
      const msg = err.name === "AbortError" ? "timeout after 15s" : String(err.message || err);
      if (attempt === 0 && err.name === "AbortError") {
        await sleep(800);
        continue;
      }
      failures.push({ label, url, error: msg, at: nowISO() });
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
  } catch (err) {
    // A keyless endpoint that has moved answers 200 with an HTML block page.
    failures.push({ label, url, error: "response was not JSON", at: nowISO() });
    return null;
  }
}

async function getText(url, label) {
  const res = await req(url, label, { "User-Agent": UA });
  if (!res) return null;
  try {
    return await res.text();
  } catch (err) {
    failures.push({ label, url, error: String(err.message || err), at: nowISO() });
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
      const price = row.extendedLast ?? row.last ?? window.at(-1).close;
      row.priceUsedForBand = price;
      row.bandBasis = row.extendedLast ? "extended print" : "last / prior close";
      if (row.hi52 > row.lo52 && price !== null) {
        row.pct52w = Number((((price - row.lo52) / (row.hi52 - row.lo52)) * 100).toFixed(1));
      }
      const last20 = window.slice(-20).map((b) => b.vol).filter((v) => v !== null);
      if (last20.length) {
        row.avgVol20 = Math.round(last20.reduce((a, b) => a + b, 0) / last20.length);
        if (row.volume) row.relVol = Number((row.volume / row.avgVol20).toFixed(2));
      }
      row.historyThrough = window.at(-1).date;
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
const date = process.argv[2] || new Date().toISOString().slice(0, 10);
const screen = [];
const shorts = [];
let earnings = [];
let tickers = [];
let fatal = null;

try {
  const wl = JSON.parse(await readFile("watchlist.json", "utf8"));
  tickers = wl.tickers || [];

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

  earnings = await earningsToday(date);
} catch (err) {
  // Whatever went wrong, the files below still get written — an empty data/ folder
  // with no failures.json is the one outcome that leaves us blind.
  fatal = { error: String(err.stack || err.message || err), at: nowISO() };
}

await mkdir("data", { recursive: true });
const meta = { date, generatedAt: nowISO(), tickersRequested: tickers.length };
const measured = screen.filter((r) => r.last != null).length;

await writeFile(
  "data/screen.json",
  JSON.stringify({ ...meta, measured, rows: screen }, null, 2)
);
await writeFile(
  "data/earnings.json",
  JSON.stringify({ ...meta, count: earnings.length, rows: earnings }, null, 2)
);
await writeFile("data/shorts.json", JSON.stringify({ ...meta, rows: shorts }, null, 2));
await writeFile(
  "data/failures.json",
  JSON.stringify({ ...meta, fatal, count: failures.length, failures }, null, 2)
);

console.log(
  `screen ${measured}/${tickers.length} · earnings ${earnings.length} · shorts ${shorts.length} · failures ${failures.length}${fatal ? " · FATAL (see data/failures.json)" : ""}`
);
if (fatal) console.error(fatal.error);
