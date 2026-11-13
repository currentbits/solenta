import type { ChatMessage, RunConfiguration } from "./shared/ipc";
import { metaModelLabel } from "./messageMeta";

export function runConfigurationLabel(configuration: RunConfiguration): string {
  return [
    configuration.provider,
    configuration.model ? metaModelLabel(configuration.model) : "default model",
    configuration.reasoningEffort ? `${configuration.reasoningEffort} effort` : "default effort",
  ].join(" · ");
}

function sameConfiguration(a: RunConfiguration | undefined, b: RunConfiguration): boolean {
  return a?.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort;
}

/** Historical attribution comes only from recorded dispatches, never today's picker.
 * Look ahead within a run for queued/replayed turns whose first row isn't a user
 * message. Explicit in-session switches apply only from that row onward.
 */
export function transcriptConfigurations(messages: ChatMessage[]) {
  const initialByRun = new Map<string, RunConfiguration>();
  for (const message of messages) {
    if (message.runId && message.runConfiguration && !initialByRun.has(message.runId)) {
      initialByRun.set(message.runId, message.runConfiguration);
    }
  }
  const currentByRun = new Map(initialByRun);
  const byMessageId = new Map<string, RunConfiguration>();
  const boundaryByMessageId = new Map<string, RunConfiguration>();
  let previous: RunConfiguration | undefined;
  for (const message of messages) {
    const configuration = message.runConfiguration;
    if (configuration) {
      if (!sameConfiguration(previous, configuration)) boundaryByMessageId.set(message.id, configuration);
      previous = configuration;
      if (message.runId) currentByRun.set(message.runId, configuration);
    }
    const current = message.runId ? currentByRun.get(message.runId) : undefined;
    if (current) byMessageId.set(message.id, current);
  }
  return { byMessageId, boundaryByMessageId };
}
