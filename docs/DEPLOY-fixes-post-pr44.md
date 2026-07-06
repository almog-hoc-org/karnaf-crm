# פריסת תיקוני post-PR#44 — צ'קליסט (מריצים מהמחשב עם הטוקן)

תיקונים בעקבות ה-review של PR #44: RLS על 16 טבלאות חשופות, שלושה תיקוני
"בוט שותק", אנליטיקת תפוצות אמינה, סגמנט multi-slug, השבת `?campaign=`,
אטימת ig-webhook, ו-config.toml מלא. פירוט מלא ב-PR.

הטוקן: `~/.config/karnaf/supabase.env`. כל הפקודות מריצים מ-root הריפו על
`master` **אחרי** מיזוג ה-PR.

---

## 1. סכימה — מיגרציה 093 (RLS)

```bash
supabase db push
```

מוסיפה RLS ל-16 טבלאות (כולל `program_members`, `deals`, `outbound_dispatch`).
אימות:

```sql
select relname from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
-- מצופה: 0 שורות
```

## 2. פונקציות edge שהשתנו

```bash
supabase functions deploy \
  orchestrate-message dispatch-outbound broadcast-dispatch \
  provider-status-webhook leads-intake leads-manage \
  provision-student ig-webhook broadcasts
```

> `orchestrate-message` הפעם **כן** נפרס — master הוא מקור האמת (אין יותר
> ענף tier-a נפרד), והתיקון של already_answered חי בו.
>
> `config.toml` המעודכן קובע `verify_jwt` לכל 53 הפונקציות — כולל 6 שהיו
> נשברות בפריסה נקייה (ig-webhook, fb-leadgen-webhook, ai-replay,
> ai-watchdog, internal-send-reply, provision-student). אין יותר צורך
> ב-`--no-verify-jwt` ידני.

פרונט: מיזוג ל-master → Vercel בונה אוטומטית.

## 3. ⚠️ ייבוא רשימת החברים — רק עכשיו

אחרי ש-093 חלה (שלב 1), רשימת החברים כבר לא קריאה דרך ה-anon key.
עכשיו מותר: עמוד לידים → "ייבוא רשימה" → ✓ "סמן את כולם כחברי תוכנית".

בדיקת אבטחה (אופציונלי, עם ה-anon key מהבאנדל):
```bash
curl -s "https://<project-ref>.supabase.co/rest/v1/program_members?select=*" \
  -H "apikey: <ANON_KEY>" -H "Authorization: Bearer <ANON_KEY>"
# מצופה: [] (ולא רשימת החברים)
```

## 4. Backfill מיגרציות 085-089 מפרוד (חוב תשתית — חד-פעמי)

פרוד מכיל `085_prompt_variant_rpc_alignment` … `089_lead_journey_manager`
שנפרסו מחוץ לריפו וה-SQL שלהן לא קיים על אף ענף. עד שהן בריפו, הריפו אינו
מקור אמת לסכימה ו-`db reset`/`db push` מסביבה נקייה לא ישחזרו את פרוד.

```bash
supabase migration list   # מה חל בפרוד
supabase db pull          # משיכת הפער לקבצים
```
לבדוק את הקבצים שנוצרו, למספר 085-089 כפי שנרשמו בפרוד, ולעשות commit.

באותה הזדמנות — אימות חד-פעמי שסכימת פרוד תואמת את הקוד:
```sql
select column_name from information_schema.columns
 where table_name = 'engine_template_sends';
-- מצופה: id, lead_id, template_key, channel, created_at...
select column_name from information_schema.columns
 where table_name = 'broadcast_recipients';
-- מצופה בין השאר: status, dispatch_id, message_id, sent_at, error
```

## 5. Smoke חוזר (אחרי הפריסה)

בנוסף לצעדי ה-smoke מהמייל של המפתח:

1. **תפוצה multi-slug:** `/broadcasts` → תפוצה חדשה → מקור "אתר" → ה-preview
   צריך לכלול לידים מ-website + landing_page + services_page (לא רק אחד).
2. **אנליטיקה:** אחרי תפוצה קטנה — "נשלחו" ≤ "נמענים" (בלי ספירה כפולה),
   ותפוצה שכולה נכשלה מסומנת "נכשל", לא "נשלח".
3. **`?campaign=`:** הרשמת בדיקה דרך ה-webhook →
   `select source_campaign from leads order by created_at desc limit 1;`
   מצופה `launch_webinar_2026`.
4. **קונסיירז' בכשל** (בסביבת פיתוח): כשל שליחה לחבר → פריט תור
   `failed_automation` נוצר ולא נחתמת greeted.

## 6. משימה עתידית — איחוד webhooks של אינסטגרם

`ig-webhook` (הישן, מקבל כרגע את המנוי של Meta) נאטם fail-closed אבל עדיין
חי לצד `instagram-webhook` (החדש, זהות לידים דרך `upsert_lead_by_igsid`).
כשנוח: להעביר ב-Meta App Dashboard את ה-callback של Instagram ל-
`/functions/v1/instagram-webhook`, לוודא זרימת הודעות, ואז
`supabase functions delete ig-webhook` ולמחוק את התיקייה מהריפו.
