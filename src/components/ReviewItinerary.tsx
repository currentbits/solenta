/**
 * Ordered review plan above an agent diff (issue #421).
 */
import type {
  ReviewAnnotation,
  ReviewItinerary,
  ReviewReuseHit,
} from "../reviewItinerary";
import { annotationForArea } from "../reviewItinerary";
import styles from "./ReviewItinerary.module.css";

export function ReviewItineraryView({
  itinerary,
  testsFirst,
  onToggleTestsFirst,
}: {
  itinerary: ReviewItinerary;
  testsFirst: boolean;
  onToggleTestsFirst: () => void;
}) {
  const annotation = itinerary.annotation;
  const show =
    itinerary.hardStop ||
    itinerary.reuseHits.length > 0 ||
    itinerary.mismatches.length > 0 ||
    itinerary.chunks.length > 0 ||
    annotation;
  if (!show) return null;

  return (
    <div className={styles.wrap} data-review-itinerary="">
      <div className={styles.head}>
        <span className={styles.title}>Review itinerary</span>
        <button
          type="button"
          className={styles.toggle}
          data-review-tests-first={testsFirst ? "on" : "off"}
          aria-pressed={testsFirst}
          title="Read tests before implementation"
          onClick={onToggleTestsFirst}
        >
          Tests first
        </button>
      </div>

      {itinerary.hardStop && (
        <div
          className={styles.hardStop}
          role="alert"
          data-review-hard-stop=""
        >
          <strong>Hard stop — CI / config</strong>
          <span>{itinerary.hardStop.reason}</span>
          <span className={styles.paths}>
            {itinerary.hardStop.files.join(" · ")}
          </span>
        </div>
      )}

      {itinerary.mismatches.map((m) => (
        <div
          key={m.label}
          className={styles.mismatch}
          data-review-mismatch=""
        >
          {m.label}
        </div>
      ))}

      {itinerary.reuseHits.length > 0 && (
        <ReuseBlock hits={itinerary.reuseHits} />
      )}

      {annotation && <AnnotationBlock annotation={annotation} />}

      <ol className={styles.steps} data-review-steps="">
        {itinerary.steps.map((step, i) => (
          <li key={step.id} data-review-step={step.id}>
            <span className={styles.stepN}>{i + 1}</span>
            <span className={styles.stepTitle}>{step.title}</span>
            <span className={styles.stepDetail}>{step.detail}</span>
          </li>
        ))}
      </ol>

      {itinerary.newHunkCount + itinerary.acceptedHunkCount > 0 && (
        <p className={styles.hunkMeta} data-review-hunk-meta="">
          {itinerary.newHunkCount} new hunk
          {itinerary.newHunkCount === 1 ? "" : "s"}
          {itinerary.acceptedHunkCount > 0
            ? ` · ${itinerary.acceptedHunkCount} already reviewed`
            : ""}
        </p>
      )}
    </div>
  );
}

function ReuseBlock({ hits }: { hits: ReviewReuseHit[] }) {
  return (
    <div className={styles.reuse} data-review-reuse="">
      <strong>Reuse scan</strong>
      <ul>
        {hits.slice(0, 8).map((hit) => (
          <li key={`${hit.reason}:${hit.name}:${hit.addedIn}`}>
            <code>{hit.name}</code>
            {hit.reason === "existing"
              ? " already lives in "
              : " is also added in "}
            <code>{hit.existingPath}</code>
          </li>
        ))}
      </ul>
      {hits.length > 8 && (
        <p className={styles.more}>+{hits.length - 8} more</p>
      )}
    </div>
  );
}

function AnnotationBlock({ annotation }: { annotation: ReviewAnnotation }) {
  return (
    <div className={styles.annotation} data-review-annotation="">
      <strong>Author notes</strong>
      {annotation.readOrder.length > 0 && (
        <p className={styles.readOrder}>
          Read {annotation.readOrder.join(" → ")}
        </p>
      )}
      {annotation.risks.length > 0 && (
        <ul className={styles.risks}>
          {annotation.risks.map((risk) => (
            <li key={risk}>{risk}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ChunkRationale({
  itinerary,
  area,
}: {
  itinerary: ReviewItinerary;
  area: string;
}) {
  const note = annotationForArea(itinerary.annotation, area);
  const chunk = itinerary.chunks.find((c) => c.area === area);
  if (!chunk && !note) return null;
  return (
    <div className={styles.chunkHead} data-review-chunk={area}>
      <span className={styles.chunkTitle}>
        {chunk?.title || area}
      </span>
      <span className={styles.chunkWhy}>
        {note?.rationale || chunk?.rationale}
      </span>
      {note && note.risks.length > 0 && (
        <span className={styles.chunkRisk}>{note.risks.join(" · ")}</span>
      )}
    </div>
  );
}
