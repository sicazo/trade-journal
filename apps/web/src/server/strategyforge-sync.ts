import { eq } from "drizzle-orm";
import type { ImportedExecution } from "@luxalgo/journal-importers";
import { accounts, db, executions } from "@/db";
import { insertExecutions } from "./executions";
import { newId, nowIso } from "./ids";
import { getSetting, setSetting } from "./settings";

/**
 * Pulls MT5 deals from a StrategyForge daemon (`GET /api/v1/executions`, read-scope
 * bearer token) and journals them as position-labelled fills, one journal account
 * per MT5 account. Every deal carries its ticket, so re-reading is a no-op, and the
 * broker's own profit is kept as the reported gross P&L, so no contract sizes or FX
 * rates are needed.
 */

const CURSOR_KEY = "strategyforge.cursor";
const PENDING_KEY = "strategyforge.pending";
const ACCOUNTS_KEY = "strategyforge.accounts";
const LAST_RUN_KEY = "strategyforge.lastRun";
const PAGE_LIMIT = 500;
const MAX_PAGES_PER_RUN = 100;
const MAX_PENDING = 10_000;
const EPS = 1e-9;

/** Same key as journal-importers' (unexported) positionGroup; positionFillProblem checks it. */
const positionGroup = (position: { positionId: string; direction: "long" | "short" }): string =>
  `csv-position:${JSON.stringify([null, position.positionId, position.direction])}`;

export interface StrategyForgeDeal {
  id: string;
  account: string;
  server: string | null;
  login: number | string | null;
  ticket: number;
  position_id: number;
  side: "buy" | "sell";
  entry: "in" | "out" | "inout" | "out_by" | "unknown";
  symbol: string;
  volume: number;
  price: number;
  profit: number | null;
  commission: number | null;
  swap: number | null;
  fee: number | null;
  executed_at: string;
}

interface StrategyForgeAccount {
  account: string;
  server?: string | null;
  login?: number | string | null;
  currency?: string | null;
  company?: string | null;
}

