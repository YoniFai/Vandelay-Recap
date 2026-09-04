// fetch-news.mjs — absolute-timestamped news for the morning recap (keyless, no deps)
//
// The problem this solves: aggregator pages report "3 hours ago" and that relative age
// cannot be verified. Filings and press releases carry real publication timestamps.
//
// Writes:
//   data/filings.json   8-K / 10-Q / 10-K / S-1 / Form 4 per watchlist ticker, last 48h,
//                       straight from SEC EDGAR, each with an absolute filing timestamp
//   data/wires.json     press releases from the newswires' own feeds (issuer's words)
//   data/news-failures.json  every feed that did not answer
//
// Run:  node fetch-news.mjs   (from the repo root)
// Node 18+. No API keys.
//
// EDGAR source note: this reads data.sec.gov/submissions/CIK##########.json, the
// documented JSON API, NOT the legacy cgi-bin/browse-edgar Atom endpoint. The CGI
// endpoint rate-limits hard from cloud IPs (it returned 503 for 22 of 94 tickers on
// 2026-09-03); the JSON API is served from a CDN, allows 10 req/s, and carries
// acceptanceDateTime — the true absolute timestamp, better than filing-date alone.
//
// SEC fair-access rules: send a real User-Agent with contact details, stay under
// 10 requests/second. The pacing below is well inside that.

import { readFile, writeFile, mkdir } from "node:fs/promises";

// PUT A REAL CONTACT ADDRESS HERE — SEC asks for it, and blocks generic agents.
const UA = "VandelayResearch/1.0 (morning recap; contact: you@example.com)";

const FORMS = ["8-K", "10-Q", "10-K", "S-1", "4"];
const HOURS_BACK = 48;

// Newswire feeds — the issuer's own words, with issue timestamps.
const WIRES = [
  { name: "PR Newswire", url: "https://www.prnewswire.com/rss/news-releases-list.rss" },
  { name: "GlobeNewswire", url: "https://www.globenewswire.com/RssFeed/orgclass/1/feedTitle/GlobeNewswire%20-%20News%20about%20Public%20Companies" },
  { name: "Business Wire", url: "https://feed.businesswire.com/rss/home/?rss=G1QFDERJXkJeEFpRWA%3D%3D" },
];

const failures = [];
const nowISO = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cutoff = Date.now() - HOURS_BACK * 3600 * 1000;
const RETRY_ON = [429, 500, 502, 503, 504];

async function req(url, label, accept) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: accept, "Accept-Encoding": "gzip, deflate" },
        signal: ctl.signal,
      });
      if (!res.ok) {
        if (RETRY_ON.includes(res.status) && attempt < 2) {
          await sleep(1000 * (attempt + 1)); // back off, then try again
          continue;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      return res;
    } catch (err) {
      const msg = err.name === "AbortError" ? "timeout after 15s" : String(err.message || err);
      if (attempt < 2 && err.name === "AbortError") {
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
  const res = await req(url, label, "application/json");
  if (!res) return null;
  try {
    return await res.json();
  } catch {
    failures.push({ label, url, error: "response was not JSON", at: nowISO() });
    return null;
  }
}

async function getText(url, label) {
  const res = await req(url, label, "application/xml,text/xml,*/*");
  if (!res) return null;
  try {
    return await res.text();
  } catch (err) {
    failures.push({ label, url, error: String(err.message || err), at: nowISO() });
    return null;
  }
}

const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : null;
};
const href = (block) => {
  const m = block.match(/<link[^>]*href="([^"]+)"/i) || block.match(/<link>([^<]+)<\/link>/i);
  return m ? m[1] : null;
};
const blocks = (xml, name) => {
  const out = [];
  const re = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "gi");
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
};

// --- EDGAR: ticker -> CIK once, then one JSON submissions call per ticker
async function cikMap() {
  const d = await getJSON("https://www.sec.gov/files/company_tickers.json", "edgar:ticker-map");
  const map = new Map();
  if (!d) return map;
  for (const v of Object.values(d)) {
    if (v?.ticker && v?.cik_str != null) map.set(String(v.ticker).toUpperCase(), String(v.cik_str));
  }
  return map;
}

