import type { ProviderInfo, ProviderInstance } from "./shared/ipc";

/** "Signed in as a@b.c · Plus", or null when the CLI did not say who. */
export function accountLine(p: ProviderInfo): string | null {
  const a = p.auth === "signedIn" ? p.account : undefined;
  if (!a?.email && !a?.plan) return null;
  const plan = a.plan ? a.plan[0].toUpperCase() + a.plan.slice(1) : null;
  if (!a.email) return `${plan} plan`;
  return plan ? `Signed in as ${a.email} · ${plan}` : `Signed in as ${a.email}`;
}

/**
 * "Connect another ChatGPT account" (#1659, after T3 Code): a Codex
 * instance with its own CODEX_HOME, so `codex login` there signs in a
 * separate ChatGPT account. Solenta never holds the tokens; codex does.
 * Returns the instance list to save and the ref to sign in to.
 */
export function addChatGptAccount(
  instances: readonly ProviderInstance[],
  id: string = crypto.randomUUID().slice(0, 8),
): { list: ProviderInstance[]; ref: string } {
  const taken = new Set(instances.map((i) => i.name));
  let n = 2;
  while (taken.has(`ChatGPT ${n}`)) n++;
  const inst: ProviderInstance = {
    id,
    name: `ChatGPT ${n}`,
    provider: "codex",
    configDir: `~/.codex-${id}`,
    env: {},
  };
  return { list: [...instances, inst], ref: `codex:${id}` };
}
