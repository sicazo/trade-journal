# StrategyForge sync and Coolify deploy (fork)

This fork adds one feature on top of LuxAlgo's journal: it pulls MT5 deals from a
[StrategyForge](https://github.com/sicazo/quant/tree/main/strategyforge_daemon) daemon on a
schedule, so every trade the `FuchikomaLogger` EA reports shows up here without an import.
The feature lives in new files only, so upstream merges stay clean:

| File                                          | Purpose                                                                     |
| --------------------------------------------- | --------------------------------------------------------------------------- |
| `apps/web/src/server/strategyforge-sync.ts`   | Fetch, deal → fill mapping, cursor, held-back closes, schedule              |
| `apps/web/src/instrumentation.ts` (+`-node`)  | Starts the schedule when the server starts                                  |
| `apps/web/src/app/api/strategyforge/route.ts` | `GET` status and last run, `POST` sync now (`?reset=1` re-reads everything) |
| `apps/web/tests/strategyforge-sync.test.ts`   | Mapping, partial closes, hedged positions, retries                          |
| `.github/workflows/docker-image.yml`          | Builds the image and pushes it to GHCR                                      |

## How it works

- Every `STRATEGYFORGE_SYNC_MINUTES` (default 5) and once at start, the server reads
  `GET <STRATEGYFORGE_URL>/api/v1/executions?after=<cursor>` with a read-scope token.
- Each MT5 account (`server|login`) gets its own journal account, `MT5 <login> (<broker>)`, in the
  account currency of its latest `mt5.account` snapshot.
- Each buy/sell deal becomes one position-labelled fill. The MT5 position id keeps hedged positions on
  one symbol apart, and the ticket is the fill id, so re-reading is a no-op. Closing deals carry MT5's
  `profit` as the reported gross P&L, and commission, swap and fee become the fill cost. Net P&L
  equals the broker's numbers without contract sizes or FX rates.
- A closing deal whose opening deal is not in the journal yet waits and is retried on the next run.
  The cursor only moves after the fills are stored, so a failed run repeats.
- Not supported: `INOUT` deals (netting-account reversals; skipped and reported in the last run).
- Deal times are StrategyForge's `occurred_at`. The logger converts server time with the offset at
  send time, so backfilled deals from the other side of a DST change are one hour off.

## Environment

| Env var                      | Effect                                                                     |
| ---------------------------- | -------------------------------------------------------------------------- |
| `STRATEGYFORGE_URL`          | Daemon base URL, e.g. `https://sf.example.com`. Unset = sync off.          |
| `STRATEGYFORGE_TOKEN`        | Token created on the daemon's Tokens page with scope "Read (journal sync)" |
| `STRATEGYFORGE_SYNC_MINUTES` | Minutes between runs, default 5                                            |

## Deploy on Coolify

1. Every push to `main` builds `ghcr.io/<owner>/trade-journal:latest` and `:<git-sha>`; other branches
   build `:<git-sha>` only. The package is private by default.
2. In Coolify, create a resource of type **Docker Image** with that image, and add a registry
   credential for `ghcr.io` (username = GitHub username, password = a PAT with `read:packages`).
3. Port `3000`.
4. **Persistent storage mounted at `/data`.** The SQLite database, attachments and the encryption key
   live there; without the volume every redeploy starts an empty journal.
5. Environment:
   - `JOURNAL_PASSWORD`: required once the journal is reachable from the internet.
   - `JOURNAL_SECRET`: optional; otherwise a key file is generated in `/data`.
   - `STRATEGYFORGE_URL`, `STRATEGYFORGE_TOKEN`, optionally `STRATEGYFORGE_SYNC_MINUTES`.
6. Add the domain (Coolify's proxy terminates HTTPS) and deploy. The container log shows
   `[strategyforge] syncing from ... every N min`, then one line per run that stored fills.
7. To roll out a specific build, pin the tag to the commit sha instead of `:latest`.
