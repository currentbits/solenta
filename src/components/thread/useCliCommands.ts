import { useEffect, useState } from "react";
import type { CliSlashCommand, ProjectInfo, ThreadDetail } from "../../shared/ipc";
import type { SlashCommand } from "../../slashCommands";

/** CLI-native slash commands for the open thread's provider (Composer menu). */
export function useCliCommands({
  onListCliCommands,
  project,
  threadId,
  detail,
}: {
  onListCliCommands?: (input?: {
    provider?: string;
    projectPath?: string;
  }) => Promise<CliSlashCommand[]>;
  project: ProjectInfo | null;
  threadId: string | null;
  detail: ThreadDetail | null;
}) {
  const [cliCommands, setCliCommands] = useState<SlashCommand[]>([]);
  useEffect(() => {
    if (!onListCliCommands) {
      setCliCommands([]);
      return;
    }
    let cancelled = false;
    onListCliCommands({ projectPath: project?.path, provider: detail?.thread.provider })
      .then((rows) => {
        if (cancelled) return;
        setCliCommands(
          rows.map((r) => ({
            name: r.name,
            hint: r.hint,
            kind: "insert" as const,
          })),
        );
      })
      .catch(() => {
        if (!cancelled) setCliCommands([]);
      });
    return () => {
      cancelled = true;
    };
  }, [onListCliCommands, project?.path, threadId, detail?.thread.provider]);
  return cliCommands;
}