async function filingsFor(ticker, cik) {
  if (!cik) {
    failures.push({ label: `edgar:${ticker}`, error: "no CIK in SEC ticker map (foreign issuer or ETF)", at: nowISO() });
    return [];
  }
  const padded = String(cik).padStart(10, "0");
  const d = await getJSON(`https://data.sec.gov/submissions/CIK${padded}.json`, `edgar:${ticker}`);
  const r = d?.filings?.recent;
  if (!r?.form) return [];
  const out = [];
  for (let i = 0; i < r.form.length; i++) {
    const form = r.form[i];
    if (FORMS.length && !FORMS.some((x) => (form || "").includes(x))) continue;
    // acceptanceDateTime is the absolute stamp; filingDate is date-only fallback.
    const filedAt = r.acceptanceDateTime?.[i] || r.filingDate?.[i] || null;
    if (!filedAt || Date.parse(filedAt) < cutoff) continue;
    const accession = r.accessionNumber?.[i] || null;
    const bare = accession ? accession.replace(/-/g, "") : null;
    out.push({
      ticker,
      form,
      title: r.primaryDocDescription?.[i] || form,
      filedAt,
      filingDate: r.filingDate?.[i] || null,
      reportDate: r.reportDate?.[i] || null,
      items: r.items?.[i] || null,     // 8-K item numbers — what the filing is about
      url: bare && r.primaryDocument?.[i]
        ? `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${bare}/${r.primaryDocument[i]}`
        : null,
      accession,
      stampBasis: r.acceptanceDateTime?.[i] ? "acceptance timestamp" : "filing date only",
    });
  }
  return out;
}

async function wireItems(feed) {
  const xml = await getText(feed.url, `wire:${feed.name}`);
  if (!xml) return [];
  const items = blocks(xml, "item").length ? blocks(xml, "item") : blocks(xml, "entry");
  return items
    .map((it) => ({
      source: feed.name,
      title: tag(it, "title"),
      publishedAt: tag(it, "pubDate") || tag(it, "published") || tag(it, "updated"),
      url: href(it),
    }))
    .filter((i) => i.publishedAt && Date.parse(i.publishedAt) >= cutoff);
}

// --- run
const filings = [];
const wires = [];
let tickers = [];
let fatal = null;

try {
  const wl = JSON.parse(await readFile("watchlist.json", "utf8"));
  tickers = wl.tickers || [];

  const ciks = await cikMap();

  for (const t of tickers) {
    try {
      filings.push(...(await filingsFor(t, ciks.get(t.toUpperCase()))));
    } catch (err) {
      failures.push({ label: `edgar:${t}`, error: String(err.message || err), at: nowISO() });
    }
    await sleep(150); // ~7 req/s, inside SEC's limit
  }

  for (const f of WIRES) {
    try {
      wires.push(...(await wireItems(f)));
    } catch (err) {
      failures.push({ label: `wire:${f.name}`, error: String(err.message || err), at: nowISO() });
    }
    await sleep(300);
  }

  // tag wire items that name a watchlist company, so catalysts can be matched to the book
  const set = new Set(tickers);
  for (const w of wires) {
    w.tickersMentioned = [...set].filter((t) => new RegExp(`\\b${t}\\b`).test(w.title || ""));
  }
} catch (err) {
  fatal = { error: String(err.stack || err.message || err), at: nowISO() };
}

await mkdir("data", { recursive: true });
const meta = { generatedAt: nowISO(), hoursBack: HOURS_BACK, tickersRequested: tickers.length };

await writeFile("data/filings.json", JSON.stringify({ ...meta, count: filings.length, rows: filings }, null, 2));
await writeFile("data/wires.json", JSON.stringify({ ...meta, count: wires.length, rows: wires }, null, 2));
await writeFile("data/news-failures.json", JSON.stringify({ ...meta, fatal, count: failures.length, failures }, null, 2));

console.log(
  `filings ${filings.length} · wire items ${wires.length} · failures ${failures.length}${fatal ? " · FATAL" : ""}`
);
if (fatal) console.error(fatal.error);
