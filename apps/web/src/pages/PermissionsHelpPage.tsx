import { useDocumentTitle } from '@/lib/useDocumentTitle';

interface Row {
  feature: string;
  owner: boolean;
  admin: boolean;
  mia: boolean;
  sales_rep: boolean;
  viewer: boolean;
}

const MATRIX: Row[] = [
  { feature: 'צפייה בלידים', owner: true, admin: true, mia: true, sales_rep: true, viewer: true },
  { feature: 'שליחת תשובה ידנית', owner: true, admin: true, mia: true, sales_rep: true, viewer: false },
  { feature: 'תיעוד שיחת טלפון', owner: true, admin: true, mia: true, sales_rep: true, viewer: false },
  { feature: 'עריכת context בסייד-בר', owner: true, admin: true, mia: true, sales_rep: false, viewer: false },
  { feature: 'סימון won / lost / DNC', owner: true, admin: true, mia: true, sales_rep: false, viewer: false },
  { feature: 'העברה לנציג / החזרה ל-AI', owner: true, admin: true, mia: true, sales_rep: false, viewer: false },
  { feature: 'סגירת פריט תור', owner: true, admin: true, mia: true, sales_rep: true, viewer: false },
  { feature: 'ניהול משתמשים', owner: true, admin: true, mia: false, sales_rep: false, viewer: false },
  { feature: 'עריכת prompt variants', owner: true, admin: true, mia: false, sales_rep: false, viewer: false },
  { feature: 'ביטול חשבון בעלים', owner: true, admin: false, mia: false, sales_rep: false, viewer: false },
];

function Cell({ value }: { value: boolean }) {
  return value ? (
    <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-xs text-emerald-700" aria-label="כן">✓</span>
  ) : (
    <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-rose-50 text-xs text-rose-600" aria-label="לא">×</span>
  );
}

export function PermissionsHelpPage() {
  useDocumentTitle('מטריצת הרשאות');
  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">מטריצת הרשאות</h1>
        <p className="mt-1 text-sm text-slate-500">מה כל תפקיד יכול לעשות במערכת.</p>
      </header>

      <div className="kf-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="kf-table min-w-[40rem]">
            <thead>
              <tr>
                <th scope="col">פעולה</th>
                <th scope="col">owner</th>
                <th scope="col">admin</th>
                <th scope="col">mia</th>
                <th scope="col">sales_rep</th>
                <th scope="col">viewer</th>
              </tr>
            </thead>
            <tbody>
              {MATRIX.map((row) => (
                <tr key={row.feature}>
                  <td><strong>{row.feature}</strong></td>
                  <td><Cell value={row.owner} /></td>
                  <td><Cell value={row.admin} /></td>
                  <td><Cell value={row.mia} /></td>
                  <td><Cell value={row.sales_rep} /></td>
                  <td><Cell value={row.viewer} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="text-sm text-slate-600">
        <p>שאלות / בקשה לשינוי הרשאות → פנה למנהל החשבון.</p>
        <p>מדריך מפעיל מלא: <code className="rounded bg-slate-100 px-1 py-0.5">docs/operator-guide.md</code></p>
      </div>
    </div>
  );
}
