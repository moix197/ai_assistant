/**
 * The single seam for reading the monthly budget cap. Every cap read in this
 * package goes through this function, so a future DB-backed cap (e.g.
 * per-tenant, dynamically adjustable) replaces only this function's body,
 * not any call site. Deliberately does no caching, no DB reads, and no
 * multi-tenancy — that is explicitly future scope, not this phase's.
 */
export function resolveBudgetCapUsd(env: { LLM_MONTHLY_BUDGET_USD: number }): number {
  return env.LLM_MONTHLY_BUDGET_USD;
}
