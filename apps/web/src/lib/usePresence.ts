import { useEffect, useRef, useState } from 'react';

/**
 * Mount/unmount lifecycle for a layer that animates in and out.
 *
 * A layer rendered with `{open ? <panel/> : null}` can never animate: on
 * open it is already at its final state when it first paints, and on
 * close it is gone before any exit can run. usePresence keeps the node
 * mounted for `exitMs` after `open` flips to false, and reports a state
 * flag the markup maps to CSS (`data-state="open" | "closed"`).
 *
 * The entry sequence deliberately paints one frame in the closed state
 * first — without it the browser coalesces mount + final state into a
 * single style computation and the transition never starts.
 *
 * Reversibility comes for free: the two states are plain CSS transitions,
 * so re-opening mid-exit retargets from the current on-screen value
 * instead of jumping.
 *
 * When the user prefers reduced motion there is nothing to wait for, so
 * mount and unmount are immediate.
 */
export function usePresence(open: boolean, options: { exitMs?: number } = {}) {
  const exitMs = options.exitMs ?? 150;
  const [mounted, setMounted] = useState(open);
  // Always start closed, even when the caller mounts already-open: many
  // layers are rendered conditionally by their parent ({editing ? <M/> :
  // null}), and starting at the final value would skip the entry.
  const [state, setState] = useState<'open' | 'closed'>('closed');
  const timerRef = useRef<number | null>(null);
  // Held as a closure rather than a raw id so the frame is always
  // cancelled through the same binding that scheduled it.
  const cancelFrameRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const clearPending = () => {
      if (timerRef.current !== null) { window.clearTimeout(timerRef.current); timerRef.current = null; }
      if (cancelFrameRef.current) { cancelFrameRef.current(); cancelFrameRef.current = null; }
    };
    clearPending();

    if (open) {
      setMounted(true);
      if (prefersReducedMotion()) {
        setState('open');
        return;
      }
      // Paint once closed, then flip — this is what gives the transition
      // a start value to animate from.
      const raf = requestAnimationFrame;
      const cancel = cancelAnimationFrame;
      const outer = raf(() => {
        const inner = raf(() => setState('open'));
        cancelFrameRef.current = () => cancel(inner);
      });
      cancelFrameRef.current = () => cancel(outer);
      return clearPending;
    }

    setState('closed');
    if (prefersReducedMotion()) {
      setMounted(false);
      return;
    }
    timerRef.current = window.setTimeout(() => setMounted(false), exitMs);
    return clearPending;
  }, [open, exitMs]);

  return { mounted, state };
}

// Environments without a media-query engine are treated as reduced
// motion — there is no compositor to animate on anyway.
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return true;
  }
}
