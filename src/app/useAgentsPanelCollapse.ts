import {
  useCallback,
  useEffect,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { AppSettings } from "../shared/ipc";
import type { DrawerId } from "../App";
import {
  agentsPanelStartsCollapsed,
  saveLastAgentsCollapsed,
} from "./agentsPanelStorage";

/** Agents panel collapse: settings default, remember-last, toggle, focus. */
export function useAgentsPanelCollapse({
  settings,
  narrow,
  agentsCollapsed,
  setAgentsCollapsed,
  setDrawer,
  collapseSourceRef,
  rememberLastRef,
  appliedPanelDefaultRef,
  agentsExpandRef,
}: {
  settings: AppSettings | null;
  narrow: boolean;
  agentsCollapsed: boolean;
  setAgentsCollapsed: Dispatch<SetStateAction<boolean>>;
  setDrawer: Dispatch<SetStateAction<DrawerId | null>>;
  collapseSourceRef: RefObject<"user" | null>;
  rememberLastRef: RefObject<boolean>;
  appliedPanelDefaultRef: RefObject<"closed" | "open" | null>;
  agentsExpandRef: RefObject<HTMLButtonElement | null>;
}) {
  const persistLastIfRemembering = useCallback((collapsed: boolean) => {
    if (rememberLastRef.current) saveLastAgentsCollapsed(collapsed);
  }, []);

  useEffect(() => {
    if (!settings) return;
    const def = settings.agentsPanelDefault === "open" ? "open" : "closed";
    if (appliedPanelDefaultRef.current === null) {
      appliedPanelDefaultRef.current = def;
      setAgentsCollapsed(
        agentsPanelStartsCollapsed(def, settings.agentsPanelRememberLast),
      );
      return;
    }
    if (appliedPanelDefaultRef.current !== def) {
      appliedPanelDefaultRef.current = def;
      const collapsed = def !== "open";
      setAgentsCollapsed(collapsed);
      persistLastIfRemembering(collapsed);
    }
  }, [settings, persistLastIfRemembering]);

  const collapseAgents = useCallback(() => {
    collapseSourceRef.current = "user";
    setAgentsCollapsed(true);
    persistLastIfRemembering(true);
  }, [persistLastIfRemembering]);

  // A second workspace pane (Git, Terminal, Browser, …) takes the rail's
  // width. Not flagged as a "user" collapse: focus stays where it was, and
  // the expand button is still one click away.
  const collapseAgentsForPanes = useCallback(() => setAgentsCollapsed(true), []);

  const toggleAgents = useCallback(() => {
    if (narrow) {
      setDrawer((d) => (d === "agents" ? null : "agents"));
      return;
    }
    collapseSourceRef.current = "user";
    setAgentsCollapsed((c) => {
      const next = !c;
      persistLastIfRemembering(next);
      return next;
    });
  }, [narrow, persistLastIfRemembering]);

  useEffect(() => {
    if (collapseSourceRef.current !== "user") return;
    collapseSourceRef.current = null;
    if (agentsCollapsed && !narrow) agentsExpandRef.current?.focus();
  }, [agentsCollapsed, narrow]);

  return {
    persistLastIfRemembering,
    collapseAgents,
    collapseAgentsForPanes,
    toggleAgents,
  };
}
