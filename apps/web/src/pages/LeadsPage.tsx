import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { fetchLeadsList, fetchUsersList, postBulkLeadAction } from '@/lib/api';
import { HeatBadge, OwnershipBadge, StatusBadge } from '@/components/Badge';
import { BulkActionBar } from '@/components/BulkActionBar';
import { LeadsTableSkeleton } from '@/components/Skeleton';
import { useToast } from '@/components/Toast';
import { useAuth } from '@/auth/auth-context';
import { formatRelative, STATUS_LABELS, HEAT_LABELS, OWNERSHIP_LABELS } from '@/lib/format';
import type { LeadHeat, LeadStatus, OwnershipMode } from '@/lib/types';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { t } from '@/lib/i18n';

const STATUSES: LeadStatus[] = [
  'new', 'first_contact_sent', 'responded', 'qualified', 'nurture',
  'checkout_pushed', 'payment_pending', 'human_handoff', 'won', 'lost', 'dormant',
];
const HEATS: LeadHeat[] = ['hot', 'warm', 'cool', 'cold'];
const OWNERS: OwnershipMode[] = ['ai_active', 'mia_active', 'phone_sales_pending', 'shared_watch', 'suppressed'];

const PAGE_SIZE = 50;

interface SavedView {
  id: string;
  name: string;
  search: string;
  status: string;
  heat: string;
  ownership: string;
  createdFrom: string;
  createdTo: string;
  inboundFrom: string;
}

const SAVED_VIEWS_KEY = 'karnaf:leads:savedViews';

function loadSavedViews(): SavedView[] {
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(SAVED_VIEWS_KEY) : null;
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistSavedViews(views: SavedView[]) {
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify(views));
  } catch {
    /* ignore quota errors */
  }
}

