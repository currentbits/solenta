import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ThreadInfo,
  ThreadSearchInput,
  ThreadSearchResult,
} from "../../shared/ipc";

const SEARCH_DEBOUNCE_MS = 250;
const MIN_SEARCH_LEN = 2;

/** What the current searchResults answer: query, scope, and whether capped. */
interface Fetched {
  query: string;
  scopeKey: string | null;
  truncated: boolean;
}

/**
 * Debounced full-content search. Queries under MIN_SEARCH_LEN stay local;
 * longer ones call searchThreads after SEARCH_DEBOUNCE_MS. scopeIds (the
 * threads passing the sidebar filters, null when none are on) ride along so
 * the backend applies them before its result cap (#1201). A newer query or
 * scope (searchGen) or an unmount drops a stale reply.
 */
export function useThreadSearch({
  query,
  scopeIds,
  searchThreads,
}: {
  query: string;
  scopeIds: readonly string[] | null;
  searchThreads: (input: ThreadSearchInput) => Promise<ThreadSearchResult>;
}) {
  const trimmedQuery = query.trim();
  const searching = trimmedQuery.length >= MIN_SEARCH_LEN;
  const [searchResults, setSearchResults] = useState<ThreadInfo[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const searchGen = useRef(0);
  const fetched = useRef<Fetched | null>(null);
  const scopeRef = useRef(scopeIds);
  scopeRef.current = scopeIds;
  const scopeKey = useMemo(
    () => (scopeIds == null ? null : scopeIds.join("\n")),
    [scopeIds],
  );

  useEffect(
    () => () => {
      searchGen.current += 1;
    },
    [],
  );

  useEffect(() => {
    if (!searching) {
      searchGen.current += 1;
      fetched.current = null;
      setSearchResults(null);
      setSearchLoading(false);
      setSearchFailed(false);
      setSearchTruncated(false);
      return;
    }
    const f = fetched.current;
    // An uncapped unscoped reply already holds every match, so the sidebar's
    // own filter pass is exact and a filter switch needs no rescan (#553).
    if (
      f &&
      f.query === trimmedQuery &&
      (f.scopeKey === scopeKey || (f.scopeKey === null && !f.truncated))
    ) {
      searchGen.current += 1;
      setSearchLoading(false);
      return;
    }
    const gen = ++searchGen.current;
    setSearchLoading(true);
    const handle = window.setTimeout(() => {
      const ids = scopeRef.current;
      const input: ThreadSearchInput =
        ids == null
          ? { query: trimmedQuery }
          : { query: trimmedQuery, threadIds: [...ids] };
      searchThreads(input)
        .then(
          (res) => {
            if (searchGen.current !== gen) return;
            fetched.current = {
              query: trimmedQuery,
              scopeKey,
              truncated: res.truncated,
            };
            setSearchResults(res.threads);
            setSearchTruncated(res.truncated);
            setSearchFailed(false);
          },
          () => {
            if (searchGen.current !== gen) return;
            fetched.current = null;
            setSearchResults([]);
            setSearchTruncated(false);
            setSearchFailed(true);
          },
        )
        .finally(() => {
          if (searchGen.current === gen) setSearchLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [trimmedQuery, searching, scopeKey, searchThreads]);

  return {
    trimmedQuery,
    searching,
    searchResults,
    searchLoading,
    searchFailed,
    searchTruncated,
  };
}
