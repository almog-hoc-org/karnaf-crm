import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { fetchAutomations, postAutomationToggle } from '@/lib/api';
import type { AutomationRuleRow, AutomationRunRow, AutomationSource } from '@/lib/types';
import { useToast } from '@/components/Toast';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { formatRelative } from '@/lib/format';
import { t } from '@/lib/i18n';

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

      <p className="text-sm text-slate-500">
        קטלוג כל האוטומציות במערכת + יומן הרצות אחרון. כללים מסומנים "בקוד" רצים
        מעמדות לוגיקה קיימות (sla-worker, daily-sales-inbox, triggers); "במנוע"
        ירוצו מהמנוע ההגדרתי שעדיין נבנה; "בתכנון" הם כללים מהמפרט שעוד לא מומשו.
      </p>

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
