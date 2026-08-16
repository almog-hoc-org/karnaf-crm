import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePresence } from './usePresence';

// The suite runs as a reduced-motion environment (see test/setup.ts);
// these specs opt back into motion to exercise the real timing, and
// reset to reduced before each one so the override never leaks.
function setReducedMotion(reduced: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true, configurable: true,
    value: (query: string) => ({
      matches: reduced && query.includes('prefers-reduced-motion'),
      media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    }),
  });
}
const withMotion = () => setReducedMotion(false);

describe('usePresence', () => {
  beforeEach(() => {
    setReducedMotion(true);
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 16));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('mounts closed first so the entry transition has a start value', () => {
    withMotion();
    const { result } = renderHook(() => usePresence(true));
    expect(result.current.mounted).toBe(true);
    expect(result.current.state).toBe('closed');

    act(() => { vi.advanceTimersByTime(50); });
    expect(result.current.state).toBe('open');
  });

  it('keeps the node mounted for the exit, then removes it', () => {
    withMotion();
    const { result, rerender } = renderHook(({ open }) => usePresence(open, { exitMs: 150 }), {
      initialProps: { open: true },
    });
    act(() => { vi.advanceTimersByTime(50); });
    expect(result.current.state).toBe('open');

    rerender({ open: false });
    expect(result.current.state).toBe('closed');
    expect(result.current.mounted).toBe(true);

    act(() => { vi.advanceTimersByTime(149); });
    expect(result.current.mounted).toBe(true);

    act(() => { vi.advanceTimersByTime(2); });
    expect(result.current.mounted).toBe(false);
  });

  it('re-opening mid-exit cancels the unmount instead of tearing down', () => {
    withMotion();
    const { result, rerender } = renderHook(({ open }) => usePresence(open, { exitMs: 150 }), {
      initialProps: { open: true },
    });
    act(() => { vi.advanceTimersByTime(50); });

    rerender({ open: false });
    act(() => { vi.advanceTimersByTime(80) });
    rerender({ open: true });
    act(() => { vi.advanceTimersByTime(200); });

    expect(result.current.mounted).toBe(true);
    expect(result.current.state).toBe('open');
  });

  it('skips the wait entirely under reduced motion', () => {
    const { result, rerender } = renderHook(({ open }) => usePresence(open), {
      initialProps: { open: true },
    });
    expect(result.current.state).toBe('open');
    expect(result.current.mounted).toBe(true);

    rerender({ open: false });
    expect(result.current.mounted).toBe(false);
  });
});
