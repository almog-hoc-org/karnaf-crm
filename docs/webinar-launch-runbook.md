# Runbook — פריסת קמפיין וובינר "הדרך לדירה" + מודול הודעות תפוצה

צעדי פריסה מדויקים למודול התפוצה ולכלל אישור ההרשמה לוובינר. משלים את
[HANDOFF-campaign-broadcasts.md](HANDOFF-campaign-broadcasts.md).

עודכן: 2026-07-05.

---

## 0. מה מתפרס
מיגרציה אחת (`085_broadcasts.sql`) + פונקציות edge חדשות/מעודכנות:

```bash
supabase db push

supabase functions deploy \
  broadcasts broadcast-dispatch dispatch-outbound \
  leads-intake leads-list
```

> ⚠️ `dispatch-outbound` **כן** נפרס כאן — הוא קיבל נתיב שליחה ישיר חדש
> (`meta_template`). זו תוספת בלבד: נתיב ה-AI (מסירה ל-`orchestrate-message`)
> לא השתנה. **אין** צורך לפרוס `orchestrate-message`.

---

## 1. תבניות Meta — קריטי (#132000)
לכל תבנית: **שם + מספר משתנים חייבים להתאים בדיוק** למה שהקוד שולח, אחרת
`(#132000) number of localizable_params does not match`.

| תבנית | משתנים | מי שולח | הערה |
|---|---|---|---|
| `webinar_launch_confirm` | **0** | כלל המנוע `campaign_webinar_launch_confirm` | הקוד שולח 0 ✅ |
| `webinar_launch_reminder` | 0 או 1 | תפוצה ידנית מ-`/admin/broadcasts` | אם קישור הזום הוא `{{1}}` — מלא בשדה "קישור זום" בטופס. אם קבוע בגוף התבנית — השאר ריק. |

הגש את שתי התבניות ל-Meta בעברית והמתן לאישור (24–72ש).

> באג הפרוד הקיים: תבנית ה-fallback `karnaf_followup_v1` (env
> `WHATSAPP_FALLBACK_TEMPLATE`) אושרה עם 0 משתנים אבל `orchestrate-message`
> שולח לה `{{1}}`. תיקון ב-Meta: הוסף `{{1}}` בגוף התבנית ושלח לאישור מחדש.
> זה נפרד ממודול התפוצה אך משחרר לידי רב מסר תקועים.

---

## 2. Secrets + cron config
מודול התפוצה מונע ע"י cron (`karnaf_broadcast_dispatch`, כל דקה) שפולט ל-worker
`broadcast-dispatch`. שני הצדדים no-op בשקט עד שמוגדרים:

```sql
-- URL של פונקציית ה-worker
alter database postgres set app.broadcast_dispatch_url =
  'https://<project-ref>.supabase.co/functions/v1/broadcast-dispatch';

-- הסוד שה-cron חותם איתו (Bearer)
select vault.create_secret('<random-secret>', 'broadcast_dispatch_secret');
```

```bash
# אותו סוד, כ-env ל-worker כדי שיאמת את הקריאה
supabase secrets set BROADCAST_DISPATCH_SECRET=<random-secret>
```

בדיקה:
```sql
select jobname, schedule from cron.job where jobname = 'karnaf_broadcast_dispatch';
```

---

## 3. חיווט הטופס (רב מסר)
דף הנחיתה `webinar.karnafnadlan.com` צריך לירות ל-`leads-intake` עם סיווג הקמפיין.
הקמפיין נלקח מ-`campaign_name` בגוף ה-JSON **או** מפרמטר ה-query `?campaign=`:

```
POST https://<project-ref>.supabase.co/functions/v1/leads-intake?source=webinar&campaign=launch_webinar_2026
X-Karnaf-Signature: <HMAC של הגוף עם INTAKE_WEBHOOK_SECRET>
{ "full_name": "...", "phone": "..." }
```

- `source=webinar` → תווית "וובינר".
- `campaign=launch_webinar_2026` → `leads.source_campaign` (מפתח הסגמנטציה).
- החתימה מחושבת על **הגוף בלבד**; ה-query הוא מטא-דאטה ולא חלק מהחתימה.

תוצאה: ליד נכנס עם `source_campaign=launch_webinar_2026`, המנוע פולט `lead.created`,
והכלל `campaign_webinar_launch_confirm` שולח הודעת אישור **פעם אחת** (מכבד DNC).

---

## 4. שליחת תזכורת ביום הוובינר
1. `/admin` → "הודעות תפוצה" → **תפוצה חדשה**.
2. סגמנט: קמפיין `launch_webinar_2026` (אפשר להוסיף מקור/מסלול). ה-preview החי
   מראה כמה נמענים זמינים (ללא DNC/מוסרים).
3. תבנית Meta: `webinar_launch_reminder` (+ קישור זום אם התבנית כוללת `{{1}}`).
4. תזמן לעכשיו או לתאריך. `/admin/broadcasts` מציג נשלח→נמסר→נקרא.

---

## 5. אימות אחרי פריסה
1. **קליטה:** הרשמת בדיקה →
   `select source, source_campaign from leads where created_at > now()-interval '10 min';`
   (מצופה `webinar` / `launch_webinar_2026`).
2. **אישור:**
   `select rule_code, status from automation_runs where rule_code='campaign_webinar_launch_confirm' order by created_at desc limit 3;`
   ובדוק `select once_key from engine_template_sends order by created_at desc limit 3;`
3. **אין-כפילות:** הרשמה חוזרת עם אותו טלפון לא שולחת אישור שני (ledger).
4. **תפוצה:** צור תפוצה קטנה → תזמן → ראה `broadcast_recipients` עוברים
   pending→queued→sent, ואת האנליטיקה מתמלאת.
5. **עדיפות:** תפוצה גדולה בזמן שיחת בוט — הבוט (priority 0) מנקז לפני התפוצה
   (priority 10). בדוק `select priority, count(*) from outbound_dispatch where status='pending' group by 1;`

---

## 6. ויסות (rate) למספר וואטסאפ חדש
מספר חדש מוגבל ל-~250–1000 נמענים/יום ע"י Meta. הוויסות בפועל הוא ב-`dispatch-outbound`
(מנקז 10 בדקה, אחרי תעבורת הבוט). ה-UI מציג אזהרה מעל 250 נמענים. לתפוצה גדולה —
המסירה תתפרס על פני יותר מיום; זה תקין.

---

## 7. פתוח
- **מייל (שלב 2):** ערוץ `email` קיים בסכמה אך מנוטרל ב-UI וב-worker.
- **התראת #132000:** אפשר לזהות בקוד שגיאת param-mismatch ולהתריע במקום retry.
