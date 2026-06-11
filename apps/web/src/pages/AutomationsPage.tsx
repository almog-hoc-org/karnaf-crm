import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { fetchAutomations, fetchLeadsList, postAutomationToggle, postAutomationUpdateDsl } from '@/lib/api';
import type { AutomationRuleRow, AutomationRunRow, AutomationSource, LeadRow } from '@/lib/types';
import { evaluateConditionsWithTrace, sampleContextForTrigger, type EvalResult } from '@/lib/automation-dsl';
import { useToast } from '@/components/Toast';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { formatRelative } from '@/lib/format';
import { t } from '@/lib/i18n';
import { PageIntro } from '@/components/PageIntro';

const CATEGORY_LABELS: Record<string, string> = {
  intake: 'קליטה וניתוב',
  nurture: 'טיפוח',
  sales: 'מכירה',
  commission: 'עמלות',
  retention: 'שימור',
  presale: 'פריסייל',
  control: 'בקרה',
  partner: 'פרילנסרים',
};

const SOURCE_LABELS: Record<AutomationSource, string> = {
  code: 'בקוד',
  engine: 'במנוע',
  planned: 'בתכנון',
};

const SOURCE_TONE: Record<AutomationSource, string> = {
  code: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  engine: 'bg-sky-50 text-sky-700 ring-sky-200',
  planned: 'bg-slate-100 text-slate-500 ring-slate-200',
};

