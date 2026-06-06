import clsx from 'clsx';

const demoRows = [
  {
    name: 'דנה כהן', phone: '052-123-4567', action: 'לענות עכשיו', lane: 'reply', time: 'לפני 8 ד׳',
    reason: 'שאלה אם יש ליווי גם למי שקונה דירה ראשונה', status: 'בטיפול שלך', heat: 'חם', priority: 1,
  },
  {
    name: 'אורי לוי', phone: '054-888-0912', action: 'להתקשר', lane: 'call', time: 'לפני 22 ד׳',
    reason: 'ביקש שיחה היום לפני שהוא מקבל החלטה', status: 'צריך שיחה', heat: 'חם', priority: 1,
  },
  {
    name: 'נועה ישראלי', phone: '050-333-2121', action: 'לטפל בסיכון', lane: 'risk', time: 'לפני שעה',
    reason: 'שליחת WhatsApp נכשלה — צריך בדיקה ידנית', status: 'תקלה בשליחה', heat: 'פושר', priority: 1,
  },
  {
    name: 'יואב מזרחי', phone: '058-444-7766', action: 'בדיקה / מעקב', lane: 'ops', time: 'לפני 3 שעות',
    reason: 'מחכה לתשלום אחרי שקיבל קישור רכישה', status: 'ממתין לתשלום', heat: 'חם', priority: 2,
  },
];

const lanes = [
  { key: 'all', label: 'הכל', count: 12, hint: 'כל מה שדורש טיפול' },
  { key: 'reply', label: 'לענות עכשיו', count: 4, hint: 'לקוחות שממתינים למענה אנושי' },
  { key: 'call', label: 'להתקשר', count: 2, hint: 'בקשות שיחה ולידים חמים' },
  { key: 'risk', label: 'בסיכון', count: 3, hint: 'SLA, איחורים ותקלות' },
  { key: 'ops', label: 'תפעול', count: 3, hint: 'בדיקה, תשלום, מעקב וסגירות' },
];

