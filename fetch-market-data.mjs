name: Vandelay morning data pull

on:
  schedule:
    # GitHub cron is UTC and ignores DST, so both fire and the guard below keeps
    # exactly one: 11:30Z = 07:30 EDT (summer), 12:30Z = 07:30 EST (winter).
    - cron: "30 11 * * 1-5"
    - cron: "30 12 * * 1-5"
  workflow_dispatch:

permissions:
  contents: write

jobs:
  pull:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "20"

      # One guard for the whole job, so market data and news never disagree about
      # whether this is the run of the day.
      - name: Is this the 07:00 ET window
        id: window
        run: |
          if [ "${{ github.event_name }}" != "schedule" ]; then
            echo "run=yes" >> "$GITHUB_OUTPUT"
            echo "manual dispatch — running"
            exit 0
          fi
          ET_HOUR=$(TZ=America/New_York date +%H)
          if [ "$ET_HOUR" = "07" ]; then
            echo "run=yes" >> "$GITHUB_OUTPUT"
          else
            echo "run=no" >> "$GITHUB_OUTPUT"
            echo "skip: ${ET_HOUR}:xx ET is outside the 07:00 ET pull window"
          fi

      # continue-on-error: a crash here must not abort the job, or data/ is left
      # with no screen AND no failures.json to explain why.
      - name: Fetch market data
        if: steps.window.outputs.run == 'yes'
        continue-on-error: true
        run: node fetch-market-data.mjs

      - name: Fetch filings and newswire feeds
        if: steps.window.outputs.run == 'yes'
        continue-on-error: true
        run: node fetch-news.mjs

      - name: Commit the morning pull
        if: steps.window.outputs.run == 'yes'
        run: |
          git config user.name "vandelay-data-bot"
          git config user.email "actions@github.com"
          git add data/
          if git diff --staged --quiet; then
            echo "no change to commit"
          else
            git commit -m "data: morning pull $(date -u +%Y-%m-%d\ %H:%MZ)"
            git push
          fi

      - name: Report what landed
        if: steps.window.outputs.run == 'yes'
        run: |
          for f in screen earnings shorts failures filings wires news-failures; do
            if [ -f "data/$f.json" ]; then
              echo "ok   data/$f.json ($(wc -c < data/$f.json) bytes)"
            else
              echo "MISS data/$f.json"
            fi
          done