export function AutomationsPage() {
  useDocumentTitle('מנוע אוטומציה');
  const toast = useToast();
  const qc = useQueryClient();

  const q = useQuery({ queryKey: ['automations'], queryFn: () => fetchAutomations(true) });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => postAutomationToggle(id, enabled),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['automations'] });
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const updateDsl = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: { conditions?: Record<string, unknown>; actions?: Array<Record<string, unknown>> } }) =>
      postAutomationUpdateDsl(id, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['automations'] });
      toast.success('כלל עודכן');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const [editing, setEditing] = useState<AutomationRuleRow | null>(null);

  const rules = q.data?.rules ?? [];
  const runs = q.data?.runs ?? [];

  // Most-recent run per rule_code (for the inline "last fired" chip).
  const lastRunByRule = useMemo(() => {
    const m = new Map<string, AutomationRunRow>();
    for (const run of q.data?.runs ?? []) {
      if (!m.has(run.rule_code)) m.set(run.rule_code, run);
    }
    return m;
  }, [q.data?.runs]);

  // Group rules by category for the section layout.
  const byCategory = useMemo(() => {
    const groups = new Map<string, AutomationRuleRow[]>();
    for (const rule of q.data?.rules ?? []) {
      if (!groups.has(rule.category)) groups.set(rule.category, []);
      groups.get(rule.category)!.push(rule);
    }
    return groups;
  }, [q.data?.rules]);

  // Headline counts.
  const summary = useMemo(() => {
    const acc: Record<AutomationSource, number> = { code: 0, engine: 0, planned: 0 };
    for (const r of q.data?.rules ?? []) acc[r.source]++;
    return acc;
  }, [q.data?.rules]);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">מנוע אוטומציה</h1>
        <span className="text-sm text-slate-500">{rules.length} כללים</span>
      </header>

      <PageIntro>
        קטלוג כל האוטומציות במערכת + יומן הרצות אחרון. כללים מסומנים "בקוד" רצים
        מעמדות לוגיקה קיימות (sla-worker, daily-sales-inbox, triggers); "במנוע"
        ירוצו מהמנוע ההגדרתי שעדיין נבנה; "בתכנון" הם כללים מהמפרט שעוד לא מומשו.
      </PageIntro>

      <div className="grid grid-cols-3 gap-2">
        {(['code', 'engine', 'planned'] as AutomationSource[]).map((s) => (
          <div key={s} className="kf-card p-3">
            <div className="text-xs text-slate-500">{SOURCE_LABELS[s]}</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{summary[s]}</div>
          </div>
        ))}
      </div>

      {q.isLoading ? <p className="text-slate-500">{t('loading')}</p> : null}

      {Array.from(byCategory.entries()).map(([category, items]) => (
        <section key={category} className="kf-card p-4">
          <h2 className="text-lg font-semibold">{CATEGORY_LABELS[category] ?? category}</h2>
          <ul className="mt-3 space-y-2">
            {items.map((rule) => {
              const lastRun = lastRunByRule.get(rule.code);
              return (
                <li key={rule.id} className={clsx(
                  'rounded-lg border p-3',
                  rule.enabled ? 'border-slate-200 bg-white' : 'border-slate-200 bg-slate-50 opacity-70',
                )}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="flex items-baseline gap-2">
                      <strong className="text-sm">{rule.name_he}</strong>
                      <code className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-mono text-slate-600">{rule.code}</code>
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                      <span className={clsx(
                        'rounded-full px-2 py-0.5 ring-1 ring-inset',
                        SOURCE_TONE[rule.source],
                      )}>{SOURCE_LABELS[rule.source]}</span>
                      {rule.source !== 'planned' ? (
                        <label className="flex cursor-pointer items-center gap-1">
                          <input type="checkbox" checked={rule.enabled} disabled={toggle.isPending}
                            onChange={(e) => toggle.mutate({ id: rule.id, enabled: e.target.checked })} />
                          <span>{rule.enabled ? 'פעיל' : 'מושבת'}</span>
                        </label>
                      ) : null}
                      {rule.source === 'engine' ? (
                        <button type="button" className="kf-btn text-xs" onClick={() => setEditing(rule)}>עריכה</button>
                      ) : null}
                    </div>
                  </div>
                  {rule.description ? <p className="mt-1 text-xs text-slate-500">{rule.description}</p> : null}
                  <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-slate-500">
                    <span>טריגר: <code className="font-mono">{rule.trigger_event}</code></span>
                    {rule.implementation_ref ? (
                      <span>מימוש: <code className="font-mono">{rule.implementation_ref}</code></span>
                    ) : null}
                    {lastRun ? (
                      <span>
                        הרצה אחרונה:{' '}
                        <span className={clsx(
                          lastRun.status === 'success' && 'text-emerald-700',
                          lastRun.status === 'failed' && 'text-rose-700',
                          lastRun.status === 'skipped' && 'text-slate-500',
                          lastRun.status === 'partial' && 'text-amber-700',
                        )}>{lastRun.status}</span>
                        {' '}· {formatRelative(lastRun.created_at)}
                      </span>
                    ) : <span className="text-slate-400">לא רצה עדיין</span>}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      {editing ? (
        <EditRuleDialog
          rule={editing}
          busy={updateDsl.isPending}
          onSubmit={(payload) => {
            updateDsl.mutate({ id: editing.id, payload });
            setEditing(null);
          }}
          onCancel={() => setEditing(null)}
        />
      ) : null}

      {runs.length > 0 ? (
        <section className="kf-card p-4">
          <h2 className="text-lg font-semibold">הרצות אחרונות</h2>
          <ul className="mt-3 divide-y divide-slate-100 text-sm">
            {runs.slice(0, 20).map((run) => (
              <li key={run.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <code className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-mono">{run.rule_code}</code>
                    <span className={clsx(
                      'text-xs font-medium',
                      run.status === 'success' && 'text-emerald-700',
                      run.status === 'failed' && 'text-rose-700',
                      run.status === 'skipped' && 'text-slate-500',
                      run.status === 'partial' && 'text-amber-700',
                    )}>{run.status}</span>
                  </div>
                  {run.reason ? <div className="text-xs text-slate-500">{run.reason}</div> : null}
                </div>
                <span className="text-xs text-slate-500" title={run.created_at}>{formatRelative(run.created_at)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

// ── Edit dialog ─────────────────────────────────────────────────────────
//
// JSON editor for the engine DSL. Tier 4 ships text-area-of-JSON; the
// drag-drop visual editor is later. Validates parse before submit so
// a bad keystroke doesn't post 400s to the API.

function EditRuleDialog({
  rule,
  busy,
  onSubmit,
  onCancel,
}: {
  rule: AutomationRuleRow;
  busy: boolean;
  onSubmit: (payload: { conditions?: Record<string, unknown>; actions?: Array<Record<string, unknown>> }) => void;
  onCancel: () => void;
}) {
  const [conditions, setConditions] = useState(() => JSON.stringify(rule.conditions ?? {}, null, 2));
  const [actions, setActions] = useState(() => JSON.stringify(rule.actions ?? [], null, 2));
  const [parseError, setParseError] = useState<string | null>(null);

  // Tier 5.D.4 / 5.F — in-browser "test against this lead". evaluateConditions
  // is pure (mirrored from the server's automation-engine.ts). The
  // editor admin clicks "בחן" → sees pass/fail + per-leaf trace.
  // sampleContextForTrigger prefills a realistic context object for
  // the rule's trigger_event so the admin doesn't have to invent
  // JSON from scratch. 5.F adds a real-lead picker that builds a
  // context from a live DB row (no fakery), so "passes preview"
  // really means "would pass when this trigger fires for this lead".
  const [testContext, setTestContext] = useState(() =>
    JSON.stringify(sampleContextForTrigger(rule.trigger_event), null, 2),
  );
  const [testResult, setTestResult] = useState<EvalResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  // Lazy: fetch the 50 most-recent leads only when the picker opens,
  // so the dialog's initial paint stays cheap. Once Mia uses it, the
  // result caches under react-query's staleTime defaults.
  const [pickerOpen, setPickerOpen] = useState(false);
  const leadsQ = useQuery({
    queryKey: ['automations-test-leads'],
    queryFn: () => fetchLeadsList({ limit: 50 }),
    enabled: pickerOpen,
  });

  function loadContextFromLead(lead: LeadRow) {
    const firstName = lead.full_name?.split(/\s+/u)[0] ?? '';
    // Mirror the context shape the server emits per trigger event so
    // the test agrees with prod. lead.created path: leads-intake.
    // deal.won path: admin-actions/mark_won. time.elapsed: cron tick.
    // City isn't on LeadRow (the list endpoint omits it). The full
    // detail page provides it. Test panel can live without it; rules
    // that condition on city need a /leads/:id fetch — defer.
    const leadCtx: Record<string, unknown> = {
      id: lead.id,
      full_name: lead.full_name,
      first_name: firstName,
      phone: lead.phone,
      email: lead.email,
      product_interest: lead.product_interest,
      intake_segment: lead.intake_segment,
      do_not_contact: lead.do_not_contact,
      primary_track: lead.primary_track,
      lead_status: lead.lead_status,
      ownership_mode: lead.ownership_mode,
    };
    // For time.elapsed rules we add the derived fields the cron tick
    // computes. has_won_program is unknown without a separate query;
    // default to false so a "no purchase yet" rule passes for testing.
    if (rule.trigger_event === 'time.elapsed') {
      const hours = (Date.now() - Date.parse(lead.created_at)) / 3600000;
      leadCtx.hours_since_intake = Math.round(hours * 10) / 10;
      leadCtx.has_won_program = false;
    }
    setTestContext(JSON.stringify({ lead: leadCtx }, null, 2));
    setPickerOpen(false);
    setTestResult(null);
  }

  function runTest() {
    setTestError(null);
    let parsedConditions: Record<string, unknown>;
    let parsedContext: Record<string, unknown>;
    try {
      parsedConditions = JSON.parse(conditions);
    } catch (err) {
      setTestError(`conditions: ${(err as Error).message}`);
      return;
    }
    try {
      parsedContext = JSON.parse(testContext);
    } catch (err) {
      setTestError(`context: ${(err as Error).message}`);
      return;
    }
    setTestResult(evaluateConditionsWithTrace(parsedConditions, parsedContext));
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setParseError(null);
    let parsedConditions: Record<string, unknown>;
    let parsedActions: Array<Record<string, unknown>>;
    try {
      parsedConditions = JSON.parse(conditions);
      if (typeof parsedConditions !== 'object' || parsedConditions === null || Array.isArray(parsedConditions)) {
        throw new Error('conditions חייב להיות אובייקט');
      }
    } catch (err) {
      setParseError(`conditions: ${(err as Error).message}`);
      return;
    }
    try {
      parsedActions = JSON.parse(actions);
      if (!Array.isArray(parsedActions)) throw new Error('actions חייב להיות מערך');
    } catch (err) {
      setParseError(`actions: ${(err as Error).message}`);
      return;
    }
    onSubmit({ conditions: parsedConditions, actions: parsedActions });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onCancel}>
      <form className="kf-card max-h-[92vh] w-full max-w-3xl space-y-3 overflow-auto p-5" onSubmit={submit} onClick={(e) => e.stopPropagation()}>
        <header>
          <h2 className="text-lg font-semibold">עריכת כלל — {rule.name_he}</h2>
          <code className="text-xs text-slate-500">{rule.code} · {rule.trigger_event}</code>
        </header>
        <details className="rounded-md bg-slate-50 p-3 text-xs text-slate-600">
          <summary className="cursor-pointer font-medium">תיעוד DSL</summary>
          <div className="mt-2 space-y-2">
            <p><strong>conditions</strong> מתואר ב-DSL רקורסיבי: <code>{`{"all": [...]}`}</code> ו-<code>{`{"any": [...]}`}</code> מקננים לוגיקה. עלים: <code>{`{"field": "lead.x", "op": "eq", "value": "..."}`}</code>. אופרטורים: eq, neq, in, not_in, gt/gte/lt/lte, exists, not_exists.</p>
            <p><strong>actions</strong> מערך של אובייקטים <code>{`{"type": "..."}`}</code>:</p>
            <ul className="list-disc pr-4">
              <li><code>send_template</code> + <code>key</code> + <code>channel</code></li>
              <li><code>notify_internal</code> + <code>text</code></li>
              <li><code>create_task</code> + <code>title</code> + <code>kind</code> + <code>due_in_hours</code></li>
              <li><code>set_field</code> + <code>table</code> + <code>field</code> + <code>value</code> (whitelist: leads.heat/next_action_*)</li>
            </ul>
          </div>
        </details>
        {/* Tier 6.D.3 — the two JSON textareas were the loudest thing
            in the dialog even though most edits are toggling enabled or
            tweaking copy. Collapsed by default behind a disclosure so
            the dialog opens compact; rule-test panel below still gets
            its own disclosure (Tier 5.D.4). */}
        <details className="rounded-md border border-slate-200 p-3">
          <summary className="cursor-pointer text-sm font-medium text-slate-700">עריכת conditions ו-actions (JSON)</summary>
          <label className="mt-3 block text-sm">
            <span className="text-slate-600">conditions (JSON)</span>
            <textarea className="kf-input mt-1 min-h-[160px] font-mono text-xs leading-5"
              value={conditions} onChange={(e) => setConditions(e.target.value)} dir="ltr" />
          </label>
          <label className="mt-3 block text-sm">
            <span className="text-slate-600">actions (JSON array)</span>
            <textarea className="kf-input mt-1 min-h-[160px] font-mono text-xs leading-5"
              value={actions} onChange={(e) => setActions(e.target.value)} dir="ltr" />
          </label>
        </details>
        {parseError ? <p className="text-sm text-rose-600">{parseError}</p> : null}

        {/* Tier 5.D.4 — test panel. Collapsible by default so the
            editor doesn't get noisier than it already is. */}
        <details className="rounded-md border border-slate-200 p-3">
          <summary className="cursor-pointer text-sm font-medium text-slate-700">בחן את התנאים מול דוגמה</summary>
          <p className="mt-2 text-xs text-slate-500">
            הכלל ירוץ על המנוע בכל פעם שהטריגר <code className="font-mono">{rule.trigger_event}</code> נורה.
            כאן אפשר לבדוק אם conditions שלך מתאימים — בלי לשמור, בלי לשלוח דבר.
            הדוגמה נטענת אוטומטית לפי טריגר הכלל; אפשר לערוך אותה לפני בחינה.
          </p>
          <label className="mt-2 block text-sm">
            <span className="text-slate-600">context (JSON)</span>
            <textarea className="kf-input mt-1 min-h-[140px] font-mono text-xs leading-5" dir="ltr"
              value={testContext} onChange={(e) => setTestContext(e.target.value)} />
          </label>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button type="button" className="kf-btn text-xs" onClick={runTest}>בחן</button>
            <button type="button" className="kf-btn text-xs"
              onClick={() => setTestContext(JSON.stringify(sampleContextForTrigger(rule.trigger_event), null, 2))}>
              טען דוגמה מחדש
            </button>
            {/* Tier 5.F — pick an actual lead from prod */}
            <button type="button" className="kf-btn text-xs"
              onClick={() => setPickerOpen((open) => !open)}>
              {pickerOpen ? 'סגור בחירת ליד' : 'בחר ליד אמיתי'}
            </button>
          </div>
          {pickerOpen ? (
            <div className="mt-2 max-h-56 overflow-auto rounded-md border border-slate-200 bg-slate-50 p-2">
              {leadsQ.isLoading ? <p className="text-xs text-slate-500">טוען לידים...</p> :
                leadsQ.data?.leads.length ? (
                  <ul className="space-y-1 text-sm">
                    {leadsQ.data.leads.map((lead) => (
                      <li key={lead.id}>
                        <button type="button" className="w-full rounded-md p-2 text-right hover:bg-white"
                          onClick={() => loadContextFromLead(lead)}>
                          <div className="flex items-baseline justify-between gap-2">
                            <strong className="truncate">{lead.full_name || lead.phone || lead.email || lead.id.slice(0, 8)}</strong>
                            <span className="text-xs text-slate-500">{lead.lead_status}</span>
                          </div>
                          <div className="truncate text-xs text-slate-500">
                            {lead.product_interest ?? '—'} · {lead.primary_track ?? 'ללא מסלול'}
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-xs text-slate-500">אין לידים. צור אחד ב-/leads.</p>}
            </div>
          ) : null}
          {testError ? <p className="mt-2 text-sm text-rose-600">{testError}</p> : null}
          {testResult ? (
            <div className="mt-3 space-y-1 text-sm">
              <div className={clsx(
                'rounded-md px-3 py-2 font-medium',
                testResult.pass ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-800',
              )}>
                {testResult.pass ? '✓ הכלל יורה — התנאים מתאימים' : '✗ הכלל מדלג — התנאים לא מתאימים'}
              </div>
              {testResult.trace.length > 0 ? (
                <ul className="space-y-1">
                  {testResult.trace.map((t, i) => (
                    <li key={i} className={clsx(
                      'flex items-baseline justify-between gap-2 rounded-md p-1.5 text-xs font-mono',
                      t.pass ? 'bg-emerald-50/60 text-emerald-900' : 'bg-rose-50/60 text-rose-900',
                    )} dir="ltr">
                      <span>{t.field} {t.op} {JSON.stringify(t.expected)}</span>
                      <span className="text-slate-600">{t.pass ? '✓' : `actual=${JSON.stringify(t.actual)}`}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-slate-500">אין תנאים — הכלל יורה תמיד.</p>
              )}
            </div>
          ) : null}
        </details>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="kf-btn" onClick={onCancel}>ביטול</button>
          <button type="submit" className="kf-btn kf-btn-primary" disabled={busy}>{busy ? 'שומר...' : 'שמירה'}</button>
        </div>
      </form>
    </div>
  );
}
