import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { fetchLeadsList, fetchUsersList, postBulkLeadAction, type ProductGroup } from '@/lib/api';
import { HeatBadge, OwnershipBadge, StatusBadge } from '@/components/Badge';
import { BulkActionBar } from '@/components/BulkActionBar';
import { LeadsTableSkeleton } from '@/components/Skeleton';
import { useToast } from '@/components/Toast';
import { useAuth } from '@/auth/auth-context';
import { formatRelative, STATUS_LABELS, HEAT_LABELS, OWNERSHIP_LABELS } from '@/lib/format';
import type { IntakeSegment, LeadHeat, LeadRow, LeadStatus, OwnershipMode } from '@/lib/types';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { t } from '@/lib/i18n';

const STATUSES: LeadStatus[] = [
  'new',
  'first_contact_sent',
  'responded',
  'qualified',
  'nurture',
  'checkout_pushed',
  'payment_pending',
  'human_handoff',
  'won',
  'lost',
  'dormant',
];
const HEATS: LeadHeat[] = ['hot', 'warm', 'cool', 'cold'];
const OWNERS: OwnershipMode[] = [
  'ai_active',
  'mia_active',
  'phone_sales_pending',
  'shared_watch',
  'suppressed',
];

const PAGE_SIZE = 50;

const INTAKE_SEGMENT_LABELS: Record<IntakeSegment, string> = {
  hot_sales: 'מכירה חמה',
  needs_human: 'מבקש נציג',
  needs_nurture: 'טיפוח/הבשלה',
  info_seeker: 'מחפש מידע',
  support_or_existing: 'תמיכה/קיים',
  unknown: 'לא ידוע',
};

const PRODUCT_INTEREST_LABELS: Record<string, string> = {
  digital_program: 'תוכנית הדרך לדירה',
  investor_mentorship: 'ליווי משקיעים',
  contractor_group_purchase: 'קבוצת רכישה מקבלן',
  personal_consultation: 'שיחת ייעוץ אישית',
  mentorship: 'ליווי משקיעים',
  student_tools: 'כלי תלמידים / לקוח קיים',
  financing_guidance: 'הכוונת מימון',
  unknown: 'לא ידוע',
};

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
  source: string;
}

const SAVED_VIEWS_KEY = 'karnaf:leads:savedViews';

// Tier 6.A — product strip. Four coarse groups that match how Almog
// thinks about the business, not the raw enum values. Backend maps
// each to its real primary_track + product_interest set.
const PRODUCT_GROUPS: Array<{ key: ProductGroup | ''; label: string; hint: string }> = [
  { key: '',             label: 'הכל',            hint: 'כל הלידים' },
  { key: 'program',      label: 'הדרך לדירה',     hint: 'תוכנית הליווי הדיגיטלית' },
  { key: 'investor',     label: 'ליווי משקיעים',   hint: 'ליווי אישי לרכישת השקעה' },
  { key: 'presale',      label: 'פריסייל',         hint: 'קבוצות רכישה / חתימה' },
  { key: 'consultation', label: 'שיחת ייעוץ ואחר', hint: 'ייעוץ אישי, מימון, ולא מסווג' },
];