export function ManagerPreviewPage() {
  return (
    <main dir="rtl" className="min-h-screen bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-brand-600 text-white">K</div>
          <div className="font-semibold">Karnaf <span className="text-brand-700">CRM</span><span className="ms-2 rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">Manager Preview</span></div>
          <nav className="ms-auto hidden items-center gap-1 text-sm md:flex">
            {['היום', 'לטיפול עכשיו', 'כל הלידים', 'דוחות'].map((item) => (
              <span key={item} className={clsx('rounded-md px-3 py-1.5 font-medium', item === 'היום' ? 'bg-brand-50 text-brand-700' : 'text-slate-600')}>{item}</span>
            ))}
          </nav>
        </div>
      </header>

      <div className="mx-auto max-w-7xl space-y-5 p-4 sm:p-6">
        <section className="overflow-hidden rounded-3xl bg-gradient-to-l from-brand-700 via-brand-600 to-slate-900 p-5 text-white shadow-sm sm:p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-2">
              <p className="text-sm font-medium text-brand-100">עמדת מנהלת CRM</p>
              <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">לטיפול עכשיו</h1>
              <p className="max-w-2xl text-sm leading-6 text-brand-50/90">
                מקום אחד לכל מה שמצריך פעולה: לקוחות שמחכים לתשובה, שיחות, תקלות, איחורים ומעקבים.
                בלי להבדיל בין Inbox, Queue או סטטוס טכני.
              </p>
            </div>
            <div className="grid grid-cols-3 gap-2 sm:min-w-[360px]">
              <Metric label="פתוח" value="12" />
              <Metric label="דחוף" value="5" danger />
              <Metric label="רענון" value="30ש׳" />
            </div>
          </div>
        </section>

        <section className="overflow-hidden rounded-3xl border border-brand-100 bg-white shadow-sm">
          <div className="grid gap-0 lg:grid-cols-[1.3fr_0.9fr]">
            <div className="bg-gradient-to-l from-brand-50 to-white p-4 sm:p-6">
              <div className="mb-3 inline-flex rounded-full bg-white px-3 py-1 text-xs font-semibold text-brand-700 ring-1 ring-brand-100">🎯 ניהול היום</div>
              <h2 className="text-2xl font-semibold tracking-tight">להתחיל מ-4 לידים שמחכים למענה</h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">המסך הראשי כבר לא רק מספרים. הוא אומר למנהלת איפה להתחיל, למה זה חשוב, ומה הכפתור הבא.</p>
              <div className="mt-4 flex flex-col gap-2 sm:flex-row"><button className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white">לטפל בממתינים למענה</button><button className="rounded-md bg-white px-4 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-200">פתיחת לטיפול עכשיו</button></div>
            </div>
            <div className="border-t border-brand-100 p-4 sm:p-6 lg:border-s lg:border-t-0">
              <h3 className="text-sm font-semibold text-slate-700">הבא בתור</h3>
              <ol className="mt-3 space-y-2 text-sm">
                {demoRows.slice(0, 3).map((row, i) => <li key={row.phone} className="flex items-center gap-3 rounded-xl bg-slate-50 p-3"><span className="grid h-7 w-7 place-items-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700">{i + 1}</span><span className="min-w-0 flex-1"><span className="block truncate font-medium">{row.name}</span><span className="block truncate text-xs text-slate-500">{row.action}</span></span></li>)}
              </ol>
            </div>
          </div>
        </section>

        <section className="grid gap-3 md:grid-cols-5">
          {lanes.map((item) => (
            <div key={item.key} className={clsx('rounded-2xl border p-4 text-start shadow-sm', item.key === 'all' ? 'border-brand-500 bg-brand-50 ring-2 ring-brand-100' : 'border-slate-200 bg-white')}>
              <div className="flex items-center justify-between gap-2">
                <span className={clsx('font-semibold', item.key === 'all' ? 'text-brand-800' : 'text-slate-800')}>{item.label}</span>
                <span className={clsx('rounded-full px-2 py-0.5 text-xs font-semibold', item.key === 'all' ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-600')}>{item.count}</span>
              </div>
              <p className="mt-1 text-xs leading-5 text-slate-500">{item.hint}</p>
            </div>
          ))}
        </section>

        <section className="space-y-3">
          {demoRows.map((row) => (
            <article key={row.phone} className={clsx('rounded-2xl border border-slate-200 border-s-4 bg-white p-4 shadow-sm sm:p-5', borderClass(row.lane))}>
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={clsx('rounded-full px-2.5 py-1 text-xs font-semibold', pillClass(row.lane))}>{row.action}</span>
                    <span className="text-xs text-slate-500">{row.time}</span>
                    {row.priority === 1 ? <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-700">דחוף</span> : null}
                  </div>
                  <div>
                    <div className="text-lg font-semibold text-slate-900">{row.name}</div>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm text-slate-500"><span>{row.phone}</span><span>{row.reason}</span></div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge>{row.status}</Badge><Badge>{row.heat}</Badge><Badge>עדיפות {row.priority}</Badge>
                  </div>
                </div>
                <div className="flex flex-col gap-2 sm:min-w-[220px] sm:flex-row lg:flex-col">
                  <button className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white">פתיחת ליד</button>
                  <button className="rounded-md bg-slate-100 px-4 py-2 text-sm font-medium text-slate-700">סגירת משימה</button>
                </div>
              </div>
            </article>
          ))}
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-brand-700">דוגמה לכל הלידים</p>
              <h2 className="text-2xl font-semibold tracking-tight">רשימת עבודה במקום טבלה</h2>
              <p className="text-sm text-slate-500">גם במסך החיפוש הרחב, כל ליד מסביר מה מצופה מהמנהלת לעשות.</p>
            </div>
            <span className="hidden text-sm text-slate-500 sm:block">128 סה"כ</span>
          </div>
          <div className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-100">
            {demoRows.slice(0, 3).map((row) => (
              <article key={`lead-${row.phone}`} className="bg-white p-4 hover:bg-slate-50/60">
                <div className="grid gap-3 lg:grid-cols-[1fr_220px] lg:items-center">
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2"><span className="text-lg font-semibold text-brand-700">{row.name}</span><span className={clsx('rounded-full px-2.5 py-1 text-xs font-semibold', pillClass(row.lane))}>{row.action}</span><span className="text-xs text-slate-500">עודכן {row.time}</span></div>
                    <p className="text-sm leading-6 text-slate-700">{row.reason}</p>
                    <div className="flex flex-wrap gap-2"><Badge>{row.status}</Badge><Badge>{row.heat}</Badge><Badge>ציון 82</Badge></div>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-1"><button className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white">פתיחת ליד</button><button className="rounded-md bg-white px-4 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-200">חיוג</button><button className="rounded-md bg-slate-50 px-4 py-2 text-sm font-medium text-slate-700">WhatsApp</button></div>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="overflow-hidden rounded-3xl border border-brand-100 bg-white shadow-sm">
          <div className="grid gap-0 lg:grid-cols-[1.2fr_0.8fr]">
            <div className="bg-gradient-to-l from-brand-50 to-white p-4 sm:p-6">
              <div className="mb-3 inline-flex rounded-full bg-white px-3 py-1 text-xs font-semibold text-brand-700 ring-1 ring-brand-100">📊 דוח מנהלת</div>
              <h2 className="text-2xl font-semibold tracking-tight">מה כדאי לעשות לפי הנתונים?</h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">הדוחות מתורגמים להחלטות פשוטות: מה להגדיל, איפה המענה איטי, ואיזה מקור דורש בדיקה.</p>
              <div className="mt-4 grid gap-3 sm:grid-cols-3"><ReportMetric label="המרה כוללת" value="27%" hint="13 סגירות מתוך 48 לידים" /><ReportMetric label="לא נענו" value="4" hint="לידים בלי מענה ראשון" danger /><ReportMetric label="מקורות פעילים" value="5" hint="ערוצים עם נתונים" /></div>
            </div>
            <div className="space-y-2 border-t border-brand-100 p-4 sm:p-6 lg:border-s lg:border-t-0">
              <ReportAction title="להגדיל את webinar" detail="30% המרה ו-3 סגירות. זה מקור שכדאי להמשיך להזרים אליו תקציב/קשב." tone="emerald" />
              <ReportAction title="לקצר מענה ב-facebook_ads" detail="p90 מענה ראשון: 4 שעות. כאן מתחילים אם רוצים לא לאבד לידים." tone="amber" />
              <ReportAction title="לבדוק איכות ב-organic" detail="נפח טוב אבל המרה נמוכה. לבדוק מסר, קהל ואיכות לידים." tone="rose" />
            </div>
          </div>
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-brand-700">דוגמה לעמוד ליד</p>
              <h2 className="text-2xl font-semibold tracking-tight">דנה כהן</h2>
              <p className="text-sm text-slate-500">כך נראה הכיוון החדש בתוך ליד: החלטה ברורה לפני כל המידע הטכני.</p>
            </div>
            <div className="hidden rounded-full bg-sky-50 px-3 py-1 text-sm font-medium text-sky-800 sm:block">AI מטפל</div>
          </div>
          <div className="rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sky-950">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <div className="mb-2 flex flex-wrap gap-2"><span className="rounded-full bg-white/75 px-2.5 py-1 text-xs font-semibold">הפעולה הבאה</span><span className="text-xs font-medium opacity-75">AI פעיל</span></div>
                <h3 className="text-xl font-semibold">ה-AI מטפל — רק לעקוב</h3>
                <p className="mt-1 max-w-3xl text-sm leading-6 opacity-85">אין צורך להתערב כרגע. אם מזהים שיחה רגישה, אפשר לקחת לטיפול אנושי בלחיצה.</p>
              </div>
              <div className="grid gap-2 sm:min-w-[220px]"><button className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white">לקחת לטיפול</button><button className="rounded-md bg-white px-4 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-200">פתיחה ב-WhatsApp</button></div>
            </div>
          </div>
          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <div className="rounded-2xl bg-slate-50 p-4 lg:col-span-2">
              <div className="font-semibold">שיחה</div>
              <div className="mt-3 space-y-2 text-sm"><div className="mr-auto max-w-[80%] rounded-2xl bg-white p-3 shadow-sm">שלום, אשמח להבין אם זה מתאים לי.</div><div className="ms-auto max-w-[80%] rounded-2xl bg-brand-50 p-3 shadow-sm">היי דנה, בשמחה. מה המטרה שלך — דירה ראשונה או השקעה?</div></div>
            </div>
            <div className="rounded-2xl bg-slate-50 p-4">
              <div className="font-semibold">סיכום קצר</div>
              <dl className="mt-3 space-y-2 text-sm"><div><dt className="text-slate-500">מטרה</dt><dd>דירה ראשונה</dd></div><div><dt className="text-slate-500">חסם</dt><dd>לא בטוחה בתקציב ובתהליך</dd></div><div><dt className="text-slate-500">המלצה</dt><dd>לתת ל-AI להמשיך עוד שאלה אחת ואז להציע שיחה.</dd></div></dl>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

function Metric({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return <div className="rounded-2xl bg-white/12 p-3 ring-1 ring-white/20"><div className="text-xs text-white/75">{label}</div><div className={clsx('mt-1 text-2xl font-semibold', danger && 'text-rose-100')}>{value}</div></div>;
}
function ReportMetric({ label, value, hint, danger }: { label: string; value: string; hint: string; danger?: boolean }) {
  return <div className="rounded-2xl bg-white p-3 shadow-sm ring-1 ring-slate-100"><div className="text-xs text-slate-500">{label}</div><div className={clsx('mt-1 text-3xl font-semibold tabular-nums', danger ? 'text-rose-700' : 'text-slate-950')}>{value}</div><div className="mt-1 text-xs text-slate-500">{hint}</div></div>;
}
function ReportAction({ title, detail, tone }: { title: string; detail: string; tone: 'emerald' | 'amber' | 'rose' }) {
  const cls = tone === 'emerald' ? 'border-emerald-200 bg-emerald-50 text-emerald-950' : tone === 'amber' ? 'border-amber-200 bg-amber-50 text-amber-950' : 'border-rose-200 bg-rose-50 text-rose-950';
  return <div className={clsx('rounded-2xl border p-3', cls)}><div className="text-sm font-semibold">{title}</div><p className="mt-1 text-xs leading-5 opacity-80">{detail}</p></div>;
}
function Badge({ children }: { children: React.ReactNode }) { return <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">{children}</span>; }
function pillClass(lane: string) { return lane === 'reply' ? 'bg-amber-100 text-amber-800' : lane === 'call' ? 'bg-indigo-100 text-indigo-800' : lane === 'risk' ? 'bg-rose-100 text-rose-800' : 'bg-sky-100 text-sky-800'; }
function borderClass(lane: string) { return lane === 'reply' ? 'border-s-amber-400' : lane === 'call' ? 'border-s-indigo-400' : lane === 'risk' ? 'border-s-rose-500' : 'border-s-sky-400'; }
