import { useCallback, useState } from "react";
import type { RunArtifactInfo } from "../shared/ipc";
import type { ArtifactGroup } from "../timeline";
import {
  artifactDurationLabel,
  artifactRunLabel,
  artifactSourceLabel,
  formatArtifactTimestamp,
  resolvePosterArtifact,
  runArtifactMediaUrl,
} from "../runArtifacts";
import styles from "./RunArtifacts.module.css";

function ArtifactMedia({
  threadId,
  artifact,
  allArtifacts,
}: {
  threadId: string;
  artifact: RunArtifactInfo;
  allArtifacts: RunArtifactInfo[];
}) {
  const [unavailable, setUnavailable] = useState(false);
  const mediaUrl = runArtifactMediaUrl(threadId, artifact.id);
  const onMediaError = useCallback(() => setUnavailable(true), []);
  const duration = artifactDurationLabel(artifact.durationMs);
  const poster = resolvePosterArtifact(artifact, allArtifacts);
  const posterUrl = poster
    ? runArtifactMediaUrl(threadId, poster.id)
    : undefined;

  return (
    <article className={styles.item} data-run-artifact={artifact.id}>
      <header className={styles.meta}>
        <span className={styles.name}>{artifact.name}</span>
        <span className={styles.source}>{artifactSourceLabel(artifact.source)}</span>
        <span className={styles.run}>{artifactRunLabel(artifact)}</span>
        {duration && (
          <span className={styles.duration} aria-label={`Duration ${duration}`}>
            {duration}
          </span>
        )}
        <time className={styles.time} dateTime={artifact.createdAt}>
          {formatArtifactTimestamp(artifact.createdAt)}
        </time>
      </header>

      {unavailable ? (
        <div className={styles.unavailable} data-artifact-unavailable="">
          Media unavailable
        </div>
      ) : artifact.kind === "video" ? (
        <div className={styles.mediaWrap}>
          <video
            className={styles.video}
            controls
            preload="metadata"
            src={mediaUrl}
            poster={posterUrl}
            aria-label={artifact.name}
            onError={onMediaError}
          />
          <a
            className={styles.download}
            href={mediaUrl}
            download={artifact.name}
            aria-label={`Download ${artifact.name}`}
          >
            Download
          </a>
        </div>
      ) : (
        <img
          className={styles.image}
          src={mediaUrl}
          alt={artifact.name}
          onError={onMediaError}
        />
      )}
    </article>
  );
}

export function RunArtifacts({
  threadId,
  group,
  allArtifacts,
  animateIn,
}: {
  threadId: string;
  group: ArtifactGroup;
  allArtifacts: RunArtifactInfo[];
  /** Freshly appended at the live tail — play the stream-in entrance. */
  animateIn?: boolean;
}) {
  const [entered] = useState(Boolean(animateIn));

  return (
    <section
      className={`${styles.group}${entered ? ` ${styles.streamIn}` : ""}`}
      data-stream-in={entered ? "" : undefined}
      data-run-artifacts=""
      aria-label="Run artifacts"
    >
      {group.artifacts.map((artifact) => (
        <ArtifactMedia
          key={artifact.id}
          threadId={threadId}
          artifact={artifact}
          allArtifacts={allArtifacts}
        />
      ))}
    </section>
  );
}
