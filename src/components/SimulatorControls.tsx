import { useEffect, useState, type FormEvent } from "react";
import type {
  CoderApi,
  SimulatorAccessibilityNode,
  SimulatorCapabilitySnapshot,
  SimulatorHardwareButton,
  SimulatorStatus,
} from "../shared/ipc";
import styles from "./SimulatorPane.module.css";

const HARDWARE: Array<{ id: SimulatorHardwareButton; label: string }> = [
  { id: "home", label: "Home" },
  { id: "lock", label: "Lock" },
  { id: "volumeUp", label: "Vol +" },
  { id: "volumeDown", label: "Vol −" },
  { id: "action", label: "Action" },
  { id: "shake", label: "Shake" },
];

export function formatElapsed(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

function AxNode({ node }: { node: SimulatorAccessibilityNode }) {
  return (
    <li>
      <span>
        {node.role ?? "node"}
        {node.label ? ` ${node.label}` : ""}
        {node.identifier ? ` (${node.identifier})` : ""}
      </span>
      {node.children.length > 0 ? (
        <ul>
          {node.children.map((child, i) => (
            <AxNode key={`${child.identifier ?? child.role ?? "n"}-${i}`} node={child} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function SimulatorControls({
  threadId,
  generation,
  api,
  status,
  capabilities,
  disabled,
  onError,
}: {
  threadId: string;
  generation: number | null;
  api: CoderApi["simulator"];
  status: SimulatorStatus | null;
  capabilities: SimulatorCapabilitySnapshot | null;
  disabled?: boolean;
  onError: (message: string | null) => void;
}) {
  const [appPath, setAppPath] = useState("");
  const [bundleId, setBundleId] = useState("");
  const [url, setUrl] = useState("");
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [tree, setTree] = useState<SimulatorAccessibilityNode | null>(null);
  const locked = disabled || generation == null || !status?.isOwner;

  useEffect(() => {
    if (startedAt == null) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);

  const run = async (work: () => Promise<void>) => {
    try {
      onError(null);
      await work();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  const onHardware = (button: SimulatorHardwareButton) => {
    if (locked || generation == null) return;
    void run(async () => {
      await api.sendInput({
        threadId,
        generation,
        input: { kind: "button", button },
      });
    });
  };

  const onInstall = (event: FormEvent) => {
    event.preventDefault();
    if (locked || generation == null || !appPath.trim()) return;
    void run(async () => {
      const result = await api.install({
        threadId,
        generation,
        relativeAppPath: appPath.trim(),
      });
      if (result.bundleId) setBundleId(result.bundleId);
    });
  };

  const onLaunch = (event: FormEvent) => {
    event.preventDefault();
    if (locked || generation == null || !bundleId.trim()) return;
    void run(async () => {
      await api.launch({ threadId, generation, bundleId: bundleId.trim() });
    });
  };

  const onOpenUrl = (event: FormEvent) => {
    event.preventDefault();
    if (locked || generation == null || !url.trim()) return;
    void run(async () => {
      await api.openUrl({ threadId, generation, url: url.trim() });
    });
  };

  const onScreenshot = () => {
    if (locked || generation == null) return;
    void run(async () => {
      await api.screenshot({ threadId, generation });
    });
  };

  const onRecord = () => {
    if (locked || generation == null) return;
    void run(async () => {
      if (recordingId) {
        await api.stopRecording({ threadId, generation, recordingId });
        setRecordingId(null);
        setStartedAt(null);
        return;
      }
      const started = await api.startRecording({ threadId, generation });
      setRecordingId(started.recordingId);
      setStartedAt(started.startedAt);
      setNow(Date.now());
    });
  };

  const onAx = () => {
    if (locked || generation == null) return;
    void run(async () => {
      const result = await api.accessibility({ threadId, generation });
      setTree(result.tree);
    });
  };

  return (
    <div className={styles.controls} data-simulator-controls="">
      {capabilities?.capabilities.hardwareButtons ? (
        <div className={styles.row}>
          {HARDWARE.map((btn) => (
            <button
              key={btn.id}
              type="button"
              className={styles.btn}
              data-simulator-button={btn.id}
              disabled={locked}
              onClick={() => onHardware(btn.id)}
            >
              {btn.label}
            </button>
          ))}
        </div>
      ) : null}

      <form className={styles.row} onSubmit={onInstall}>
        <input
          className={styles.field}
          data-simulator-install-path=""
          placeholder="Relative .app path"
          value={appPath}
          disabled={locked}
          onChange={(e) => setAppPath(e.target.value)}
        />
        <button
          type="submit"
          className={styles.btn}
          data-simulator-install=""
          disabled={locked}
        >
          Install
        </button>
      </form>

      <form className={styles.row} onSubmit={onLaunch}>
        <input
          className={styles.field}
          data-simulator-launch-id=""
          placeholder="Bundle identifier"
          value={bundleId}
          disabled={locked}
          onChange={(e) => setBundleId(e.target.value)}
        />
        <button
          type="submit"
          className={styles.btn}
          data-simulator-launch=""
          disabled={locked}
        >
          Launch
        </button>
      </form>

      <form className={styles.row} onSubmit={onOpenUrl}>
        <input
          className={styles.field}
          data-simulator-url-input=""
          placeholder="URL"
          value={url}
          disabled={locked}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button
          type="submit"
          className={styles.btn}
          data-simulator-url=""
          disabled={locked}
        >
          Open URL
        </button>
      </form>

      <div className={styles.row}>
        <button
          type="button"
          className={styles.btn}
          data-simulator-screenshot=""
          disabled={locked || !capabilities?.capabilities.screenshot}
          onClick={onScreenshot}
        >
          Screenshot
        </button>
        <button
          type="button"
          className={styles.btn}
          data-simulator-record=""
          disabled={locked || !capabilities?.capabilities.recording}
          onClick={onRecord}
        >
          {recordingId ? "Stop recording" : "Record"}
        </button>
        {startedAt != null ? (
          <span className={styles.elapsed} data-simulator-record-elapsed="">
            {formatElapsed(startedAt, now)}
          </span>
        ) : null}
        <button
          type="button"
          className={styles.btn}
          data-simulator-ax=""
          disabled={locked || !capabilities?.capabilities.accessibility}
          onClick={onAx}
        >
          Accessibility
        </button>
      </div>

      {tree ? (
        <ul className={styles.axTree} data-simulator-ax-tree="">
          <AxNode node={tree} />
        </ul>
      ) : null}
    </div>
  );
}