export function LeadsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState(searchParams.get('status') ?? '');
  const [heat, setHeat] = useState(searchParams.get('heat') ?? '');
  const [ownership, setOwnership] = useState(searchParams.get('ownership') ?? '');
  const [createdFrom, setCreatedFrom] = useState(searchParams.get('createdFrom') ?? '');
  const [createdTo, setCreatedTo] = useState(searchParams.get('createdTo') ?? '');
  const [inboundFrom, setInboundFrom] = useState(searchParams.get('inboundFrom') ?? '');
  const [offset, setOffset] = useState(0);
  const [savedViews, setSavedViews] = useState<SavedView[]>(() => loadSavedViews());
  const [searchIn, setSearchIn] = useState<'lead' | 'messages'>('lead');
  useDocumentTitle(t('leads_title'));

  const debouncedSearch = useDebouncedValue(search, 200);

  // Reflect filters in the URL so they survive navigation/share.
  useEffect(() => {
    const next = new URLSearchParams();
    if (status) next.set('status', status);
    if (heat) next.set('heat', heat);
    if (ownership) next.set('ownership', ownership);
    if (createdFrom) next.set('createdFrom', createdFrom);
    if (createdTo) next.set('createdTo', createdTo);
    if (inboundFrom) next.set('inboundFrom', inboundFrom);
    setSearchParams(next, { replace: true });
  }, [status, heat, ownership, createdFrom, createdTo, inboundFrom, setSearchParams]);

  // dates from UI come as yyyy-mm-dd; expand to UTC range so we match the
  // entire day for createdTo, and start-of-day for createdFrom / inboundFrom.
  const expandStart = (s: string) => (s ? `${s}T00:00:00.000Z` : undefined);
  const expandEnd = (s: string) => (s ? `${s}T23:59:59.999Z` : undefined);

  const params = {
    search: debouncedSearch.trim() || undefined,
    searchIn,
    status: status || undefined,
    heat: heat || undefined,
    ownershipMode: ownership || undefined,
    createdFrom: expandStart(createdFrom),
    createdTo: expandEnd(createdTo),
    inboundFrom: expandStart(inboundFrom),
    limit: PAGE_SIZE,
    offset,
  };

  function applyView(view: SavedView) {
    setSearch(view.search);
    setStatus(view.status);
    setHeat(view.heat);
    setOwnership(view.ownership);
    setCreatedFrom(view.createdFrom);
    setCreatedTo(view.createdTo);
    setInboundFrom(view.inboundFrom);
    setOffset(0);
  }

  function saveCurrentView() {
    const name = window.prompt('שם לתצוגה השמורה?')?.trim();
    if (!name) return;
    const view: SavedView = {
      id: crypto.randomUUID(),
      name, search, status, heat, ownership, createdFrom, createdTo, inboundFrom,
    };
    const next = [...savedViews.filter((v) => v.name !== name), view];
    setSavedViews(next);
    persistSavedViews(next);
  }

  function deleteView(id: string) {
    const next = savedViews.filter((v) => v.id !== id);
    setSavedViews(next);
    persistSavedViews(next);
  }

  const q = useQuery({
    queryKey: ['leads', params],
    queryFn: () => fetchLeadsList(params),
    placeholderData: (prev) => prev,
    // ⚠️ Operator-reported "I don't see new leads coming in" — without
    // polling the list froze on mount. 30s is a comfortable cadence that
    // catches new intakes between focused interactions. Pauses in
    // background tabs to avoid burning Vercel/Supabase quota.
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });

  const auth = useAuth();
  const canBulkEdit = auth.role === 'owner' || auth.role === 'admin' || auth.role === 'mia';
  const usersQ = useQuery({
    queryKey: ['profiles-active'],
    queryFn: () => fetchUsersList(),
    enabled: canBulkEdit,
    staleTime: 60_000,
  });
  const assignableUsers = useMemo(
    () => (usersQ.data ?? []).filter(
      (u) => u.is_active && ['owner', 'admin', 'mia', 'sales_rep'].includes(u.role),
    ),
    [usersQ.data],
  );

  const toast = useToast();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Clear selection when the user filters or paginates so the action bar
  // never references rows the manager can't currently see.
  useEffect(() => { setSelected(new Set()); }, [
    debouncedSearch, status, heat, ownership, createdFrom, createdTo, inboundFrom, offset,
  ]);

  const bulkMut = useMutation({
    mutationFn: postBulkLeadAction,
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['leads'] });
      toast.success(`עודכנו ${res.updated} לידים`);
      setSelected(new Set());
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const total = q.data?.total ?? null;
  const start = total != null ? offset + 1 : null;
  const end = total != null ? Math.min(offset + (q.data?.leads.length ?? 0), total) : null;
  const hasFilters = !!(search || status || heat || ownership || createdFrom || createdTo || inboundFrom);

  function clearFilters() {
    setSearch(''); setStatus(''); setHeat(''); setOwnership('');
    setCreatedFrom(''); setCreatedTo(''); setInboundFrom('');
    setOffset(0);
  }

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">{t('leads_title')}</h1>
        <span className="text-sm text-slate-500">{total != null ? `${total} ${t('total_count')}` : ''}</span>
      </header>

      <div className="kf-card grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 md:grid-cols-5">
        <div className="sm:col-span-2 md:col-span-2">
          <div className="relative">
            <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 end-3 grid place-items-center text-slate-400">
              <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.7">
                <circle cx="9" cy="9" r="5.5" /><path strokeLinecap="round" d="m13.5 13.5 3 3" />
              </svg>
            </span>
            <input
              className="kf-input pe-9"
              placeholder={searchIn === 'messages' ? 'חיפוש בתוכן ההודעות...' : t('search_placeholder')}
              value={search}
              onChange={(e) => { setSearch(e.target.value); setOffset(0); }}
            />
          </div>
          <div className="mt-1 flex items-center gap-2 text-xs">
            <button
              type="button"
              className={`rounded-full px-2 py-0.5 ${searchIn === 'lead' ? 'bg-brand-100 text-brand-700' : 'text-slate-500'}`}
              onClick={() => { setSearchIn('lead'); setOffset(0); }}
              aria-pressed={searchIn === 'lead'}
            >
              שם / טלפון / מייל
            </button>
            <button
              type="button"
              className={`rounded-full px-2 py-0.5 ${searchIn === 'messages' ? 'bg-brand-100 text-brand-700' : 'text-slate-500'}`}
              onClick={() => { setSearchIn('messages'); setOffset(0); }}
              aria-pressed={searchIn === 'messages'}
            >
              תוכן הודעות
            </button>
          </div>
        </div>
        <select className="kf-input" value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
          <option value="">{t('filter_all_statuses')}</option>
          {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
        </select>
        <select className="kf-input" value={heat} onChange={(e) => { setHeat(e.target.value); setOffset(0); }}>
          <option value="">{t('filter_all_heat')}</option>
          {HEATS.map((h) => <option key={h} value={h}>{HEAT_LABELS[h]}</option>)}
        </select>
        <select className="kf-input" value={ownership} onChange={(e) => { setOwnership(e.target.value); setOffset(0); }}>
          <option value="">{t('filter_all_ownership')}</option>
          {OWNERS.map((o) => <option key={o} value={o}>{OWNERSHIP_LABELS[o]}</option>)}
        </select>
        <div className="sm:col-span-2 md:col-span-5">
          <details className="rounded-lg border border-slate-200 bg-slate-50/40 p-2 text-sm">
            <summary className="cursor-pointer text-xs font-medium text-slate-600">סינון לפי תאריכים ותצוגות שמורות</summary>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
              <label className="text-xs text-slate-600">
                נוצר מ:
                <input
                  type="date"
                  className="kf-input mt-1"
                  value={createdFrom}
                  onChange={(e) => { setCreatedFrom(e.target.value); setOffset(0); }}
                />
              </label>
              <label className="text-xs text-slate-600">
                נוצר עד:
                <input
                  type="date"
                  className="kf-input mt-1"
                  value={createdTo}
                  onChange={(e) => { setCreatedTo(e.target.value); setOffset(0); }}
                />
              </label>
              <label className="text-xs text-slate-600">
                הודעה אחרונה מ:
                <input
                  type="date"
                  className="kf-input mt-1"
                  value={inboundFrom}
                  onChange={(e) => { setInboundFrom(e.target.value); setOffset(0); }}
                />
              </label>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-200 pt-2">
              <span className="text-xs text-slate-500">תצוגות שמורות:</span>
              {savedViews.length === 0 ? (
                <span className="text-xs text-slate-400">אין עדיין</span>
              ) : (
                savedViews.map((v) => (
                  <span key={v.id} className="inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 text-xs ring-1 ring-slate-200">
                    <button type="button" className="text-brand-700 hover:underline" onClick={() => applyView(v)}>{v.name}</button>
                    <button type="button" aria-label={`מחק תצוגה ${v.name}`} className="text-slate-400 hover:text-rose-600" onClick={() => deleteView(v.id)}>×</button>
                  </span>
                ))
              )}
              <button type="button" className="kf-btn kf-btn-ghost text-xs ms-auto" onClick={saveCurrentView} disabled={!hasFilters}>
                שמירת תצוגה
              </button>
              {hasFilters ? (
                <button type="button" className="kf-btn kf-btn-ghost text-xs" onClick={clearFilters}>
                  {t('filter_clear')}
                </button>
              ) : null}
            </div>
          </details>
        </div>
      </div>

      <div className="kf-card overflow-hidden md:overflow-visible">
        <table className="kf-table kf-table-responsive">
          <thead>
            <tr>
              {canBulkEdit ? (
                <th aria-label="בחירה" className="w-8">
                  <input
                    type="checkbox"
                    aria-label="בחירה כללית"
                    checked={
                      (q.data?.leads.length ?? 0) > 0 &&
                      (q.data?.leads.every((lead) => selected.has(lead.id)) ?? false)
                    }
                    onChange={(e) => {
                      const next = new Set(selected);
                      if (e.target.checked) {
                        q.data?.leads.forEach((lead) => next.add(lead.id));
                      } else {
                        q.data?.leads.forEach((lead) => next.delete(lead.id));
                      }
                      setSelected(next);
                    }}
                  />
                </th>
              ) : null}
              <th>{t('table_name')}</th>
              <th>{t('table_phone')}</th>
              <th>{t('table_status')}</th>
              <th>{t('table_heat')}</th>
              <th>{t('table_ownership')}</th>
              <th>{t('table_score')}</th>
              <th>{t('table_updated')}</th>
            </tr>
          </thead>
          <tbody>
            {q.isLoading ? (
              <tr><td colSpan={canBulkEdit ? 8 : 7} className="p-0">
                <LeadsTableSkeleton rows={6} />
              </td></tr>
            ) : q.data && q.data.leads.length > 0 ? (
              q.data.leads.map((lead) => (
                <tr key={lead.id} className={selected.has(lead.id) ? 'bg-brand-50/50' : undefined}>
                  {canBulkEdit ? (
                    <td className="w-8" data-label="בחירה">
                      <input
                        type="checkbox"
                        aria-label={`בחירת ${lead.full_name || lead.id}`}
                        checked={selected.has(lead.id)}
                        onChange={(e) => {
                          const next = new Set(selected);
                          if (e.target.checked) next.add(lead.id);
                          else next.delete(lead.id);
                          setSelected(next);
                        }}
                      />
                    </td>
                  ) : null}
                  <td data-primary>
                    <Link to={`/leads/${lead.id}`} className="font-medium text-brand-700 hover:underline">
                      {lead.full_name || '—'}
                    </Link>
                    {lead.email ? (
                      <div className="text-xs text-slate-500 break-all">{lead.email}</div>
                    ) : null}
                  </td>
                  <td data-label={t('table_phone')} className="tabular-nums">
                    {lead.phone ? (
                      <a href={`tel:${lead.phone}`} className="hover:text-brand-700 hover:underline">{lead.phone}</a>
                    ) : '—'}
                  </td>
                  <td data-label={t('table_status')}><StatusBadge status={lead.lead_status} /></td>
                  <td data-label={t('table_heat')}><HeatBadge heat={lead.lead_heat} /></td>
                  <td data-label={t('table_ownership')}><OwnershipBadge ownership={lead.ownership_mode} /></td>
                  <td data-label={t('table_score')} className="tabular-nums">{lead.lead_score}</td>
                  <td data-label={t('table_updated')} className="text-slate-500" title={lead.updated_at}>{formatRelative(lead.updated_at)}</td>
                </tr>
              ))
            ) : (
              <tr><td colSpan={canBulkEdit ? 8 : 7} className="p-10 text-center text-slate-500">
                <div className="flex flex-col items-center gap-2">
                  <svg viewBox="0 0 24 24" className="h-8 w-8 text-slate-300" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <circle cx="11" cy="11" r="7" /><path strokeLinecap="round" d="m16 16 4 4" />
                  </svg>
                  <span>{t('no_matching_leads')}</span>
                </div>
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {canBulkEdit ? (
        <BulkActionBar
          selectedCount={selected.size}
          totalCount={q.data?.leads.length ?? 0}
          assignableUsers={assignableUsers}
          busy={bulkMut.isPending}
          onClear={() => setSelected(new Set())}
          onAssignOwner={(userId) =>
            bulkMut.mutate({ action: 'assign_owner', leadIds: Array.from(selected), assigneeUserId: userId })
          }
          onChangeHeat={(h) =>
            bulkMut.mutate({ action: 'change_heat', leadIds: Array.from(selected), heat: h })
          }
        />
      ) : null}

      <div className="flex items-center justify-between text-sm">
        <button type="button" className="kf-btn" disabled={offset === 0}
                onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}>{t('pagination_prev')}</button>
        <span className="text-slate-500 tabular-nums">
          {start != null && end != null ? `${start}–${end} מתוך ${total}` : `עמוד ${Math.floor(offset / PAGE_SIZE) + 1}`}
        </span>
        <button type="button" className="kf-btn"
                disabled={!q.data || q.data.leads.length < PAGE_SIZE}
                onClick={() => setOffset((o) => o + PAGE_SIZE)}>{t('pagination_next')}</button>
      </div>
    </div>
  );
}
