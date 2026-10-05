import { lazy, type ComponentType } from "react";

const loaders: Array<() => Promise<unknown>> = [];

/**
 * React.lazy for a named export. Once its chunk has loaded it renders the
 * component directly, so a preloaded view never suspends (#1475 finding 7).
 */
export function lazyNamed<P extends object>(
  load: () => Promise<ComponentType<P>>,
): ComponentType<P> {
  let loaded: ComponentType<P> | null = null;
  let pending: Promise<ComponentType<P>> | null = null;
  const preload = () =>
    (pending ??= load().then((c) => {
      loaded = c;
      return c;
    }));
  const Lazy = lazy(() => preload().then((c) => ({ default: c })));
  loaders.push(preload);
  function LazyNamed(props: P) {
    // React reconciles a resolved lazy against its loaded type, so this swap
    // keeps state (pinned by test/lazyNamed.test.tsx).
    const C = loaded ?? (Lazy as unknown as ComponentType<P>);
    return <C {...props} />;
  }
  return LazyNamed;
}

/** Loads every lazyNamed chunk registered so far. Tests call this before mounting. */
export function preloadLazyNamed(): Promise<unknown> {
  return Promise.all(loaders.map((l) => l()));
}
