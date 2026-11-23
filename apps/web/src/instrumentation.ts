/** Next.js server start hook: starts the optional StrategyForge sync schedule. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
