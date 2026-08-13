import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReplyComposer } from './ReplyComposer';

vi.mock('@/lib/api', () => ({
  fetchMessageTemplates: vi.fn(async () => ({ templates: [] })),
}));

function renderComposer(props: Partial<Parameters<typeof ReplyComposer>[0]> = {}) {
  const onSend = vi.fn(async () => ({}));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ReplyComposer disabled={false} sending={false} errorMessage={null} onSend={onSend} {...props} />
    </QueryClientProvider>,
  );
  return { onSend };
}

describe('ReplyComposer', () => {
  it('sends on Enter and keeps Shift+Enter as a newline', async () => {
    const { onSend } = renderComposer();
    const textarea = screen.getByPlaceholderText(/הקלד תשובה ידנית/);

    fireEvent.change(textarea, { target: { value: 'שלום' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('שלום'));
    // Draft clears after a successful send.
    await waitFor(() => expect(screen.queryByDisplayValue('שלום')).not.toBeInTheDocument());
  });

  it('keeps the draft when onSend rejects', async () => {
    const onSend = vi.fn(async () => { throw new Error('boom'); });
    renderComposer({ onSend });
    const textarea = screen.getByPlaceholderText(/הקלד תשובה ידנית/);

    fireEvent.change(textarea, { target: { value: 'טיוטה' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(screen.getByDisplayValue('טיוטה')).toBeInTheDocument();
  });

  it('warns about the 600-char template cut outside the 24h window', () => {
    // Last inbound two days ago → template mode.
    renderComposer({ lastInboundAt: new Date(Date.now() - 48 * 3600_000).toISOString() });
    const textarea = screen.getByPlaceholderText(/הקלד תשובה ידנית/);

    fireEvent.change(textarea, { target: { value: 'א'.repeat(601) } });
    expect(screen.getByText(/600 התווים הראשונים/)).toBeInTheDocument();
    expect(screen.getByText(/מחוץ לחלון 24 שעות תישלח תבנית/)).toBeInTheDocument();
  });

  it('compact mode hides the template picker but keeps the window-status line', () => {
    renderComposer({
      compact: true,
      lead: { full_name: 'דנה', phone: '050', email: null, city: null },
      lastInboundAt: new Date().toISOString(),
    });
    expect(screen.queryByRole('button', { name: '+ הכנס תבנית' })).not.toBeInTheDocument();
    expect(screen.getByText(/חלון 24 השעות פתוח/)).toBeInTheDocument();
  });
});
