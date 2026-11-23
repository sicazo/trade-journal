import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "journal-strategyforge-"));
vi.stubEnv("JOURNAL_DATA_DIR", scratch);
const { db, accounts, executions, trades, settings } = await import("../src/db");
const { dealToExecution, resetStrategyForgeCursor, strategyForgeConfig, syncStrategyForge } =
  await import("../src/server/strategyforge-sync");
type Deal = Parameters<typeof dealToExecution>[0];

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const ACCOUNT = "Demo-Server|26798912";
const config = { url: "https://sf.test", token: "id.secret", intervalMinutes: 5 };

let ticket = 1000;
const deal = (overrides: Partial<Deal>): Deal => ({
  id: crypto.randomUUID(),
  account: ACCOUNT,
  server: "Demo-Server",
  login: 26798912,
  seq: ticket,
  ticket: String(ticket++),
  position_id: "77",
  side: "buy",
  entry: "in",
  symbol: "XAUUSD",
  volume: 0.1,
  price: 2650,
  profit: 0,
  commission: 0,
  swap: 0,
  fee: 0,
  executed_at: "2026-11-02T10:00:00.000Z",
  ...overrides,
});

/** A fake StrategyForge serving `pages` in order, recording each request. */
const server = (pages: Deal[][], fail = false) => {
  const requests: URL[] = [];
  const fetcher = (async (input: URL) => {
    requests.push(input);
    if (fail) return new Response("down", { status: 503 });
    const after = input.searchParams.get("after");
    const index = after ? Number(after) : 0;
    const page = pages[index] ?? [];
    return Response.json({
      executions: page,
      accounts: [
        {
          account: ACCOUNT,
          currency: "USD",
          company: "Broker Ltd",
          name: "FTMO 100k",
          stage: "challenge",
        },
      ],
      next_cursor: page.length ? String(index + 1) : null,
      has_more: index + 1 < pages.length,
    });
  }) as unknown as typeof fetch;
  return { fetcher, requests };
};

beforeEach(() => {
  db.delete(trades).run();
  db.delete(executions).run();
  db.delete(accounts).run();
  db.delete(settings).run();
});

describe("StrategyForge deal mapping", () => {
  it("labels opens and closes by MT5 position and keeps broker P&L", () => {
    const open = dealToExecution(deal({ ticket: "1", side: "sell", commission: -0.7 }));
    const close = dealToExecution(
      deal({ ticket: "2", side: "buy", entry: "out", profit: -3, swap: 0.5 }),
    );
    if (typeof open === "string" || typeof close === "string") throw new Error("mapped");
    expect(open.importMetadata?.position).toMatchObject({
      direction: "short",
      effect: "open",
      positionId: "77",
      executionId: "1",
    });
    expect(open.fee).toBeCloseTo(0.7);
    expect(open.importMetadata?.reportedGrossPnl).toBeUndefined();
    // A swap credit is no cost: it moves into the gross so net stays profit + swap.
    expect(close.fee).toBe(0);
    expect(close.importMetadata?.reportedGrossPnl).toBeCloseTo(-2.5);
    expect(close.importMetadata?.position).toMatchObject({ direction: "short", effect: "close" });
  });
  it("keeps 63-bit cTrader ids exact and orders by the feed sequence", () => {
    const big = "4611686018427400249";
    const fill = dealToExecution(
      deal({ ticket: big, position_id: "4611686018427400248", seq: 42 }),
    );
    if (typeof fill === "string") throw new Error(fill);
    expect(fill.importMetadata?.position).toMatchObject({
      executionId: big,
      positionId: "4611686018427400248",
      sequence: 42,
    });
    expect(fill.importMetadata?.id).toBe(`execution:${big}`);
    expect(typeof dealToExecution(deal({ ticket: "12a" }))).toBe("string");
  });
  it("refuses netting reversals and reads config from the environment", () => {
    expect(typeof dealToExecution(deal({ entry: "inout" }))).toBe("string");
    expect(strategyForgeConfig({})).toBeNull();
    expect(
      strategyForgeConfig({ STRATEGYFORGE_URL: "https://sf.test/", STRATEGYFORGE_TOKEN: "t" }),
    ).toEqual({ url: "https://sf.test", token: "t", intervalMinutes: 5 });
  });
});

describe("StrategyForge sync", () => {
  it("journals partial closes and hedged positions with the broker's net P&L", async () => {
    const pages = [
      [
        deal({ position_id: "77", commission: -0.7 }),
        deal({
          position_id: "78",
          side: "sell",
          volume: 0.2,
          price: 2660,
          executed_at: "2026-11-02T10:05:00.000Z",
        }),
      ],
      [
        deal({
          position_id: "77",
          side: "sell",
          entry: "out",
          volume: 0.04,
          price: 2651,
          profit: 4,
          executed_at: "2026-11-02T11:00:00.000Z",
        }),
        deal({
          position_id: "77",
          side: "sell",
          entry: "out",
          volume: 0.06,
          price: 2651,
          profit: 6,
          swap: -1.2,
          executed_at: "2026-11-03T09:00:00.000Z",
        }),
        deal({
          position_id: "78",
          side: "buy",
          entry: "out_by",
          volume: 0.2,
          price: 2660.15,
          profit: -3,
          swap: 0.5,
          executed_at: "2026-11-02T12:00:00.000Z",
        }),
      ],
    ];
    const run = await syncStrategyForge(config, server(pages).fetcher);
    expect(run.error).toBeUndefined();
    expect(run).toMatchObject({ fetched: 5, inserted: 5, pending: 0, accounts: 1 });

    const account = db.select().from(accounts).get()!;
    expect(account).toMatchObject({ name: "FTMO 100k · challenge", currency: "USD" });
    const rows = db.select().from(trades).all();
    expect(rows).toHaveLength(2);
    const long = rows.find((t) => t.direction === "long")!;
    const short = rows.find((t) => t.direction === "short")!;
    expect(long.status).toBe("win");
    expect(long.netPnl).toBeCloseTo(4 + 6 - 0.7 - 1.2);
    expect(short.netPnl).toBeCloseTo(-3 + 0.5);

    // A second pass over the same history changes nothing.
    resetStrategyForgeCursor();
    const again = await syncStrategyForge(config, server(pages).fetcher);
    expect(again).toMatchObject({ inserted: 0, duplicates: 5 });
    expect(db.select().from(accounts).all()).toHaveLength(1);
  });

  it("holds a close until its opening deal arrives, and keeps the cursor on failure", async () => {
    const close = deal({ position_id: "90", side: "sell", entry: "out", profit: 5 });
    const first = server([[close]]);
    const run1 = await syncStrategyForge(config, first.fetcher);
    expect(run1).toMatchObject({ inserted: 0, pending: 1 });

    const failed = await syncStrategyForge(config, server([], true).fetcher);
    expect(failed.error).toMatch(/503/);

    const open = deal({ position_id: "90", executed_at: "2026-11-02T09:00:00.000Z" });
    const second = server([[close], [open]]);
    const run2 = await syncStrategyForge(config, second.fetcher);
    // It resumed after the first page and replayed the held close.
    expect(second.requests[0]!.searchParams.get("after")).toBe("1");
    expect(run2).toMatchObject({ inserted: 2, pending: 0 });
    const [trip] = db.select().from(trades).all();
    expect(trip!.netPnl).toBeCloseTo(5);
  });
});
