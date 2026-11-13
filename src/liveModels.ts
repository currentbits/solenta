/**
 * Live model lists for the composer picker. The registry's model list is a
 * snapshot (see the Custom row note in modelPicker.ts); opening the picker
 * asks providers.fetchModels for the current provider and the rows it did
 * not know get appended here. Settings › Providers has its own live view.
 */
import type { FetchedModel, ProviderInfo } from "./shared/ipc";

/** At most one live fetch per provider in this window, failures included. */
export const LIVE_MODELS_TTL_MS = 5 * 60 * 1000;

// ponytail: id heuristic, OpenAI's /models also lists embeddings, audio and
// image models no CLI can chat with. Swap for a capability field if the
// endpoints ever expose one.
const NOT_CHAT = /embed|whisper|tts|dall-e|image|moderation|audio|realtime|transcribe/i;

/** Append fetched models each provider's list lacks; known rows keep their copy. */
export function withLiveModels(
  providers: ProviderInfo[],
  live: Readonly<Record<string, FetchedModel[]>>,
): ProviderInfo[] {
  if (Object.keys(live).length === 0) return providers;
  return providers.map((p) => {
    const fetched = live[p.id];
    if (!fetched?.length || p.bestEffort) return p;
    // A compat provider addresses models as `<id>/<model>`; the live list does not.
    const prefix = p.baseProvider === "opencode" && p.instanceId ? `${p.instanceId}/` : "";
    const known = new Set([...p.models, ...p.modelInfo.map((m) => m.id)]);
    const added = fetched
      .map((m) => ({ ...m, id: prefix + m.id }))
      .filter((m) => !known.has(m.id) && !NOT_CHAT.test(m.id));
    if (added.length === 0) return p;
    if (p.modelInfo.length === 0) {
      return { ...p, models: [...p.models, ...added.map((m) => m.id)] };
    }
    return {
      ...p,
      modelInfo: [
        ...p.modelInfo,
        ...added.map((m) => ({
          id: m.id,
          label: m.label,
          description: "",
          vendor: p.name,
          ...(m.contextTokens ? { contextTokens: m.contextTokens } : {}),
        })),
      ],
    };
  });
}
