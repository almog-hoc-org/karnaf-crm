import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthContext, type AuthState, type Role } from '@/auth/auth-context';
import type { LeadRow } from '@/lib/types';
import { LeadsPage } from './LeadsPage';

vi.mock('@/lib/api', () => ({
  fetchLeadsList: vi.fn(),
  fetchUsersList: vi.fn(),
  postBulkLeadAction: vi.fn(),
}));

import { fetchLeadsList, fetchUsersList, postBulkLeadAction, type LeadsListParams } from '@/lib/api';

function makeAuth(role: Role | null): AuthState {
  return {
    session: null, user: null, role, loading: false,
    signIn: async () => ({ error: null }),
    signInWithGoogle: async () => ({ error: null }),
    signUp: async () => ({ error: null, needsEmailConfirmation: true }),
    signOut: async () => {},
  } as AuthState;
}

function makeLead(over: Partial<LeadRow> = {}): LeadRow {
  return {
    id: 'lead-x',
    full_name: 'דנה כהן',
    phone: '+972500000001',
    email: 'dana@example.com',
    source: 'whatsapp',
    lead_status: 'qualified',
    lead_heat: 'hot',
    ownership_mode: 'ai_active',
    lead_score: 80,
    payment_status: null,
    last_message_at: '2026-04-28T10:00:00Z',
    last_inbound_at: '2026-04-28T09:55:00Z',
    last_outbound_at: '2026-04-28T09:50:00Z',
    do_not_contact: false,
    removed_by_request: false,
    updated_at: '2026-04-28T10:00:00Z',
    created_at: '2026-04-27T08:00:00Z',
    ...over,
  };
}

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

function renderLeads(role: Role | null = 'admin', initialEntry = '/leads') {
  return render(
    <QueryClientProvider client={makeClient()}>
      <AuthContext.Provider value={makeAuth(role)}>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Routes>
            <Route path="/leads" element={<LeadsPage />} />
            <Route path="/leads/:leadId" element={<div>lead detail</div>} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(fetchLeadsList).mockResolvedValue({
    leads: [
      makeLead({ id: 'lead-1', full_name: 'דנה כהן' }),
      makeLead({ id: 'lead-2', full_name: 'יוסי לוי', lead_heat: 'cool', lead_status: 'new' }),
    ],
    total: 2,
    limit: 50,
    offset: 0,
  });
  vi.mocked(fetchUsersList).mockResolvedValue([
    {
      id: 'user-1', email: 'mia@karnaf.co', full_name: 'מיה', role: 'mia',
      is_active: true, created_at: '', updated_at: '',
    },
    {
      id: 'user-2', email: 'sales@karnaf.co', full_name: 'רון מכירות', role: 'sales_rep',
      is_active: true, created_at: '', updated_at: '',
    },
  ]);
  vi.mocked(postBulkLeadAction).mockResolvedValue({ ok: true, updated: 2 });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('LeadsPage', () => {
  it('renders the loading skeleton while leads are being fetched', () => {
    vi.mocked(fetchLeadsList).mockImplementation(() => new Promise(() => {}));
    renderLeads();
    expect(screen.getByTestId('leads-skeleton')).toBeInTheDocument();
  });

  it('renders leads with deep links to the detail route and total count', async () => {
    renderLeads();
    expect(await screen.findByRole('link', { name: 'דנה כהן' })).toHaveAttribute('href', '/leads/lead-1');
    expect(screen.getByRole('link', { name: 'יוסי לוי' })).toHaveAttribute('href', '/leads/lead-2');
    expect(screen.getByText('סה"כ 2 לידים')).toBeInTheDocument();
  });

  it('renders the empty state when no leads match', async () => {
    vi.mocked(fetchLeadsList).mockResolvedValue({ leads: [], total: 0, limit: 50, offset: 0 });
    renderLeads();
    expect(await screen.findByText('אין לידים תואמים.')).toBeInTheDocument();
  });

  it('forwards search/status/heat filters to fetchLeadsList and resets offset', async () => {
    renderLeads();
    await screen.findByRole('link', { name: 'דנה כהן' });

    fireEvent.change(screen.getByPlaceholderText('חיפוש לפי שם / טלפון / אימייל'), { target: { value: 'דנה' } });

    await waitFor(() => {
      const lastCall = vi.mocked(fetchLeadsList).mock.calls.at(-1)?.[0] as LeadsListParams | undefined;
      expect(lastCall?.search).toBe('דנה');
      expect(lastCall?.offset).toBe(0);
    });
  });

  it('applies source filters from dashboard links', async () => {
    renderLeads('admin', '/leads?source=whatsapp');
    expect(await screen.findByText('מקור: whatsapp')).toBeInTheDocument();

    await waitFor(() => {
      const lastCall = vi.mocked(fetchLeadsList).mock.calls.at(-1)?.[0] as LeadsListParams | undefined;
      expect(lastCall?.source).toBe('whatsapp');
    });
  });

  it('disables the previous button on the first page and enables next when a full page is returned', async () => {
    const fullPage = Array.from({ length: 50 }, (_, i) => makeLead({ id: `lead-${i}`, full_name: `ליד ${i}` }));
    vi.mocked(fetchLeadsList).mockResolvedValue({ leads: fullPage, total: 120, limit: 50, offset: 0 });
    renderLeads();
    await screen.findByRole('link', { name: 'ליד 0' });
    const prev = screen.getByRole('button', { name: 'הקודם' });
    const next = screen.getByRole('button', { name: 'הבא' });
    expect(prev).toBeDisabled();
    expect(next).not.toBeDisabled();
  });

  it('advances the offset when the next button is pressed', async () => {
    const fullPage = Array.from({ length: 50 }, (_, i) => makeLead({ id: `lead-${i}`, full_name: `ליד ${i}` }));
    vi.mocked(fetchLeadsList).mockResolvedValue({ leads: fullPage, total: 120, limit: 50, offset: 0 });
    renderLeads();
    await screen.findByRole('link', { name: 'ליד 0' });
    fireEvent.click(screen.getByRole('button', { name: 'הבא' }));
    await waitFor(() => {
      const lastCall = vi.mocked(fetchLeadsList).mock.calls.at(-1)?.[0] as LeadsListParams | undefined;
      expect(lastCall?.offset).toBe(50);
    });
  });

  it('bulk-assigns selected leads to a chosen user', async () => {
    renderLeads();
    await screen.findByRole('link', { name: 'דנה כהן' });

    const checkbox = screen.getByLabelText('בחירת דנה כהן') as HTMLInputElement;
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox.checked).toBe(true));

    fireEvent.click(await screen.findByRole('button', { name: 'שיוך למשתמש' }));
    const select = await screen.findByRole('combobox', { name: 'בחר משתמש' }) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'user-1' } });
    await waitFor(() => expect(select.value).toBe('user-1'));
    const confirmBtn = screen.getByRole('button', { name: 'שייך' });
    await waitFor(() => expect(confirmBtn).not.toBeDisabled());
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(vi.mocked(postBulkLeadAction)).toHaveBeenCalled();
    });
    expect(vi.mocked(postBulkLeadAction).mock.calls[0]?.[0]).toMatchObject({
      action: 'assign_owner', leadIds: ['lead-1'], assigneeUserId: 'user-1',
    });
  });

  it('hides bulk actions for viewer role', async () => {
    renderLeads('viewer');
    await screen.findByRole('link', { name: 'דנה כהן' });
    expect(screen.queryByRole('button', { name: 'שיוך למשתמש' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('בחירה כללית')).not.toBeInTheDocument();
  });
});
