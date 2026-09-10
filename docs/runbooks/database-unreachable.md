# תקלה: מסד הנתונים לא נגיש

**נצפה לראשונה: 2026-09-04, בסביבות 16:20 UTC. פעיל בזמן כתיבת המסמך.**

## התסמין

קריאות SQL דרך ה-Management API נכשלות עם:

```
HTTP 544 — Failed to run sql query: Connection terminated due to connection timeout
```

לא באופן קבוע. חלק מהשאילתות עוברות, רובן לא, ואותה שאילתה בדיוק יכולה
להצליח בניסיון אחד ולהיכשל בארבעה. בהרצת אבחון של 14 שאילתות ב-16:23,
שמונה נכשלו. בהרצה של חמש שאילתות ב-17:07, **כולן** נכשלו — 20 ניסיונות
רצופים על פני 14 דקות.

## למה זה חשוב מעבר לאבחון

זה מסביר סימנים שנראו כמו באגים נפרדים:

1. **`system_heartbeats` תקועים.** `sla_worker` דיווח לאחרונה ב-11:30 למרות
   קרון כל 10 דקות; `automation_tick` ב-11:30; `ai_watchdog` ב-13:06 למרות
   קרון כל 5 דקות. העובדים לא "מתו" — הם לא הצליחו לכתוב.
2. **`net._http_response` מכיל שורות עם `status_code: null` ו-`content: null`.**
   זה אומר ש-pg_net שלח בקשה ומעולם לא קיבל תשובה. כל קרון שקורא ל-edge
   function דרך `net.http_post` — כלומר כולם — נמצא במצב הזה.
3. **פריסה נכשלה באמצע רשימת המיגרציות** לפני שהוספנו retry.

## מה זה לא

זה **לא** מסביר את השקט בקליטה מאז 2026-08-27. הפער הזה קדם לתקלה הזו
בשבוע. שתי בעיות נפרדות שקרו להיפגש.

## איפה לבדוק (דורש גישה לדשבורד)

1. **דיסק** — <https://supabase.com/dashboard/project/svkzkpgccahwmyflobvn/reports/database>
   Postgres שנגמר לו המקום מפסיק לקבל חיבורים. זה החשוד הראשון: הטבלאות
   `lead_events` ו-`activities` צברו עשרות אלפי שורות רעש מכונה (ראו
   מיגרציה 123). **שימו לב:** `delete` ב-Postgres לא משחרר דיסק בלי
   `vacuum` — ואפילו מגדיל זמנית את ה-WAL. אם הדיסק היה על הגבול, מיגרציה
   123 (שהורצה ב-17:04) עלולה הייתה להחמיר את המצב זמנית, גם אם התקלה
   התחילה לפניה.
2. **חיבורים** — אותו דף, לשונית Connection pooler. מיצוי מכסת החיבורים
   נותן בדיוק את השגיאה הזו.
3. **גודל ה-compute** — Project Settings → Compute and Disk. מופע קטן מדי
   מול הנפח שנצבר.
4. **Logs** — <https://supabase.com/dashboard/project/svkzkpgccahwmyflobvn/logs/postgres-logs>

## תיקון

- **דיסק מלא**: הגדלת הדיסק, ואז `vacuum (full, analyze) lead_events;`
  ו-`vacuum (full, analyze) activities;` (נועל את הטבלה — להריץ מחוץ לשעות
  פעילות).
- **מיצוי חיבורים**: הגדלת ה-pool או ה-compute; לזהות מי מחזיק חיבורים עם
  `select * from pg_stat_activity order by query_start;`
- **compute קטן מדי**: שדרוג מדרגה.

## אחרי שזה נפתר

1. להריץ מחדש את **Deploy Supabase** — יש פונקציות שנכתבו אחרי הפריסה
   האחרונה שהצליחה (`ops-status`, וכל השאר בענף).
2. לפתוח את **/admin/status** — המסך החדש שאמור לענות על השאלה הזו מעכשיו
   בלי חפירה בלוגים.
3. לוודא ש-`system_heartbeats` מתעדכנים שוב (אמורים להיות בני דקות).
4. להריץ את הדוח היבש של מנוע הזמן לפני שמדליקים כללי אוטומציה.


## עדכון 2026-09-06 — התקלה עדיין פעילה, והתמונה חדה יותר

מדידה ב-06:16–07:03 UTC, אחרי שהבעלים דיווח שטיפל בדיסק/חיבורים:

| ממצא | ראיה |
|---|---|
| כל העובדים עצרו ב-**02:30 UTC** | `system_heartbeats`: sla_worker 02:30, automation_tick 02:30, ai_watchdog 02:35 |
| pg_net לא מוסר בקשות | `net.http_request_queue` = 13 ממתינות, 0 נענו ב-5 דקות; `net._http_response` עם `status_code null` |
| אפילו `net.worker_restart()` נכשל | 5 ניסיונות, כולם 544 |
| `cron.job_run_details` לא נגיש | כל שאילתה עליו — 544; ניקוי במיגרציה 125 מת על statement_timeout |
| טבלאות קטנות עונות | heartbeats, operator_alerts, automation_rules — בניסיון ראשון או שני |

**מסקנה:** זה לא דיסק בלבד ולא שאילתה איטית אחת. עובד הרקע של pg_net תקוע,
pg_cron כנראה ממשיך לתזמן, והפולר של החיבורים מסרב לסירוגין. אין דרך לתקן את
זה דרך ה-Management API — כל ניסיון תיקון עצמו נופל על אותה תקלה.

### הפעולה היחידה שנשארה — Restart Project

👉 <https://supabase.com/dashboard/project/svkzkpgccahwmyflobvn/settings/general>
→ **Restart project** (בתחתית, קטע Danger zone / Restart).

זה מפעיל מחדש את Postgres ואת עובדי הרקע (pg_net, pg_cron) — בדיוק מה שתקוע.
לוקח 1–3 דקות; האפליקציה לא זמינה בזמן הזה. אין אובדן נתונים.

### אחרי ה-restart, בסדר הזה
1. להריץ את ה-workflow `ops-skipped-leads.yml` — הוא מתזמן ניקוי של
   `cron.job_run_details` מבפנים (`karnaf_drain_cron_history_once`, 20k
   שורות בדקה) ומריץ `net.worker_restart()` ליתר ביטחון.
2. לוודא ב-`system_heartbeats` שהעובדים חזרו לכתוב (דקות, לא שעות).
3. כשהניקוי סיים (`select count(*) from cron.job_run_details` קטן) —
   `select cron.unschedule('karnaf_drain_cron_history_once')` ולהריץ Deploy
   כדי ש-125 ייצור את האינדקס.
4. רק אז: אימות ערוצי ההתראה (ה-ledger יראה תוצאה לכל ערוץ מהטיק הבא),
   תשובת Meta ב-`net._http_response`, והדוח היבש.
