# Vandelay morning data pipeline

Free, keyless, automated. It measures the whole watchlist before the open and commits the
result, so the recap is built from measured data instead of whatever the news mentioned.

## What it produces, every weekday morning

| File | What's in it |
|---|---|
| `data/screen.json` | Every watchlist ticker: last price, change, volume, 20-day average volume and relative volume, 52-week high/low, band position, and which price the band position was computed on |
| `data/earnings.json` | The day's reporters with consensus EPS, market cap, fiscal quarter, and before-open / after-close timing |
| `data/shorts.json` | Official settlement-date short interest, average daily volume, days-to-cover |
| `data/failures.json` | Every request that didn't return, with the error and a timestamp |

`failures.json` is the point, not an afterthought: a hole stays visible.

## Setup — three steps

1. **Create a repo** (private is fine) and put this project's files in it. What the pipeline
   needs is `watchlist.json` at the root and the `pipeline/` folder.
2. **Move the workflow into place:** copy `pipeline/market-data.yml` to
   `.github/workflows/market-data.yml`. GitHub only runs workflows from that path.
3. **Run it once by hand** — Actions tab → "Vandelay morning data pull" → Run workflow.
   Then open `data/failures.json` first. That tells us whether the endpoints answered.

Then connect the repo to this project and say "recap." I read `data/` directly.

## Local test, before trusting the schedule

```
node pipeline/fetch-market-data.mjs            # today
node pipeline/fetch-market-data.mjs 2026-09-03 # a specific date
```

Takes about a minute for 94 tickers — deliberately paced to stay polite.

## Sources it uses, and why

- **Nasdaq's own public endpoints** for quotes, extended-hours prints, the earnings
  calendar and short interest. No key, no login; official data from the exchange.
- **Stooq daily bars** for raw history, so 52-week bands and average volume are
  *computed here* rather than inherited from a page that might be stale.

Nothing in this pipeline estimates. If a field can't be fetched it is left null and the
failure is recorded.

## Expected first-run friction

Keyless endpoints are undocumented and their paths do change. If `failures.json` comes back
full, paste it into chat and I'll correct the endpoint paths. Two known behaviours:

- Nasdaq rejects requests without a `User-Agent` header — the script sets one. Put a real
  contact address in it (top of the script) as a courtesy.
- Stooq expects US tickers suffixed `.us`, which the script handles. A handful of tickers
  (recent listings, some ETFs) may have no history there; those rows come back without a
  band and the recap prints an em-dash rather than a guess.

## What this fixes in the brief

- **The screen becomes real.** All 94 names measured every morning; movers come out of the
  screen and news is attached to them, not the reverse.
- **"Biggest reporter by market cap" stops being a judgment call** — the calendar carries
  the caps.
- **Short interest comes from the exchange**, not a broker's characterisation.
- **Percentiles get computed from raw bars**, with the band endpoints and the price used
  both recorded.
