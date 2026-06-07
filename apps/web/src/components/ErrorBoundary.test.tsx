import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ErrorBoundary } from './ErrorBoundary';

function Boom({ message }: { message: string }): never {
  throw new Error(message);
}

describe('ErrorBoundary', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('renders children unchanged when no error is thrown', () => {
    render(
      <ErrorBoundary>
        <p>healthy content</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('healthy content')).toBeInTheDocument();
  });

  it('renders the fallback panel when a child component throws', () => {
    render(
      <ErrorBoundary>
        <Boom message="something exploded" />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('heading')).toHaveTextContent('שגיאה בלתי צפויה');
    expect(screen.getByText('something exploded')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'טעינה מחדש' })).toBeInTheDocument();
  });

  it('logs the caught error to console.error with the [ui-error] tag', () => {
    render(
      <ErrorBoundary>
        <Boom message="logged failure" />
      </ErrorBoundary>,
    );
    const tagged = consoleSpy.mock.calls.some(
      (args: unknown[]) =>
        args[0] === '[ui-error]' && args[1] instanceof Error && args[1].message === 'logged failure',
    );
    expect(tagged).toBe(true);
  });
});
