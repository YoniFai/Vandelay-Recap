// fetch-market-data.mjs — Vandelay morning data pull (keyless, no dependencies)
//
// Writes four files into data/:
//   screen.json     every watchlist ticker measured: last, change, volume vs average, 52w position
//   earnings.json   the day's reporters with consensus EPS, revenue and market cap
//   shorts.json     official settlement-date short interest for the watchlist
//   failures.json   every request that did not return — declared, never hidden
//
// Run:  node pipeline/fetch-market-data.mjs
// Node 18+ (global fetch). No API keys. No npm install.
//
// Scheduled runs no-op outside the 07:00 ET hour (GitHub cron is UTC and ignores DST,
// so the workflow fires twice and this guard keeps exactly one pull). Pass --force to
// run at any time.

import { readFile, writeFile, mkdir } from "node:fs/promises";

const FORCE = process.argv.includes("--force");
const etHour = Number(
  new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    hour12: false,
  }).format(new Date())
);
if (process.env.GITHUB_EVENT_NAME === "schedule" && etHour !== 7 && !FORCE) {
  console.log(`skip: ${etHour}:xx ET is outside the 07:00 ET pull window`);
  process.exit(0);
}

const UA = "VandelayResearch/1.0 (morning recap; contact: you@example.com)";
const NASDAQ = "https://api.nasdaq.com/api";
const failures = [];
const nowISO = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, label) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    return body?.data ?? body;
  } catch (err) {
    failures.push({ label, url, error: String(err.message || err), at: nowISO() });
    return null;
  }
}

async function getText(url, label) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
  if (csv) {
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
const wl = JSON.parse(await readFile("watchlist.json", "utf8"));
const tickers = wl.tickers || [];

const screen = [];
for (const t of tickers) {
  screen.push(await measure(t));
  await sleep(250); // stay polite; ~94 tickers ≈ 1 minute
}

const shorts = [];
for (const t of tickers) {
  const s = await shortInterest(t);
  if (s) shorts.push(s);
  await sleep(200);
}

const earnings = await earningsToday(date);

await mkdir("data", { recursive: true });
const meta = { date, generatedAt: nowISO(), tickersRequested: tickers.length };

await writeFile(
  "data/screen.json",
  JSON.stringify({ ...meta, measured: screen.filter((r) => r.last != null).length, rows: screen }, null, 2)
);
await writeFile(
  "data/earnings.json",
  JSON.stringify({ ...meta, count: earnings.length, rows: earnings }, null, 2)
);
await writeFile("data/shorts.json", JSON.stringify({ ...meta, rows: shorts }, null, 2));
await writeFile(
  "data/failures.json",
  JSON.stringify({ ...meta, count: failures.length, failures }, null, 2)
);

console.log(
  `screen ${screen.filter((r) => r.last != null).length}/${tickers.length} · earnings ${earnings.length} · shorts ${shorts.length} · failures ${failures.length}`
);  
