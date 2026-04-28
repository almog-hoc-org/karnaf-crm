# Karnaf CRM - Open Work Plan

_Last updated: 2026-04-28_

## מצב שאומת בפועל

העותק האמיתי והעדכני של הפרויקט נמצא ב:
`C:\Users\mogi\vs code\karnaf crm\karnaf-crm`

אימות בפועל שבוצע:
- `npm install` ✓
- `npm run typecheck` ✓
- `npm run lint` ✓ (אזהרה ידועה אחת ב-`AuthProvider.tsx`)
- `npm test` ✓ 39/39
- `npm run build` ✓

כלומר, הסיכום שנמסר על מצב המערכת אכן תואם את העותק הזה.

## מסקנת עבודה

הפרויקט deployable ברמת הקוד, אבל עדיין לא "סגור עד הסוף". כעת צריך לעבוד בשני מסלולים במקביל:

1. **Stabilization / polish של מה שכבר נבנה**
2. **Completion של כל הנקודות הפתוחות עד תמונה מלאה**

## חוסמים / פערים שאומתו כרגע

### A. פערים טכניים בתוך הקוד
1. יש בעיית טקסט/encoding בחלק ממסכי ה-frontend
   - עברית מוצגת כ-garbled text בקבצים כמו:
     - `DashboardPage.tsx`
     - `LeadDetailPage.tsx`
     - `UsersPage.tsx`
     - `Layout.tsx`
     - `router.tsx`
     - `format.ts`
   - זה לא חוסם build, אבל כן חוסם איכות מוצר אמיתית
   - זו כרגע המשימה הראשונה שאני ממליץ לטפל בה

2. lint warning יחיד ב-`apps/web/src/auth/AuthProvider.tsx`
   - לא חוסם deploy
   - כדאי לנקות כדי להשאיר קוד מסודר

3. יש הרבה שינויים פתוחים שעדיין לא קיבלו commit מסודר
   - צריך לעבוד בזהירות, בקומיטים קטנים וברורים

### B. דברים שעדיין חסרים לפי המצב המאומת
1. Component tests ל-frontend
2. Playwright E2E
3. Email channel
4. WhatsApp media -> Supabase Storage
5. AI transcript summary אמיתי במקום heuristic
6. Prompt A/B rollout infra
7. i18n abstraction
8. Sentry / Logflare
9. Mobile smoke / polish
10. Accessibility audit
11. Local integration tests עם `supabase start`

### C. תלויות חיצוניות שלא ניתנות לסגירה לבד
1. Supabase credentials
2. Meta WhatsApp / WATI credentials
3. Payment payload sample + secret
4. OpenAI API key
5. Production domain ל-CORS
6. First Mia user details
7. Meta template approval

## סדר עבודה מומלץ

### שלב 1 - ייצוב המוצר הקיים
מטרה: להפוך את הגרסה הנוכחית לנקייה, אמינה, וראויה לפריסה.

משימות:
- לתקן את כל טקסטי העברית/encoding ב-frontend
- לנקות lint warning
- לסקור את המסכים המרכזיים ולוודא שאין פערי UX בולטים
- להכין commit מסודר לכל תיקון

### שלב 2 - איכות ובדיקות frontend
מטרה: להוסיף רשת ביטחון לצד ה-39 tests הקיימים ב-runtime.

משימות:
- להוסיף component tests למסכים הקריטיים:
  - Login
  - Layout/nav/role gating
  - Dashboard
  - Leads
  - Lead detail actions
  - Users permissions
- להקים בסיס Playwright smoke flows:
  - login
  - dashboard loads
  - navigate leads
  - open lead detail
  - admin access rules

### שלב 3 - production hardening משלים
מטרה: להשלים כל מה שדרוש כדי שהמערכת תהיה production-ready מעבר למה שכבר קיים.

משימות:
- Sentry / Logflare init
- Accessibility pass
- Mobile smoke pass
- Local integration harness with Supabase
- Review webhook security / env validation / failure observability

### שלב 4 - feature completion הלא חוסם
מטרה: להשלים את התמונה המלאה של המוצר.

משימות:
- Email channel
- WhatsApp media storage
- AI transcript summary משופר
- Prompt A/B infra
- i18n abstraction

### שלב 5 - external activation
מטרה: לחבר את כל מה שתלוי בהרשאות, סודות ומערכות חיצוניות.

זה יבוצע רק אחרי שאמצה קודם את כל מה שניתן לפתור לבד.

## מה אני עושה עכשיו

אני מתחיל משלב 1, ובפרט:
1. למפות את כל קבצי ה-frontend עם טקסט עברי פגום
2. לתקן את הטקסטים וה-labels
3. לנקות את ה-lint warning
4. להריץ שוב typecheck/lint/test/build
5. לבצע commit מסודר
