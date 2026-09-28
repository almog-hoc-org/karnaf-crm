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
  fetchEmailChannelStatus: vi.fn(),
  postEmailTestSend: vi.fn(),
}));

import { fetchEmailChannelStatus, fetchRuntimeConfig, postEmailTestSend, postUpdateEmailChannel } from '@/lib/api';

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
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchEmailChannelStatus).mockResolvedValue({
      ok: true,
      emailChannel: {} as never,
      readyToSend: false,
      preflight: { ok: false, code: 'resend_domain_not_verified', error: 'Resend לא שולח מכתובת gmail.com' },
      senderDomain: 'gmail.com',
      domains: [],
      domainsError: null,
      suggestedFromEmail: null,
    });
  });

  it('shows the verified Resend domain, offers an address on it, and sends a test to me', async () => {
    vi.mocked(fetchRuntimeConfig).mockResolvedValue(makeConfig({
      provider: 'resend', fromName: 'קרנף נדל"ן', fromEmail: 'karnaf.yazamut@gmail.com',
      replyTo: 'karnaf.yazamut@gmail.com', requireConsent: true,
    }) as never);
    vi.mocked(fetchEmailChannelStatus).mockResolvedValue({
      ok: true,
      emailChannel: {} as never,
      readyToSend: true,
      preflight: { ok: true },
      senderDomain: 'karnafnadlan.com',
      domains: [{ name: 'karnafnadlan.com', status: 'verified' }],
      domainsError: null,
      suggestedFromEmail: 'info@karnafnadlan.com',
    });
    vi.mocked(postEmailTestSend).mockResolvedValue({ ok: true, to: 'owner@x.com', id: 'e1', subject: 's' });

    renderPage();

    expect(await screen.findByText(/מוכן לשליחה/)).toBeInTheDocument();
    expect(screen.getByText(/karnafnadlan\.com — מאומת/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'להשתמש ב-info@karnafnadlan.com' }));
    expect(screen.getByDisplayValue('info@karnafnadlan.com')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'שלח לי מייל בדיקה' }));
    await waitFor(() => expect(postEmailTestSend).toHaveBeenCalled());
  });

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

describe('SettingsPage — load failure', () => {
  // A failed config read used to render the settings cards with no values,
  // which reads as "nothing is configured".
  it('says the load failed instead of showing empty settings', async () => {
    vi.mocked(fetchRuntimeConfig).mockRejectedValue(new Error('gateway 502'));
    renderPage();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('לא הצלחנו לטעון את הנתונים');
    expect(alert).toHaveTextContent('gateway 502');
    expect(alert).toHaveTextContent('שום דבר לא נמחק');
  });
});
