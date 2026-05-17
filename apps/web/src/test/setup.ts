import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// supabase-js validates the URL + anon key at module import. Test files
// that import pages whose lib chain transitively touches `supabase` (via
// useRealtimeInvalidate, api.ts, etc.) would otherwise crash at setup
// under happy-dom with "supabaseUrl is required". Provide dummies so
// the client constructs successfully; individual specs still mock
// `@/lib/api` for the calls they care about.
if (!import.meta.env.VITE_SUPABASE_URL) {
  (import.meta.env as Record<string, string>).VITE_SUPABASE_URL = 'http://localhost:54321';
}
if (!import.meta.env.VITE_SUPABASE_ANON_KEY) {
  (import.meta.env as Record<string, string>).VITE_SUPABASE_ANON_KEY = 'test-anon-key';
}

// happy-dom doesn't ship browser dialog primitives. Provide writable
// defaults so production code that uses them never throws under test;
// individual specs can stub them via vi.stubGlobal / direct assignment.
if (typeof globalThis.confirm !== 'function') {
  Object.defineProperty(globalThis, 'confirm', {
    value: vi.fn().mockReturnValue(true),
    writable: true,
    configurable: true,
  });
}
if (typeof globalThis.alert !== 'function') {
  Object.defineProperty(globalThis, 'alert', {
    value: vi.fn(),
    writable: true,
    configurable: true,
  });
}

afterEach(() => {
  cleanup();
});
