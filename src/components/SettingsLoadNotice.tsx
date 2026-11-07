import styles from "./SettingsLoadNotice.module.css";

export function SettingsLoadNotice({
  error,
  loading,
  onRetry,
}: {
  error: string | null;
  loading: boolean;
  onRetry?: () => Promise<void>;
}) {
  return (
    <div className={styles.notice} role={error && !loading ? "alert" : "status"} data-settings-load="">
      <div>
        <strong>{error ? "Could not load settings." : "Loading settings…"}</strong>
        <span> Settings changes are unavailable until loading succeeds.</span>
        {error && <p className={styles.detail}>{error}</p>}
      </div>
      {error && onRetry && (
        <button type="button" disabled={loading} onClick={() => void onRetry()}>
          {loading ? "Retrying…" : "Retry"}
        </button>
      )}
    </div>
  );
}
