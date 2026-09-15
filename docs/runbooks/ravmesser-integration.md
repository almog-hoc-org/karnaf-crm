# חיבור רב מסר (Responder) ↔ Karnaf CRM

## כיוון 1: לידים מרב מסר → המערכת (inbound)

רב מסר שולח webhook בכל נמען חדש (או מצעד אוטומציה), והמערכת קולטת ליד.

### הגדרה ברב מסר
1. **ברמת רשימה**: הגדרות רשימה → Webhooks → "נמען חדש הצטרף" → הוספת webhook.
   **או ברמת אוטומציה**: עורך האוטומציה → אלמנט "שליחת וובהוק".
2. כתובת ה-webhook:
   ```
   https://svkzkpgccahwmyflobvn.supabase.co/functions/v1/leads-intake?token=<INTAKE_STATIC_TOKEN>&source=responder_form&contract_key=ravmesser_new_subscriber_v1
   ```
   את ערך ה-token מקבלים מהגדרות הסביבה (Supabase secrets → `INTAKE_STATIC_TOKEN`).
3. מיפוי שדות בעורך של רב מסר — שמות השדות שהמערכת מזהה:

   | שדה ברב מסר | שם השדה ב-webhook |
   |---|---|
   | שם | `NAME` (או `full_name` / `שם`) |
   | אימייל | `EMAIL` (או `email` / `אימייל`) |
   | טלפון | `PHONE` (או `phone` / `טלפון`) |
   | שם רשימה/קמפיין | `list_name` |

   סוג השליחה: JSON או Form — שניהם נתמכים.

### בדיקה
הרשמת כתובת בדיקה לרשימה → תוך שניות ליד חדש מופיע ב-CRM עם מקור "רב מסר — טופס/אוטומציה" ותגיות `ravmesser, email_list`. אם הליד כבר קיים (לפי טלפון/אימייל) — הרשומה מתעדכנת, לא נוצרת כפילות.

### אבטחה
- ה-token ב-URL מוגבל למקור `responder_form` בלבד — URL שדלף לא יכול להזרים לידים ממקור אחר.
- החלפת token: עדכון `INTAKE_STATIC_TOKEN` ב-Supabase secrets + עדכון ה-URL ברב מסר.

## כיוון 2: מהמערכת → רשימת דיוור ברב מסר (outbound)

המערכת מוסיפה ליד כנמען לרשימה ברב מסר; אוטומציית הדיוור של רב מסר ממשיכה משם.

### דרישות
4 מפתחות API מתמיכת רב מסר (03-717-7777 / support@responder.co.il), נשמרים כ-Supabase secrets:
`RAVMESSER_C_KEY`, `RAVMESSER_C_SECRET`, `RAVMESSER_U_KEY`, `RAVMESSER_U_SECRET`.

👉 איפה מדביקים: <https://supabase.com/dashboard/project/svkzkpgccahwmyflobvn/settings/functions> → **Add new secret**, ארבע פעמים, בשמות המדויקים למעלה. **בלי הסודות האלה כל תפוצת מייל נכשלת בשנייה שהיא מתחילה** (זה מה שקרה ב-14.9: "ravmesser not configured"). מ-15.9 המערכת מסרבת לתזמן תפוצת מייל כשהם חסרים, ומציגה את הסיבה על הכרטיס.

### הפעלה
1. במסך **ניהול → אוטומציות** יש כלל מוכן: **"הוספה לרשימת דיוור (רב מסר)"** (כבוי כברירת מחדל).
2. עורכים את ה-actions: מחליפים `REPLACE_WITH_RAVMESSER_LIST_ID` ב-ID האמיתי של הרשימה (מופיע ב-URL של הרשימה ברב מסר).
3. מדליקים את הכלל.

### התנהגות
- ליד בלי אימייל / עם `do_not_contact` / שסירב לדיוור (`consent_email=false`) — מדולג, לא נשלח.
- ליד שכבר נוסף לאותה רשימה — מדולג (רישום ב-lead_events).
- אפשר להשתמש בפעולה `add_to_email_list` גם בצעדי journey ובכללים נוספים — פרמטרים: `list_id` (חובה), `list_name` (לתצוגה).

## כיוון 3: הסרה מרשימה ברב מסר → ביטול הסכמה במערכת (unsubscribe sync)

מי שלוחץ "הסר" בתחתית מייל של רב מסר יוצא מהרשימה שם, אבל המערכת לא יודעת על זה לבד. כדי שגם `consent_email` יתעדכן:

1. ברב מסר: **אוטומציות → הסרה מרשימה → Webhook** (או "פעולה בעת הסרה" ברשימה).
2. כתובת ה-Webhook (POST):
   `https://svkzkpgccahwmyflobvn.supabase.co/functions/v1/leads-intake?token=<INTAKE_STATIC_TOKEN>&source=responder_form&contract_key=ravmesser_unsubscribe_v1`
3. שדות: `EMAIL` (חובה), אפשר גם `NAME`, `PHONE`, `list_name`.
4. המערכת מאתרת את הליד לפי המייל (או הטלפון), מסמנת `consent_email=false` ורושמת אירוע "אישור דיוור בוטל" בציר הזמן. ליד לא מוכר — לא נוצר, לא נכשל.

בדיקה: הסר כתובת בדיקה מרשימה ברב מסר → במסך הליד "הסכמת מייל: לא".
