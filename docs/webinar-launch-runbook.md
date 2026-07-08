# Runbook — קמפיין וובינר "הדרך לדירה" + מודול תפוצה

> **עדכון 2026-07-06:** התוכן הזה נכתב לפני שהענף מוזג. המצב היום: הכל
> חי על `master` (PR #44) ופרוס בפרוד; ההפניות ל-`feat/campaign-broadcasts`
> היסטוריות. שלב 0 (תיקון `{{1}}` ב-Meta) עדיין רלוונטי אם טרם בוצע.
> לפריסת תיקוני ה-review שאחרי המיזוג — כולל RLS שחובה להחיל **לפני ייבוא
> רשימת החברים** — ראו [DEPLOY-fixes-post-pr44.md](DEPLOY-fixes-post-pr44.md).

## שלב 0 — תיקון הבוט (חוסם, ~2 דקות, ב-Meta)
הבוט לא עונה בגלל שגיאת Meta `#132000`: תבנית ה-fallback `karnaf_followup_v1`
מוגדרת עם 0 משתנים, אבל הקוד שולח לה משתנה אחד (טקסט התשובה).

1. Meta Business Manager → WhatsApp Manager → Message templates → `karnaf_followup_v1`.
2. הוסף בגוף משתנה `{{1}}` במקום שבו נכנס טקסט התשובה (למשל: `... {{1}}`).
3. שלח לאישור מחדש. ברגע שיאושר — הבוט חוזר לענות וכל הלידים התקועים משתחררים.

> בדיקה: אחרי אישור, שלח הודעת וואטסאפ לבוט ממספר שמחוץ לחלון 24ש → אמור לקבל תשובה.

## שלב 1 — פריסה למערכת החיה
מהשורש, על הענף `feat/campaign-broadcasts`:

```bash
# 1. סכימה: טבלאות תפוצה + נמענים, עמודת priority, כלל האישור, תבניות
supabase db push

# 2. קוד השרת החדש/המעודכן
supabase functions deploy broadcasts broadcast-dispatch dispatch-outbound \
  make-intake leads-intake leads-list leads-manage
```

הדלקת המתזמן האוטומטי של התפוצות (SQL editor):
```sql
alter database postgres set app.broadcast_dispatch_url =
  'https://svkzkpgccahwmyflobvn.supabase.co/functions/v1/broadcast-dispatch';
select vault.create_secret('<בחר-סוד-אקראי>', 'broadcast_dispatch_secret');
```
```bash
supabase secrets set BROADCAST_DISPATCH_SECRET=<אותו-סוד>
```

פרונט: push לענף → Vercel בונה אוטומטית (או `vercel --prod`).

## שלב 2 — webhook רב מסר (תיוג קמפיין)
ברשימת הוובינר ברב מסר, כוון את ה-webhook ל:
```
https://svkzkpgccahwmyflobvn.supabase.co/functions/v1/make-intake?token=<MAKE_INTAKE_KEY>&source=webinar&campaign=launch_webinar_2026
```
(`MAKE_INTAKE_KEY` נמצא ב-`~/.config/karnaf/make_intake_key`.)

## שלב 3 — אימות end-to-end
1. הרשמת בדיקה בדף הנחיתה → בדוק שהליד נכנס עם הקמפיין:
   ```sql
   select full_name, source, source_campaign, created_at
   from leads where created_at > now() - interval '10 min' order by created_at desc;
   ```
2. אותו ליד אמור לקבל וואטסאפ אישור. בדיקה:
   ```sql
   select rule_code, status, created_at from automation_runs
   where rule_code = 'campaign_webinar_launch_confirm' order by created_at desc limit 5;
   ```
3. בעמוד `/broadcasts` → "תפוצה חדשה" → סגמנט `source_campaign = launch_webinar_2026`,
   בחר תבנית `webinar_launch_reminder`, תזמן → בדוק שהאנליטיקה מתמלאת (נשלח→נמסר→נקרא).

## תבניות Meta — התאמה
- `webinar_launch_confirm` — 0 משתנים (טקסט קבוע). הקוד שולח 0. ✅
- `webinar_launch_reminder` — אם קישור הזום הוא `{{1}}`, מלא אותו בטופס התפוצה;
  אם קבוע בטקסט, השאר ריק. מספר המשתנים חייב להתאים (אחרת #132000).

## מה נשאר פתוח (לא חוסם)
- לידי וובינר יופיעו גם בתור "מענה ראשוני" — זה מכוון (ליד חם לטיפול, "אף ליד לא נופל").
- הנוסח ב-CRM (תצוגה מקדימה) עשוי להיות שונה מטקסט תבנית Meta — שלח נוסח מדויק ליישור.
