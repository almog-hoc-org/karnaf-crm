import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components/Toast';
import { SettingsPage } from './SettingsPage';

vi.mock('@/lib/api', () => ({
  fetchRuntimeConfig: vi.fn(),
  postUpdateActiveHours: vi.fn(),
  postUpdateFollowUpDelays: vi.fn(),
  postUpdateForbiddenClaims: vi.fn(),
  postUpdateSafetyNet: vi.fn(),
  postUpdateSlaThresholds: vi.fn(),
  postUpdateEmailChannel: vi.fn(),
}));

import { fetchRuntimeConfig, postUpdateEmailChannel } from '@/lib/api';

function makeConfig(emailChannel: Record<string, unknown>) {
  return {
    ok: true as const,
    activeHours: { start: '09:00', end: '21:00', timezone: 'Asia/Jerusalem', workingDays: [0, 1, 2, 3, 4] },
    whatsappSession: { windowHours: 24, templates: [] },
    followUpDelays: { firstResponseMinutes: 30, nurtureHours: 24, paymentPendingHours: 12 },
    slaThresholds: {
      firstResponseWarnHours: 8, firstResponseHighWarnHours: 10,
      firstResponseBreachHours: 12, paymentPendingHours: 24,
    },
    forbiddenClaims: ['תשואה מובטחת'],
    safetyNet: { enabled: false, ackText: 'קיבלנו', oncePerHours: 6 },
    emailChannel: emailChannel,
  };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <SettingsPage />
        </ToastProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('SettingsPage — email channel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('warns that Resend cannot send from a gmail address', async () => {
    vi.mocked(fetchRuntimeConfig).mockResolvedValue(makeConfig({
      provider: 'resend', fromName: 'קרנף נדל"ן', fromEmail: 'karnaf.yazamut@gmail.com',
      replyTo: '', requireConsent: true,
    }) as never);

    renderPage();

    expect(await screen.findByText(/תיבת דואר ציבורית/)).toBeInTheDocument();
  });

  it('saves a verified-domain sender and drops the warning', async () => {
    vi.mocked(fetchRuntimeConfig).mockResolvedValue(makeConfig({
      provider: 'resend', fromName: 'קרנף נדל"ן', fromEmail: 'hi@karnaf.co.il',
      replyTo: 'karnaf.yazamut@gmail.com', requireConsent: true,
    }) as never);
    vi.mocked(postUpdateEmailChannel).mockResolvedValue({ ok: true } as never);

    renderPage();

    const sender = await screen.findByDisplayValue('hi@karnaf.co.il');
    expect(screen.queryByText(/תיבת דואר ציבורית/)).not.toBeInTheDocument();

    fireEvent.change(sender, { target: { value: 'news@karnaf.co.il' } });
    // Several cards share the "שמירה" label — submit the one holding this field.
    const emailForm = sender.closest('form');
    expect(emailForm).not.toBeNull();
    fireEvent.submit(emailForm as HTMLFormElement);

    await waitFor(() => expect(postUpdateEmailChannel).toHaveBeenCalled());
    expect(vi.mocked(postUpdateEmailChannel).mock.calls[0]?.[0]).toMatchObject({
      provider: 'resend',
      fromEmail: 'news@karnaf.co.il',
      replyTo: 'karnaf.yazamut@gmail.com',
      requireConsent: true,
    });
  });
});