function LeadWorkCard({
  lead,
  selected,
  canBulkEdit,
  onToggle,
}: {
  lead: LeadRow;
  selected: boolean;
  canBulkEdit: boolean;
  onToggle: (checked: boolean) => void;
}) {
  const guidance = leadListGuidance(lead);
  return (
    <article
      className={`p-4 transition sm:p-5 ${selected ? 'bg-brand-50/50' : 'bg-white hover:bg-slate-50/60'}`}
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px] lg:items-center">
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {canBulkEdit ? (
              <input
                type="checkbox"
                aria-label={`בחירת ${lead.full_name || lead.id}`}
                checked={selected}
                onChange={(e) => onToggle(e.target.checked)}
              />
            ) : null}
            <Link to={`/leads/${lead.id}`} className="text-lg font-semibold text-brand-700 hover:underline">
              {lead.full_name || 'ליד ללא שם'}
            </Link>
            <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${guidance.tone}`}>
              {guidance.label}
            </span>
            <span className="text-xs text-slate-500" title={lead.updated_at}>
              עודכן {formatRelative(lead.updated_at)}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-600">
            {lead.phone ? (
              <a href={`tel:${lead.phone}`} className="tabular-nums hover:text-brand-700 hover:underline">
                {lead.phone}
              </a>
            ) : (
              <span>אין טלפון</span>
            )}
            {lead.email ? <span className="break-all">{lead.email}</span> : null}
            <span>מקור: {lead.source || '—'}</span>
            {lead.product_interest ? (
              <span>מוצר: {PRODUCT_INTEREST_LABELS[lead.product_interest] ?? lead.product_interest}</span>
            ) : null}
            {lead.last_inbound_at ? <span>הודעה אחרונה: {formatRelative(lead.last_inbound_at)}</span> : null}
          </div>
          <p className="text-sm leading-6 text-slate-700">{lead.suggested_next_action || guidance.detail}</p>
          <div className="flex flex-wrap gap-2">
            <StatusBadge status={lead.lead_status} />
            <HeatBadge heat={lead.lead_heat} />
            <OwnershipBadge ownership={lead.ownership_mode} />
            {lead.intake_segment ? (
              <span className="kf-badge bg-violet-100 text-violet-800">
                {INTAKE_SEGMENT_LABELS[lead.intake_segment] ?? lead.intake_segment}
              </span>
            ) : null}
            <span className="kf-badge bg-slate-100 text-slate-700">ציון {lead.lead_score}</span>
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-1">
          <Link to={`/leads/${lead.id}`} className="kf-btn kf-btn-primary justify-center">
            פתיחת ליד
          </Link>
          {lead.phone ? (
            <a href={`tel:${lead.phone}`} className="kf-btn justify-center">
              חיוג
            </a>
          ) : null}
          {lead.phone ? (
            <a
              href={`https://wa.me/${lead.phone.replace(/\D/g, '')}`}
              target="_blank"
              rel="noopener noreferrer"
              className="kf-btn kf-btn-ghost justify-center"
            >
              WhatsApp
            </a>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function leadListGuidance(lead: LeadRow) {
  if (lead.intake_segment === 'support_or_existing') {
    return {
      label: 'תמיכה/לקוח קיים',
      detail: 'לעצור מכירה אוטומטית ולבדוק אם זה תלמיד או לקוח קיים שצריך תמיכה.',
      tone: 'bg-purple-100 text-purple-800',
    };
  }
  if (lead.intake_segment === 'hot_sales') {
    return {
      label: 'מכירה חמה',
      detail: 'לענות על חסם אחרון ולהתקדם להרשמה, תשלום או שיחת סגירה קצרה.',
      tone: 'bg-emerald-100 text-emerald-800',
    };
  }
  if (lead.intake_segment === 'needs_human') {
    return {
      label: 'מבקש נציג',
      detail: 'הליד ביקש שיחה או אדם אנושי. לפתוח, לקרוא סיכום ולהעביר לנציג.',
      tone: 'bg-indigo-100 text-indigo-800',
    };
  }
  if (
    lead.do_not_contact ||
    lead.removed_by_request ||
    lead.lead_status === 'do_not_contact' ||
    lead.lead_status === 'removed_by_request'
  ) {
    return {
      label: 'לא ליצור קשר',
      detail: 'הליד מסומן כהסרה/לא ליצור קשר. להשאיר לתיעוד בלבד.',
      tone: 'bg-rose-100 text-rose-800',
    };
  }
  if (lead.ownership_mode === 'phone_sales_pending') {
    return {
      label: 'להתקשר',
      detail: 'השלב הבא הוא שיחת טלפון יזומה. אחרי השיחה כדאי לעדכן סיכום וסטטוס.',
      tone: 'bg-indigo-100 text-indigo-800',
    };
  }
  if (lead.lead_status === 'human_handoff' || lead.ownership_mode === 'mia_active') {
    return {
      label: 'בטיפול אנושי',
      detail: 'ה-AI מושעה כרגע. צריך לוודא שיש מענה אנושי או להחזיר ל-AI אחרי סיום טיפול.',
      tone: 'bg-amber-100 text-amber-800',
    };
  }
  if (lead.lead_status === 'payment_pending') {
    return {
      label: 'קרוב לסגירה',
      detail: 'הליד ממתין לתשלום. לבדוק אם צריך קישור, תזכורת או שיחת סגירה קצרה.',
      tone: 'bg-emerald-100 text-emerald-800',
    };
  }
  if (lead.lead_heat === 'hot') {
    return {
      label: 'ליד חם',
      detail: 'כדאי לעקוב מקרוב. אם השיחה רגישה או נתקעת, לקחת לטיפול ידני.',
      tone: 'bg-rose-100 text-rose-800',
    };
  }
  if (lead.ownership_mode === 'ai_active') {
    return {
      label: 'AI מטפל',
      detail: 'אין צורך להתערב כרגע. המערכת ממשיכה את השיחה לפי ה-playbook הפעיל.',
      tone: 'bg-sky-100 text-sky-800',
    };
  }
  return {
    label: 'מעקב',
    detail: 'אין פעולה דחופה מזוהה. לפתוח אם צריך להבין הקשר או לעדכן פרטים.',
    tone: 'bg-slate-100 text-slate-700',
  };
}

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
  const [source, setSource] = useState(searchParams.get('source') ?? '');
  const [productGroup, setProductGroup] = useState<ProductGroup | ''>(
    (searchParams.get('productGroup') as ProductGroup | null) ?? ''
  );
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
    if (source) next.set('source', source);
    if (productGroup) next.set('productGroup', productGroup);
    if (createdFrom) next.set('createdFrom', createdFrom);
    if (createdTo) next.set('createdTo', createdTo);
    if (inboundFrom) next.set('inboundFrom', inboundFrom);
    setSearchParams(next, { replace: true });
  }, [status, heat, ownership, source, productGroup, createdFrom, createdTo, inboundFrom, setSearchParams]);

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
    source: source || undefined,
    productGroup: productGroup || undefined,
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
    setSource(view.source ?? '');
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
      name,
      search,
      status,
      heat,
      ownership,
      createdFrom,
      createdTo,
      inboundFrom,
      source,
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
    () =>
      (usersQ.data ?? []).filter(
        (u) => u.is_active && ['owner', 'admin', 'mia', 'sales_rep'].includes(u.role),
      ),
    [usersQ.data],
  );

  const toast = useToast();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Clear selection when the user filters or paginates so the action bar
  // never references rows the manager can't currently see.
  useEffect(() => {
    setSelected(new Set());
  }, [debouncedSearch, status, heat, ownership, source, createdFrom, createdTo, inboundFrom, offset]);

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
  const hasFilters = !!(search || status || heat || ownership || source || createdFrom || createdTo || inboundFrom);

  function clearFilters() {
    setSearch('');
    setStatus('');
    setHeat('');
    setOwnership('');
    setSource('');
    setCreatedFrom('');
    setCreatedTo('');
    setInboundFrom('');
    setOffset(0);
  }

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">{t('leads_title')}</h1>
        <span className="text-sm text-slate-500">{total != null ? `${total} ${t('total_count')}` : ''}</span>
      </header>

      {/* Tier 6.A — product strip. Coarse-grained tabs by what the
          customer actually wants (program / investor / presale /
          consultation). Sits above the detailed filter card so a
          manager pivots between products in one click; the detail
          filters (status / heat / source / dates) stack beneath. */}
      <nav className="flex flex-wrap gap-1" role="tablist" aria-label="סינון לפי מוצר">
        {PRODUCT_GROUPS.map((g) => {
          const active = (productGroup ?? '') === g.key;
          return (
            <button
              key={g.key || 'all'}
              type="button"
              role="tab"
              aria-selected={active}
              title={g.hint}
              onClick={() => {
                setProductGroup(g.key as ProductGroup | '');
                setOffset(0);
              }}
              className={
                active
                  ? 'rounded-full bg-brand-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm'
                  : 'rounded-full bg-white px-3 py-1.5 text-sm text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50'
              }
            >
              {g.label}
            </button>
          );
        })}
      </nav>

      <div className="kf-card grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 md:grid-cols-5">
        <div className="sm:col-span-2 md:col-span-2">
          <div className="relative">
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 end-3 grid place-items-center text-slate-400"
            >
              <svg
                viewBox="0 0 20 20"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
              >
                <circle cx="9" cy="9" r="5.5" />
                <path strokeLinecap="round" d="m13.5 13.5 3 3" />
              </svg>
            </span>
            <input
              className="kf-input pe-9"
              placeholder={searchIn === 'messages' ? 'חיפוש בתוכן ההודעות...' : t('search_placeholder')}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setOffset(0);
              }}
            />
          </div>
          <div className="mt-1 flex items-center gap-2 text-xs">
            <button
              type="button"
              className={`rounded-full px-2 py-0.5 ${searchIn === 'lead' ? 'bg-brand-100 text-brand-700' : 'text-slate-500'}`}
              onClick={() => {
                setSearchIn('lead');
                setOffset(0);
              }}
              aria-pressed={searchIn === 'lead'}
            >
              שם / טלפון / מייל
            </button>
            <button
              type="button"
              className={`rounded-full px-2 py-0.5 ${searchIn === 'messages' ? 'bg-brand-100 text-brand-700' : 'text-slate-500'}`}
              onClick={() => {
                setSearchIn('messages');
                setOffset(0);
              }}
              aria-pressed={searchIn === 'messages'}
            >
              תוכן הודעות
            </button>
          </div>
        </div>
        <select
          className="kf-input"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setOffset(0);
          }}
        >
          <option value="">{t('filter_all_statuses')}</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <select
          className="kf-input"
          value={heat}
          onChange={(e) => {
            setHeat(e.target.value);
            setOffset(0);
          }}
        >
          <option value="">{t('filter_all_heat')}</option>
          {HEATS.map((h) => (
            <option key={h} value={h}>
              {HEAT_LABELS[h]}
            </option>
          ))}
        </select>
        <select
          className="kf-input"
          value={ownership}
          onChange={(e) => {
            setOwnership(e.target.value);
            setOffset(0);
          }}
        >
          <option value="">{t('filter_all_ownership')}</option>
          {OWNERS.map((o) => (
            <option key={o} value={o}>
              {OWNERSHIP_LABELS[o]}
            </option>
          ))}
        </select>
        <div className="sm:col-span-2 md:col-span-5">
          <details className="rounded-lg border border-slate-200 bg-slate-50/40 p-2 text-sm">
            <summary className="cursor-pointer text-xs font-medium text-slate-600">
              סינון לפי תאריכים ותצוגות שמורות
            </summary>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
              <label className="text-xs text-slate-600">
                נוצר מ:
                <input
                  type="date"
                  className="kf-input mt-1"
                  value={createdFrom}
                  onChange={(e) => {
                    setCreatedFrom(e.target.value);
                    setOffset(0);
                  }}
                />
              </label>
              <label className="text-xs text-slate-600">
                נוצר עד:
                <input
                  type="date"
                  className="kf-input mt-1"
                  value={createdTo}
                  onChange={(e) => {
                    setCreatedTo(e.target.value);
                    setOffset(0);
                  }}
                />
              </label>
              <label className="text-xs text-slate-600">
                הודעה אחרונה מ:
                <input
                  type="date"
                  className="kf-input mt-1"
                  value={inboundFrom}
                  onChange={(e) => {
                    setInboundFrom(e.target.value);
                    setOffset(0);
                  }}
                />
              </label>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-200 pt-2">
              <span className="text-xs text-slate-500">תצוגות שמורות:</span>
              {savedViews.length === 0 ? (
                <span className="text-xs text-slate-400">אין עדיין</span>
              ) : (
                savedViews.map((v) => (
                  <span
                    key={v.id}
                    className="inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 text-xs ring-1 ring-slate-200"
                  >
                    <button
                      type="button"
                      className="text-brand-700 hover:underline"
                      onClick={() => applyView(v)}
                    >
                      {v.name}
                    </button>
                    <button
                      type="button"
                      aria-label={`מחק תצוגה ${v.name}`}
                      className="text-slate-400 hover:text-rose-600"
                      onClick={() => deleteView(v.id)}
                    >
                      ×
                    </button>
                  </span>
                ))
              )}
              <button
                type="button"
                className="kf-btn kf-btn-ghost text-xs ms-auto"
                onClick={saveCurrentView}
                disabled={!hasFilters}
              >
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

      <section className="kf-card overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold">רשימת עבודה</h2>
            <p className="text-sm text-slate-500">
              כל ליד מוצג ככרטיס עם המלצת פעולה קצרה, במקום טבלה טכנית.
            </p>
            {source ? (
              <div className="mt-2 inline-flex items-center gap-2 rounded-full bg-brand-50 px-3 py-1 text-xs font-medium text-brand-700 ring-1 ring-brand-100">
                מקור: {source}
                <button type="button" className="text-brand-500 hover:text-rose-600" onClick={() => setSource('')} aria-label="ניקוי סינון מקור">
                  ×
                </button>
              </div>
            ) : null}
          </div>
          {canBulkEdit ? (
            <label className="inline-flex items-center gap-2 text-sm text-slate-600">
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
              בחירת כל הלידים בעמוד
            </label>
          ) : null}
        </div>
        {q.isLoading ? (
          <LeadsTableSkeleton rows={6} />
        ) : q.data && q.data.leads.length > 0 ? (
          <div className="divide-y divide-slate-100">
            {q.data.leads.map((lead) => (
              <LeadWorkCard
                key={lead.id}
                lead={lead}
                selected={selected.has(lead.id)}
                canBulkEdit={canBulkEdit}
                onToggle={(checked) => {
                  const next = new Set(selected);
                  if (checked) next.add(lead.id);
                  else next.delete(lead.id);
                  setSelected(next);
                }}
              />
            ))}
          </div>
        ) : (
          <div className="p-10 text-center text-slate-500">
            <div className="flex flex-col items-center gap-2">
              <svg
                viewBox="0 0 24 24"
                className="h-8 w-8 text-slate-300"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <circle cx="11" cy="11" r="7" />
                <path strokeLinecap="round" d="m16 16 4 4" />
              </svg>
              <span>{t('no_matching_leads')}</span>
            </div>
          </div>
        )}
      </section>

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
        <button
          type="button"
          className="kf-btn"
          disabled={offset === 0}
          onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
        >
          {t('pagination_prev')}
        </button>
        <span className="text-slate-500 tabular-nums">
          {start != null && end != null
            ? `${start}–${end} מתוך ${total}`
            : `עמוד ${Math.floor(offset / PAGE_SIZE) + 1}`}
        </span>
        <button
          type="button"
          className="kf-btn"
          disabled={!q.data || q.data.leads.length < PAGE_SIZE}
          onClick={() => setOffset((o) => o + PAGE_SIZE)}
        >
          {t('pagination_next')}
        </button>
      </div>
    </div>
  );
}
