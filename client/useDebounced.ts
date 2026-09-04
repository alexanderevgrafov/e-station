import { useEffect, useRef } from 'react';

// Fields commit as you type rather than on blur, so the preview follows the
// keystrokes. Each commit is a server write plus a PNG re-render, though, so
// they are coalesced: typing "120" fires once, not three times.
export function useDebounced<A extends unknown[]>(fn: (...args: A) => void, delay = 220): (...args: A) => void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Kept in a ref so the returned function is stable across renders while
  // still calling the latest closure - otherwise every render would reset the
  // pending timer and nothing would ever fire.
  const latest = useRef(fn);
  latest.current = fn;

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return (...args: A) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => latest.current(...args), delay);
  };
}
