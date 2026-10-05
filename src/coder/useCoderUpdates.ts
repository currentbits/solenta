import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { CoderApi, UpdateStatus } from "../shared/ipc";

/** App update actions. updateStatus and the hourly check effect stay in useCoder. */
export function useCoderUpdates({
  api,
  setUpdateStatus,
}: {
  api: CoderApi;
  setUpdateStatus: Dispatch<SetStateAction<UpdateStatus | null>>;
}) {
  // A rejected update call used to be an unhandled rejection: the spinner
  // stopped, nothing was said, and a stale "Up to date." stayed on screen.
  // The updater's own failures already come back as state:"error", so reuse
  // that shape for transport/handler failures instead of a second channel.
  const failUpdate = useCallback((err: unknown) => {
    setUpdateStatus((prev) => ({
      channel: prev?.channel ?? null,
      tag: prev?.tag ?? null,
      url: prev?.url ?? null,
      state: "error",
      error: err instanceof Error && err.message ? err.message : String(err),
    }));
  }, []);

  const applyUpdate = useCallback(async () => {
    try {
      await api.app.applyUpdate();
    } catch (err) {
      failUpdate(err);
    }
  }, [api, failUpdate]);

  const checkUpdate = useCallback(async () => {
    try {
      setUpdateStatus(await api.app.checkUpdate());
    } catch (err) {
      failUpdate(err);
    }
  }, [api, failUpdate]);

  const downloadUpdate = useCallback(async () => {
    try {
      setUpdateStatus(await api.app.downloadUpdate());
    } catch (err) {
      failUpdate(err);
    }
  }, [api, failUpdate]);

  return {
    applyUpdate,
    checkUpdate,
    downloadUpdate,
  };
}
