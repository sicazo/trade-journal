import { bad, handler, ok } from "@/server/api";
import {
  lastStrategyForgeRun,
  resetStrategyForgeCursor,
  runStrategyForgeSync,
  strategyForgeConfig,
} from "@/server/strategyforge-sync";

/** Status of the StrategyForge sync: whether it is configured and the last run. */
export const GET = handler(() => {
  const config = strategyForgeConfig();
  return ok({
    configured: Boolean(config),
    url: config?.url ?? null,
    intervalMinutes: config?.intervalMinutes ?? null,
    lastRun: lastStrategyForgeRun(),
  });
});

/** Sync now. `?reset=1` re-reads the whole history first (fills still deduplicate). */
export const POST = handler(async (request: Request) => {
  if (!strategyForgeConfig()) return bad("Set STRATEGYFORGE_URL and STRATEGYFORGE_TOKEN first.");
  if (new URL(request.url).searchParams.get("reset") === "1") resetStrategyForgeCursor();
  const run = await runStrategyForgeSync();
  return ok({ run });
});
