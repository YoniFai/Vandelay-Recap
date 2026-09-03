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
// Run:  node pipeline/fetch-news.mjs
// Node 18+. No API keys.
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

async function getText(url, label) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/xml,text/xml,*/*" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
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

// --- EDGAR: one atom feed per ticker, filings newest first, absolute timestamps
async function filingsFor(ticker) {
  const url =
    `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&ticker=${ticker}` +
    `&type=&dateb=&owner=include&count=20&output=atom`;
  const xml = await getText(url, `edgar:${ticker}`);
  if (!xml) return [];
  return blocks(xml, "entry")
    .map((e) => {
      const filedAt = tag(e, "filing-date") || tag(e, "updated");
      const type = tag(e, "filing-type") || tag(e, "category");
      return {
        ticker,
        form: type,
        title: tag(e, "title"),
        filedAt,                       // absolute, from EDGAR
        url: href(e),
        accession: tag(e, "accession-number") || null,
      };
    })
    .filter((f) => f.filedAt && Date.parse(f.filedAt) >= cutoff)
    .filter((f) => !FORMS.length || FORMS.some((x) => (f.form || "").includes(x)));
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
const wl = JSON.parse(await readFile("watchlist.json", "utf8"));
const tickers = wl.tickers || [];

const filings = [];
for (const t of tickers) {
  filings.push(...(await filingsFor(t)));
  await sleep(150); // ~7 req/s, inside SEC's limit
}

const wires = [];
for (const f of WIRES) {
  wires.push(...(await wireItems(f)));
  await sleep(300);
}

// tag wire items that name a watchlist company, so catalysts can be matched to the book
const set = new Set(tickers);
for (const w of wires) {
  w.tickersMentioned = [...set].filter((t) =>
    new RegExp(`\\b${t}\\b`).test(w.title || "")
  );
}

await mkdir("data", { recursive: true });
const meta = { generatedAt: nowISO(), hoursBack: HOURS_BACK, tickersRequested: tickers.length };

await writeFile("data/filings.json", JSON.stringify({ ...meta, count: filings.length, rows: filings }, null, 2));
await writeFile("data/wires.json", JSON.stringify({ ...meta, count: wires.length, rows: wires }, null, 2));
await writeFile("data/news-failures.json", JSON.stringify({ ...meta, count: failures.length, failures }, null, 2));

console.log(`filings ${filings.length} · wire items ${wires.length} · failures ${failures.length}`);
