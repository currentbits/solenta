import {
  useCallback,
  useEffect,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { ThreadInfo } from "../../shared/ipc";

const SEARCH_DEBOUNCE_MS = 250;
const MIN_SEARCH_LEN = 2;

/**
 * Debounced full-content search. Queries under MIN_SEARCH_LEN stay local;
 * longer ones call searchThreads after SEARCH_DEBOUNCE_MS, and a newer query
 * (searchGen) or an unmount (mountedRef) drops a stale reply.
 */
export function useThreadSearch({
  query,
  searchThreads,
  searchGen,
  mountedRef,
  setSearchResults,
  setSearchLoading,
}: {
  query: string;
  searchThreads: (input: { query: string }) => Promise<ThreadInfo[]>;
  searchGen: MutableRefObject<number>;
  mountedRef: MutableRefObject<boolean>;
  setSearchResults: Dispatch<SetStateAction<ThreadInfo[] | null>>;
  setSearchLoading: Dispatch<SetStateAction<boolean>>;
}) {
  const trimmedQuery = query.trim();
  const searching = trimmedQuery.length >= MIN_SEARCH_LEN;

  const runSearch = useCallback(
    async (q: string) => {
      const gen = ++searchGen.current;
      setSearchLoading(true);
      try {
        const list = await searchThreads({ query: q });
        if (!mountedRef.current || searchGen.current !== gen) return;
        setSearchResults(list);
      } catch {
        if (!mountedRef.current || searchGen.current !== gen) return;
        setSearchResults([]);
      } finally {
        if (mountedRef.current && searchGen.current === gen) {
          setSearchLoading(false);
        }
      }
    },
    [searchThreads],
  );

  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_SEARCH_LEN) {
      searchGen.current += 1;
      setSearchResults(null);
      setSearchLoading(false);
      return;
    }

    const handle = window.setTimeout(() => {
      void runSearch(q);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [query, runSearch]);
  return { trimmedQuery, searching };
}
