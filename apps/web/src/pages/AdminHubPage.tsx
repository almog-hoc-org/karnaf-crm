import { Link } from 'react-router-dom';
import { useDocumentTitle } from '@/lib/useDocumentTitle';

// Tier 5 — single landing surface for everything that used to flood
// the top nav. Pages still live at their own URLs; this is just a
// curated map organised by what an admin actually does, not by what
// each table is called.
//
// Three sections:
//   1. People + projects — the entities Mia talks about every week.
//   2. Communication + automation — how outbound conversations work.
//   3. System config — touched once a quarter when something breaks.

interface HubLink {
  to: string;
  title: string;
  blurb: string;
}

interface HubSection {
  title: string;
  hint: string;
  links: HubLink[];
}

const SECTIONS: HubSection[] = [
  {
    title: 'אנשים, פרויקטים וכסף',
    hint: 'מי השותפים, מה הפרויקטים שלהם, ואיזה עמלות עברו',
    links: [
      { to: '/partners',     title: 'שותפים',          blurb: 'רשימת פרילנסרים, אחוז עמלה לקרנף, פעיל/מושהה/בארכיון' },
      { to: '/projects',     title: 'פרויקטים',        blurb: 'פרויקטי פריסייל, אחוז גיוס, סטטוס וערכי יעד' },
      { to: '/commissions',  title: 'עמלות',           blurb: 'יומן עמלות לתשלום, סימון תשלום, ביטול' },
      { to: '/team',         title: 'צוות',            blurb: 'הרשאות וצוות פעיל ב-CRM' },
    ],
  },
  {
    title: 'תקשורת ואוטומציה',
    hint: 'מה נשלח ללקוחות, ומה נשלח מעצמו',
    links: [
      { to: '/templates',     title: 'תבניות הודעה',    blurb: '16 התבניות מהמסמך + תצוגה מקדימה + הוצאה משימוש' },
      { to: '/admin/broadcasts', title: 'הודעות תפוצה', blurb: 'שליחת תבנית מאושרת לסגמנט לידים מסונן + אנליטיקת מסירה' },
      { to: '/automations',   title: 'מנוע אוטומציה',  blurb: 'קטלוג כל הכללים + יומן הרצות + עריכת DSL' },
      { to: '/journeys',      title: 'מסעות לקוח',     blurb: 'רצפים אוטומטיים: program 14-day, investor 21-day, retention' },
      { to: '/prompts',       title: 'AI Prompts',     blurb: 'גרסאות prompt לבוט החכם + ניסויי A/B' },
    ],
  },
  {
    title: 'ניתוחים והתבוננות',
    hint: 'מה קורה במערכת ברמת מקור / צוות / זמן',
    links: [
      { to: '/analytics',     title: 'ניתוחים',        blurb: 'מקורות לידים, אחוזי המרה, השוואת AI/אנושי, קוהורטות' },
      { to: '/queue',         title: 'תור פתוח',       blurb: 'משימות SLA + הסלמות שמחכות למענה' },
    ],
  },
  {
    title: 'הגדרות מערכת',
    hint: 'נוגעים פעם ברבעון. רוב הזמן אפשר להתעלם',
    links: [
      { to: '/admin/sources',         title: 'מקורות לידים',     blurb: 'איזה ערוצים מותרים להזין לידים' },
      { to: '/admin/whatsapp-router', title: 'WhatsApp Router',  blurb: 'תפריט הסינון של הבוט בכניסה' },
      { to: '/admin/settings',        title: 'הגדרות',           blurb: 'שעות פעילות, SLA, רכיב AI פעיל' },
      { to: '/users',                 title: 'משתמשים',          blurb: 'יוזרים והרשאות כלל-מערכת' },
    ],
  },
];

export function AdminHubPage() {
  useDocumentTitle('ניהול');
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">ניהול</h1>
        <p className="mt-1 text-sm text-slate-500">
          הכל שלא ב-״לידים״ או ב-״היום שלי״. הקבוצות מסודרות לפי תדירות שימוש —
          הראשונה כל שבוע, האחרונה פעם ברבעון.
        </p>
      </header>

      {SECTIONS.map((section) => (
        <section key={section.title} className="space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold">{section.title}</h2>
            <p className="text-xs text-slate-500">{section.hint}</p>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {section.links.map((link) => (
              <Link
                key={link.to}
                to={link.to}
                className="kf-card group p-3 transition hover:border-brand-300 hover:shadow-sm"
              >
                <h3 className="font-medium text-slate-900 group-hover:text-brand-700">{link.title}</h3>
                <p className="mt-1 text-xs text-slate-500">{link.blurb}</p>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
