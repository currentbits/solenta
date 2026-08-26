import { useCallback, useEffect, useRef, useState } from "react";
import { isWebMode } from "../shared/wire";
import type {
  CoderApi,
  SimulatorCapabilitySnapshot,
  SimulatorDeviceInfo,
  SimulatorInput,
  SimulatorStatus,
} from "../shared/ipc";
import {
  connectSimulatorStream,
  type SimulatorStreamHandle,
  type SimulatorStreamOptions,
} from "../simulatorStream";
import { SimulatorCanvas } from "./SimulatorCanvas";
import { SimulatorControls } from "./SimulatorControls";
import styles from "./SimulatorPane.module.css";

export function SimulatorPane({
  threadId,
  api,
  status: statusProp,
  connectStream = connectSimulatorStream,
}: {
  threadId: string;
  api: CoderApi["simulator"];
  status?: SimulatorStatus | null;
  connectStream?: (opts: SimulatorStreamOptions) => SimulatorStreamHandle;
}) {
  const [caps, setCaps] = useState<SimulatorCapabilitySnapshot | null>(null);
  const [devices, setDevices] = useState<SimulatorDeviceInfo[]>([]);
  const [status, setStatus] = useState<SimulatorStatus | null>(null);
  const [deviceUdid, setDeviceUdid] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmTakeover, setConfirmTakeover] = useState(false);
  const [dimensions, setDimensions] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [streamGeneration, setStreamGeneration] = useState<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<SimulatorStreamHandle | null>(null);

  const merged = statusProp ?? status;
  const generation = merged?.generation ?? null;

  const stopStream = useCallback(() => {
    streamRef.current?.disconnect();
    streamRef.current = null;
    setDimensions(null);
    setStreamGeneration(null);
  }, []);

  const load = useCallback(async () => {
    const [nextCaps, nextDevices, nextStatus] = await Promise.all([
      api.capabilities({ threadId }),
      api.listDevices({ threadId }).catch(() => [] as SimulatorDeviceInfo[]),
      api.status({ threadId }),
    ]);
    setCaps(nextCaps);
    setDevices(nextDevices);
    setStatus(nextStatus);
    if (!deviceUdid && nextDevices[0]) setDeviceUdid(nextDevices[0].udid);
    else if (!deviceUdid && nextStatus.deviceUdid) {
      setDeviceUdid(nextStatus.deviceUdid);
    }
  }, [api, threadId, deviceUdid]);

  useEffect(() => {
    if (isWebMode()) return;
    let cancelled = false;
    void load().catch((err) => {
      if (!cancelled) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  useEffect(() => {
    if (statusProp) setStatus(statusProp);
  }, [statusProp]);

  const startStream = useCallback(
    async (gen: number, retry: boolean) => {
      stopStream();
      try {
        const info = retry
          ? await api.retryStream({ threadId, generation: gen })
          : await api.streamInfo({ threadId, generation: gen });
        const canvas = canvasRef.current;
        if (!canvas) return;
        streamRef.current = connectStream({
          info,
          canvas,
          onDimensions: (size) => {
            setDimensions(size);
            setStreamGeneration(info.generation);
          },
          onStatus: (next) => {
            if (next === "disconnected") {
              setDimensions(null);
              setStreamGeneration(null);
              setStatus((prev) =>
                prev ? { ...prev, stream: "disconnected" } : prev,
              );
            }
          },
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [api, connectStream, stopStream, threadId],
  );

  useEffect(() => {
    if (isWebMode()) return;
    if (!merged?.attached || !merged.isOwner || merged.generation == null) {
      stopStream();
      return;
    }
    void startStream(merged.generation, false);
    return () => stopStream();
  }, [
    merged?.attached,
    merged?.isOwner,
    merged?.generation,
    startStream,
    stopStream,
  ]);

  const onError = (message: string | null) => setError(message);

  const run = async (work: () => Promise<void>) => {
    try {
      setError(null);
      await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onAttach = () => {
    if (!deviceUdid) return;
    void run(async () => {
      const lease = await api.attach({ threadId, deviceUdid });
      const next = await api.status({ threadId });
      setStatus({ ...next, generation: lease.generation, isOwner: true });
    });
  };

  const onDetach = () => {
    if (generation == null) return;
    void run(async () => {
      await api.detach({ threadId, generation });
      stopStream();
      setStatus(await api.status({ threadId }));
    });
  };

  const onTakeover = () => {
    if (!confirmTakeover) {
      setConfirmTakeover(true);
      return;
    }
    void run(async () => {
      const lease = await api.takeControl({
        threadId,
        deviceUdid: deviceUdid || undefined,
        confirmed: true,
      });
      setConfirmTakeover(false);
      const next = await api.status({ threadId });
      setStatus({ ...next, generation: lease.generation, isOwner: true });
    });
  };

  const onReconnect = () => {
    if (generation == null) return;
    void run(async () => {
      await startStream(generation, true);
    });
  };

  const onInput = (input: SimulatorInput) => {
    if (generation == null) return;
    void api
      .sendInput({ threadId, generation, input })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };

  if (isWebMode()) {
    return (
      <div className={styles.pane} data-simulator-pane="">
        <p className={styles.webHidden} data-simulator-web-hidden="">
          iOS Simulator is available in the desktop app.
        </p>
      </div>
    );
  }

  const checks = caps
    ? [
        {
          id: "platform",
          ok: caps.supported,
          label: caps.supported
            ? `Host: ${caps.platform}`
            : `Unsupported platform (${caps.platform})`,
        },
        {
          id: "xcode",
          ok: Boolean(caps.xcode.version && caps.xcode.version !== "0"),
          label:
            caps.xcode.version && caps.xcode.version !== "0"
              ? `Xcode ${caps.xcode.version} (${caps.xcode.build})`
              : "Xcode not found",
        },
        {
          id: "license",
          ok: caps.licenseAccepted,
          label: caps.licenseAccepted
            ? "Xcode license accepted"
            : "Xcode license required",
        },
        {
          id: "runtime",
          ok: caps.runtimes.some((runtime) => runtime.devices.length > 0),
          label: caps.runtimes.some((runtime) => runtime.devices.length > 0)
            ? `${caps.runtimes.length} simulator runtime(s)`
            : "No simulator runtimes",
        },
      ]
    : [];

  const attached = Boolean(merged?.attached);
  const isOwner = Boolean(merged?.isOwner);
  const streamDisconnected =
    attached && isOwner && merged?.stream === "disconnected";

  return (
    <div className={styles.pane} data-simulator-pane="">
      <div className={styles.toolbar}>
        <select
          className={styles.select}
          data-simulator-devices=""
          aria-label="Simulator device"
          value={deviceUdid}
          disabled={attached && isOwner}
          onChange={(e) => setDeviceUdid(e.target.value)}
        >
          {devices.length === 0 ? (
            <option value="">No devices</option>
          ) : (
            devices.map((device) => (
              <option key={device.udid} value={device.udid}>
                {device.name} ({device.state})
              </option>
            ))
          )}
        </select>
        {attached && isOwner ? (
          <button
            type="button"
            className={styles.btn}
            data-simulator-detach=""
            onClick={onDetach}
          >
            Detach
          </button>
        ) : attached ? null : (
          <button
            type="button"
            className={styles.btn + " " + styles.primary}
            data-simulator-attach=""
            disabled={!caps?.supported || !deviceUdid}
            onClick={onAttach}
          >
            Attach
          </button>
        )}
        {streamDisconnected ? (
          <button
            type="button"
            className={styles.btn}
            data-simulator-reconnect=""
            onClick={onReconnect}
          >
            Reconnect
          </button>
        ) : null}
      </div>

      {error ? (
        <div className={styles.error} data-simulator-error="">
          {error}
        </div>
      ) : null}

      {caps && !caps.supported ? (
        <p className={styles.message} data-simulator-unsupported="">
          iOS Simulator requires macOS with full Xcode ({caps.platform}).
        </p>
      ) : null}

      {caps ? (
        <div className={styles.checklist} data-simulator-checklist="">
          {checks.map((item) => (
            <div
              key={item.id}
              className={styles.check}
              data-simulator-check={item.id}
              data-ok={item.ok ? "true" : "false"}
            >
              {item.ok ? "✓" : "✕"} {item.label}
            </div>
          ))}
        </div>
      ) : null}

      {attached && !isOwner ? (
        <div className={styles.busy} data-simulator-busy="">
          <p>Simulator is controlled by another thread.</p>
          <button
            type="button"
            className={styles.btn}
            data-simulator-takeover=""
            onClick={onTakeover}
          >
            Take control
          </button>
          {confirmTakeover ? (
            <button
              type="button"
              className={styles.btn + " " + styles.primary}
              data-simulator-takeover-confirm=""
              onClick={onTakeover}
            >
              Confirm takeover
            </button>
          ) : null}
        </div>
      ) : null}

      {attached && isOwner ? (
        <>
          <div className={styles.stage}>
            <SimulatorCanvas
              ref={canvasRef}
              generation={generation}
              streamGeneration={streamGeneration}
              dimensions={dimensions}
              onInput={onInput}
            />
          </div>
          <SimulatorControls
            threadId={threadId}
            generation={generation}
            api={api}
            status={merged}
            capabilities={caps}
            onError={onError}
          />
        </>
      ) : null}
    </div>
  );
}
