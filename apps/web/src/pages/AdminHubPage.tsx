import { Link } from 'react-router-dom';
import { isAdminRole, useAuth } from '@/auth/auth-context';
import { useDocumentTitle } from '@/lib/useDocumentTitle';

// "עוד" — everything that isn't היום / לקוחות / דיוור. Pages keep their own
// URLs; this is a curated map grouped by what the owner is trying to do,
// most-used first. Open to managers; admin-only cards are hidden from them
// instead of leading to a 🔒 page.

interface HubLink {
  to: string;
  title: string;
  blurb: string;
  adminOnly?: boolean;
}

interface HubSection {
  title: string;
  hint: string;
  links: HubLink[];
}

const SECTIONS: HubSection[] = [
  {
    title: 'העסק',
    hint: 'מה קורה במכירות, מאיפה מגיעים הלקוחות, וכמה כסף נכנס',
    links: [
      { to: '/dashboard',   title: 'מצב העסק',   blurb: 'לידים היום, לידים חמים, ממתינים לתשלום, משפך המכירה ובריאות המקורות' },
      { to: '/reports',     title: 'דוחות',       blurb: 'עמלות, פרויקטים בגיוס ושימור לקוחות בתוכנית' },
      { to: '/analytics',   title: 'ניתוחים',     blurb: 'איזה מקור וקמפיין מביאים לקוחות, מהירות מענה, בוט מול טיפול אישי' },
      { to: '/projects',    title: 'פרויקטים',    blurb: 'פרויקטי פריסייל, כמה גויס ומה היעד' },
      { to: '/partners',    title: 'שותפים',      blurb: 'אנשי המקצוע שעובדים איתנו ואחוז העמלה של כל אחד' },
      { to: '/commissions', title: 'עמלות',       blurb: 'עמלות שמגיעות לנו, סימון כשולם או ביטול' },
    ],
  },
  {
    title: 'דיוור ואוטומציה',
    hint: 'מה נשלח ללקוחות, ומה נשלח מעצמו',
    links: [
      { to: '/broadcasts',  title: 'דיוור',          blurb: 'שליחת וואטסאפ או מייל לקבוצת לקוחות, ותוצאות כל שליחה' },
      { to: '/templates',   title: 'תבניות הודעה',   blurb: 'נוסחי ההודעות הקבועים, תצוגה מקדימה וסטטוס אישור מול מטא' },
      { to: '/automations', title: 'אוטומציות',      blurb: 'מה המערכת עושה מעצמה, מתי, ומה קרה בכל הפעלה' },
      { to: '/journeys',    title: 'מסעות לקוח',     blurb: 'רצפי הודעות אוטומטיים לאורך כמה ימים' },
      { to: '/prompts',     title: 'תסריטי הבוט',    blurb: 'הנוסח שהבוט החכם עובד איתו, וניסויים בין גרסאות', adminOnly: true },
    ],
  },
  {
    title: 'עבודה וצוות',
    hint: 'מי עובד במערכת ומה עוד פתוח',
    links: [
      { to: '/queue', title: 'כל המשימות הפתוחות', blurb: 'רשימה מלאה של משימות לפי סוג — כשצריך יותר מ״היום״' },
      { to: '/team',  title: 'צוות',               blurb: 'מי מטפל בכמה לקוחות עכשיו' },
      { to: '/users', title: 'משתמשים והרשאות',     blurb: 'הוספת משתמש, שינוי תפקיד, השבתה', adminOnly: true },
    ],
  },
  {
    title: 'הגדרות מערכת',
    hint: 'נוגעים לעיתים רחוקות — בדרך כלל כשמשהו משתנה או נשבר',
    links: [
      { to: '/admin/status',          title: 'מצב המערכת',      blurb: 'האם הקליטה עובדת, האם ההתראות מוגדרות, מתי כל תהליך רץ לאחרונה', adminOnly: true },
      { to: '/admin/settings',        title: 'הגדרות',          blurb: 'שעות פעילות, זמני מעקב, ערוץ מייל, מה לבוט אסור להגיד', adminOnly: true },
      { to: '/admin/sources',         title: 'מקורות לידים',    blurb: 'מאילו ערוצים מגיעים לקוחות ואיך כל אחד מחובר', adminOnly: true },
      { to: '/admin/landing-pages',   title: 'דפי נחיתה',       blurb: 'דפים ציבוריים שמכניסים לקוחות עם שם הקמפיין', adminOnly: true },
      { to: '/admin/whatsapp-router', title: 'תפריט הבוט בוואטסאפ', blurb: 'האפשרויות שלקוח חדש רואה בהודעה הראשונה', adminOnly: true },
    ],
  },
];

export function AdminHubPage() {
  useDocumentTitle('עוד');
  const auth = useAuth();
  const isAdmin = isAdminRole(auth.role);
  const sections = SECTIONS
    .map((section) => ({ ...section, links: section.links.filter((l) => !l.adminOnly || isAdmin) }))
    .filter((section) => section.links.length > 0);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">עוד</h1>
        <p className="mt-1 text-sm text-slate-500">
          כל מה שלא ב״היום״, ב״לקוחות״ או ב״דיוור״ — מסודר מהשימושי ביותר לנדיר ביותר.
        </p>
      </header>

      {sections.map((section) => (
        <section key={section.title} className="space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-x-2">
            <h2 className="text-lg font-semibold">{section.title}</h2>
            <p className="text-xs text-slate-500">{section.hint}</p>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {section.links.map((link) => (
              <Link
                key={link.to}
                to={link.to}
                className="kf-pressable kf-pressable-subtle kf-card group p-3 transition hover:border-brand-300 hover:shadow-sm"
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