interface ExecutionsPage {
  executions: StrategyForgeDeal[];
  accounts: StrategyForgeAccount[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface StrategyForgeConfig {
  url: string;
  token: string;
  intervalMinutes: number;
}

export interface StrategyForgeRunResult {
  startedAt: string;
  finishedAt: string;
  fetched: number;
  inserted: number;
  duplicates: number;
  skipped: number;
  pending: number;
  accounts: number;
  messages: string[];
  error?: string;
}

export const strategyForgeConfig = (
  env: Record<string, string | undefined> = process.env,
): StrategyForgeConfig | null => {
  const url = env.STRATEGYFORGE_URL?.trim().replace(/\/+$/, "");
  const token = env.STRATEGYFORGE_TOKEN?.trim();
  if (!url || !token) return null;
  const minutes = Number(env.STRATEGYFORGE_SYNC_MINUTES ?? "5");
  return { url, token, intervalMinutes: Number.isFinite(minutes) && minutes >= 1 ? minutes : 5 };
};

const num = (value: number | null | undefined): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

/**
 * One MT5 deal as one journal fill, or the reason it cannot be journaled.
 * MT5 signs commission/swap/fee (negative = cost); the journal wants a
 * non-negative cost, so a net credit on a closing deal moves into its gross P&L.
 */
export const dealToExecution = (deal: StrategyForgeDeal): ImportedExecution | string => {
  if (deal.entry !== "in" && deal.entry !== "out" && deal.entry !== "out_by")
    return `Deal ${deal.ticket}: ${deal.entry} deals (netting-account reversals) are not supported.`;
  if (!deal.symbol || !(deal.volume > 0) || !Number.isFinite(deal.price))
    return `Deal ${deal.ticket}: missing symbol, volume or price.`;
  if (!Number.isFinite(Date.parse(deal.executed_at))) return `Deal ${deal.ticket}: invalid time.`;
  if (!Number.isSafeInteger(deal.ticket)) return `Deal ${deal.ticket}: invalid ticket.`;
  const effect = deal.entry === "in" ? "open" : "close";
  // An opening buy is long; a closing sell closes a long.
  const direction = (deal.side === "buy") === (effect === "open") ? "long" : "short";
  const position = {
    direction,
    effect,
    positionId: String(deal.position_id),
    executionId: String(deal.ticket),
    // Tickets increase with time, so they order fills that share a timestamp.
    sequence: deal.ticket,
  } as const;
  const cost = -(num(deal.commission) + num(deal.swap) + num(deal.fee));
  const credit = cost < 0 ? -cost : 0;
  return {
    symbol: deal.symbol.trim().toUpperCase(),
    side: deal.side,
    quantity: deal.volume,
    price: deal.price,
    fee: Math.max(cost, 0),
    executedAt: new Date(deal.executed_at).toISOString(),
    importMetadata: {
      id: `execution:${position.executionId}`,
      group: positionGroup(position),
      order: position.sequence,
      preserveFee: true,
      position,
      ...(effect === "close" ? { reportedGrossPnl: num(deal.profit) + credit } : {}),
    },
  };
};

const readJson = <T>(key: string, fallback: T): T => {
  const raw = getSetting(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

const accountName = (info: StrategyForgeAccount | undefined, key: string): string => {
  const [server, login] = key.split("|");
  const label = info?.company || server;
  return `MT5 ${login ?? key}${label ? ` (${label})` : ""}`;
};

/** The journal account for an MT5 account, created on first sight. */
const journalAccountFor = (
  key: string,
  info: StrategyForgeAccount | undefined,
  map: Record<string, string>,
): string => {
  const known = map[key];
  if (known && db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, known)).get())
    return known;
  const id = newId();
  db.insert(accounts)
    .values({
      id,
      name: accountName(info, key),
      broker: "StrategyForge MT5",
      kind: "import",
      currency: info?.currency?.trim().toUpperCase() || "USD",
      createdAt: nowIso(),
    })
    .run();
  map[key] = id;
  return id;
};

/** Open quantity per MT5 position id already in the journal account. */
const openQuantities = (accountId: string): Map<string, number> => {
  const open = new Map<string, number>();
  for (const row of db
    .select({ quantity: executions.quantity, meta: executions.importMetadataJson })
    .from(executions)
    .where(eq(executions.accountId, accountId))
    .all()) {
    const position = row.meta ? JSON.parse(row.meta).position : undefined;
    if (!position?.positionId) continue;
    const signed = position.effect === "open" ? row.quantity : -row.quantity;
    open.set(position.positionId, (open.get(position.positionId) ?? 0) + signed);
  }
  return open;
};

/**
 * Splits fills into those safe to insert now and closes whose opening deal has
 * not arrived yet. The journal refuses a close larger than its open quantity,
 * so those wait (in arrival order) for a later run instead of failing the batch.
 */
const readyFills = (
  accountId: string,
  items: { deal: StrategyForgeDeal; fill: ImportedExecution }[],
) => {
  const open = openQuantities(accountId);
  const ready: typeof items = [];
  const waiting: typeof items = [];
  const sorted = [...items].sort(
    (a, b) =>
      Date.parse(a.fill.executedAt) - Date.parse(b.fill.executedAt) ||
      a.deal.ticket - b.deal.ticket,
  );
  for (const item of sorted) {
    const position = item.fill.importMetadata!.position!;
    const id = position.positionId!;
    const current = open.get(id) ?? 0;
    if (position.effect === "close" && item.fill.quantity > current + EPS) {
      waiting.push(item);
      continue;
    }
    open.set(id, current + (position.effect === "open" ? item.fill.quantity : -item.fill.quantity));
    ready.push(item);
  }
  return { ready, waiting };
};

type Fetcher = typeof globalThis.fetch;

const fetchPage = async (
  config: StrategyForgeConfig,
  cursor: string | null,
  fetcher: Fetcher,
): Promise<ExecutionsPage> => {
  const url = new URL(`${config.url}/api/v1/executions`);
  url.searchParams.set("limit", String(PAGE_LIMIT));
  if (cursor) url.searchParams.set("after", cursor);
  const response = await fetcher(url, {
    headers: { Authorization: `Bearer ${config.token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
    cache: "no-store",
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `StrategyForge answered ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
    );
  }
  return (await response.json()) as ExecutionsPage;
};

/**
 * One sync pass. The cursor and the waiting deals are saved only after the
 * fills they cover are stored, so a failure anywhere repeats the pass next time.
 */
export const syncStrategyForge = async (
  config: StrategyForgeConfig,
  fetcher: Fetcher = globalThis.fetch,
): Promise<StrategyForgeRunResult> => {
  const startedAt = nowIso();
  const result: StrategyForgeRunResult = {
    startedAt,
    finishedAt: startedAt,
    fetched: 0,
    inserted: 0,
    duplicates: 0,
    skipped: 0,
    pending: 0,
    accounts: 0,
    messages: [],
  };
  try {
    let cursor = getSetting(CURSOR_KEY);
    const deals: StrategyForgeDeal[] = readJson<StrategyForgeDeal[]>(PENDING_KEY, []);
    const infos = new Map<string, StrategyForgeAccount>();
    for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
      const data = await fetchPage(config, cursor, fetcher);
      for (const info of data.accounts ?? []) infos.set(info.account, info);
      deals.push(...data.executions);
      result.fetched += data.executions.length;
      if (data.next_cursor) cursor = data.next_cursor;
      if (!data.has_more) break;
    }

    const map = readJson<Record<string, string>>(ACCOUNTS_KEY, {});
    const byAccount = new Map<string, { deal: StrategyForgeDeal; fill: ImportedExecution }[]>();
    const seen = new Set<string>();
    for (const deal of deals) {
      const key = `${deal.account}|${deal.ticket}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const fill = dealToExecution(deal);
      if (typeof fill === "string") {
        result.skipped++;
        if (result.messages.length < 10) result.messages.push(fill);
        continue;
      }
      const list = byAccount.get(deal.account) ?? [];
      list.push({ deal, fill });
      byAccount.set(deal.account, list);
    }

    const waiting: StrategyForgeDeal[] = [];
    for (const [key, items] of byAccount) {
      const accountId = journalAccountFor(key, infos.get(key), map);
      setSetting(ACCOUNTS_KEY, JSON.stringify(map));
      const split = readyFills(accountId, items);
      waiting.push(...split.waiting.map((item) => item.deal));
      if (split.ready.length) {
        try {
          const inserted = insertExecutions(
            accountId,
            split.ready.map((item) => item.fill),
            "sync",
          );
          result.inserted += inserted.inserted;
          result.duplicates += inserted.duplicates;
          result.skipped += inserted.skipped;
          result.messages.push(...inserted.skippedReasons);
        } catch (error) {
          // The journal saved nothing for this account; keep its deals for the next run.
          waiting.push(...split.ready.map((item) => item.deal));
          result.messages.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      result.accounts++;
    }
    if (waiting.length > MAX_PENDING)
      result.messages.push(
        `${waiting.length - MAX_PENDING} closing deals without an opening deal were dropped.`,
      );
    setSetting(PENDING_KEY, JSON.stringify(waiting.slice(-MAX_PENDING)));
    if (cursor) setSetting(CURSOR_KEY, cursor);
    result.pending = Math.min(waiting.length, MAX_PENDING);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  result.finishedAt = nowIso();
  setSetting(LAST_RUN_KEY, JSON.stringify(result));
  return result;
};

export const lastStrategyForgeRun = (): StrategyForgeRunResult | null =>
  readJson<StrategyForgeRunResult | null>(LAST_RUN_KEY, null);

/** Forget the cursor so the next run re-reads everything (fills still deduplicate). */
export const resetStrategyForgeCursor = (): void => {
  setSetting(CURSOR_KEY, "");
  setSetting(PENDING_KEY, "[]");
};

const globalState = globalThis as unknown as {
  __strategyForgeRun?: Promise<StrategyForgeRunResult>;
  __strategyForgeTimer?: ReturnType<typeof setInterval>;
};

/** Runs a pass unless one is already running, in which case it joins that one. */
export const runStrategyForgeSync = (
  config: StrategyForgeConfig | null = strategyForgeConfig(),
): Promise<StrategyForgeRunResult> | null => {
  if (!config) return null;
  globalState.__strategyForgeRun ??= syncStrategyForge(config).finally(() => {
    globalState.__strategyForgeRun = undefined;
  });
  return globalState.__strategyForgeRun;
};

/** Starts the background schedule once per process (called from instrumentation). */
export const startStrategyForgeSchedule = (): void => {
  const config = strategyForgeConfig();
  if (!config || globalState.__strategyForgeTimer) return;
  const tick = () => {
    void runStrategyForgeSync(config)?.then((run) => {
      if (run.error) console.error(`[strategyforge] sync failed: ${run.error}`);
      else if (run.inserted || run.pending || run.skipped)
        console.log(
          `[strategyforge] +${run.inserted} fills, ${run.pending} waiting, ${run.skipped} skipped`,
        );
    });
  };
  globalState.__strategyForgeTimer = setInterval(tick, config.intervalMinutes * 60_000);
  globalState.__strategyForgeTimer.unref?.();
  tick();
  console.log(`[strategyforge] syncing from ${config.url} every ${config.intervalMinutes} min`);
};
