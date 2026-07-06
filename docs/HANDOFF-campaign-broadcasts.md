# Handoff — קמפיין וובינר "הדרך לדירה" + מודול הודעות תפוצה

מסמך העברה למפתח. מרכז את כל מה שנבנה, למה, איך פורסים, ומה נשאר פתוח.
עודכן: 2026-07-05.

- **ענף:** `feat/campaign-broadcasts` (מבוסס על `master` + cherry-pick של make-intake, manual-add-lead, leads-manage).
- **סטטוס:** committed מקומית, **לא נדחף ל-GitHub, לא פרוס**. typecheck + lint + 298 טסטים עוברים.
- **מסמכים משלימים:** [webinar-launch-runbook.md](webinar-launch-runbook.md) (צעדי פריסה מדויקים).

---

## 1. המטרה (מה ביקש הלקוח)
קמפיין להשקת התוכנית הדיגיטלית "הדרך לדירה":
1. נרשם בדף הנחיתה `webinar.karnafnadlan.com` (טופס רב מסר) נכנס ל-CRM עם סיווג "נרשם לוובינר השקה".
2. הנרשם מקבל וואטסאפ אחד: אישור הרשמה.
3. ביום הוובינר — תזכורת וואטסאפ עם קישור זום לכל הנרשמים.
4. מודול "הודעות תפוצה": שליחה לסגמנטים לפי סיווג, וואטסאפ (שלב 1) + מייל (שלב 2), שליטה מלאה בנוסח/שעה/אמצעי, אנליטיקה, ו-rate-limiting שלא יחסום את הבוט.

---

## 2. ⚠️ באג פרודקשן קריטי — הבוט לא עונה (#132000)
**סימפטום:** לידים (בעיקר מרב מסר) תקועים, הבוט לא מגיב, טיימליין מוצף ב-`manual_return_to_ai`.

**שורש הבעיה (לא ניחוש — שגיאת Meta מפורשת):**
```
(#132000) number of localizable_params (1) does not match the expected number of params (0)
```
תבנית ה-fallback `karnaf_followup_v1` (env `WHATSAPP_FALLBACK_TEMPLATE`) אושרה ב-Meta עם **0 משתנים**, אבל הקוד (`orchestrate-message`, `dispatch-outbound`) שולח לה **משתנה אחד** — טקסט התשובה. לכן כל שליחת תבנית מחוץ לחלון 24 השעות נכשלת → הבוט שותק → `ai-watchdog` מנסה שוב בלולאה ומייצר את ספאם ה-`manual_return_to_ai`.

**מדוע דווקא לידי רב מסר:** נרשמו בטופס ומעולם לא כתבו לבוט → תמיד מחוץ לחלון 24ש → כל תשובה חייבת תבנית → התבנית שבורה.

**התיקון (Meta, לא קוד):** ערוך את `karnaf_followup_v1` → הוסף `{{1}}` בגוף → שלח לאישור מחדש. משחרר את כל הלידים בבת אחת.

> הערה למפתח: אם תרצו לחזק בקוד — אפשר לזהות שגיאת 132000 ולהתריע, או לוודא ש-`WHATSAPP_FALLBACK_TEMPLATE` תמיד מצביע על תבנית עם `{{1}}` יחיד. הקוד של `orchestrate-message` הרלוונטי חי על ענף הפרוד `feat/ai-quality-tier-a` (ראו §6), לא על ענף זה.

---

## 3. הארכיטקטורה — מה נבנה ואיך
הכל additive. נשען על תשתית קיימת (תור `outbound_dispatch` + worker `dispatch-outbound`, מנוע האוטומציה, `provider-status-webhook`).

### 3.1 כניסה + סיווג
- **`supabase/functions/make-intake/index.ts`** — מעביר `?campaign=` מה-query כ-`campaign_name` → `leads.source_campaign`. זהו מפתח הסגמנטציה העמיד (לא נדרס גם אם ה-webhook של "כל הנמענים" יורה במקביל).
- **`supabase/functions/leads-intake/index.ts`** — מעביר `source_campaign` להקשר המנוע (`buildLeadContextFromRow`).
- **`supabase/functions/_shared/event-context.ts`** — הוסף `source_campaign` לשדות ההקשר של `lead.*` (טיפוס + SELECT + base). בלי זה תנאי הכלל לא היה מתאים.

### 3.2 שליחת תבנית Meta מאושרת בשמה (התיקון המהותי)
- **`supabase/functions/dispatch-outbound/index.ts`** — נתיב חדש: אם ה-payload נושא `meta_template: {name, lang, params}`, שולח את התבנית המאושרת **בשמה** ישירות (`sendWhatsAppTemplate`), במקום לעטוף בתבנית fallback גנרית. זה הנתיב הנכון לקהל קר (נרשמי וובינר שלא כתבו לבוט). נתיב ה-fallback הישן נשאר לתשובות בתוך החלון. כן: מעדכן `broadcast_recipients` (sent/skipped) לאנליטיקה, ומכבד DNC.
- **`supabase/functions/_shared/automation-engine.ts`** — action `send_template` מעביר `meta_template` ל-payload.

### 3.3 הודעת אישור (engine rule)
- **migration `085_broadcasts.sql`** — כלל `campaign_webinar_launch_confirm`: trigger `lead.created`, תנאי `source_campaign = launch_webinar_2026` + DNC=false, action `send_template` key `webinar_launch_confirm` **`once:true`** + `meta_template:{name:'webinar_launch_confirm', lang:'he'}`. מפתחות once + ledger `engine_template_sends` מונעים כפילות.

### 3.4 מודול תפוצה
- **טבלאות (085):** `broadcasts` (name, channel, template_key, meta_template jsonb, body_snapshot, segment jsonb, scheduled_at, status, ספירות), `broadcast_recipients` (broadcast_id, lead_id, status, dispatch_id, message_id, sent_at, unique(broadcast_id,lead_id) לאידמפוטנטיות).
- **priority:** עמודת `outbound_dispatch.priority` (default 0) + `claim_outbound_dispatch` ממיין לפי priority. תעבורת בוט בזמן אמת (0) תמיד לפני תפוצה (10) — **כך התפוצה לא חוסמת את הבוט.**
- **`supabase/functions/broadcasts/index.ts`** — CRUD + `schedule`/`cancel`/`preview_count`/`stats`. Staff-gated (owner/admin/mia).
- **`supabase/functions/broadcast-dispatch/index.ts`** — worker (cron כל דקה): due broadcasts → מממש `broadcast_recipients` → מכניס לתור בבאטצ'ים (cap פר-tick) עם priority + `broadcast_id` → מסמן `sent` כשהכל enqueued.
- **`supabase/functions/_shared/broadcast-segment.ts`** — resolver סגמנט (source/source_campaign/primary_track/product_interest), תמיד מסנן do_not_contact + removed_by_request.
- **cron `run_broadcast_dispatch` (085):** אותו דפוס כמו automation-tick; יוצא בשקט אם ה-URL/secret לא מוגדרים.
- **אנליטיקה:** `dispatch-outbound` כותב `messages` עם `provider_message_id`; `provider-status-webhook` הקיים מעדכן delivered/read → מתגלגל לנמעני התפוצה.

### 3.5 Frontend
- **`apps/web/src/pages/BroadcastsPage.tsx`** — רשימה + יצירה (בורר סגמנט + preview חי + בורר תבנית + שם תבנית Meta + תזמון) + עמוד אנליטיקה. route `/broadcasts`, כרטיס ב-AdminHub.
- **`apps/web/src/lib/api.ts` + `types.ts`** — `fetchBroadcasts/fetchBroadcast/previewBroadcastSegment/postBroadcastAction` + טיפוסים.

### 3.6 ניקוי חלונית שיחה
- **`apps/web/src/components/UnifiedTimeline.tsx`** — מסתיר אירועי מערכת רועשים (`manual_return_to_ai`, router prompts, קבלות ספק, `inbound_message_received` שכפל בועה), ממפה לעברית, ומקפל רצף זהה ל-`×N`. שום מחיקה — הכל עדיין ב-lead_events.
- **`apps/web/src/pages/LeadDetailPage.tsx`** — סיכום ה-AI הארוך מקופל מאחורי toggle.

### 3.7 מקור + נושא ברשימת הלידים
- **`apps/web/src/pages/LeadsPage.tsx`** — דרופדאון סינון "כל המקורות" (אופציה לכל תווית עברית, מתאים לכל ה-slugs שלה דרך IN); הצגת נושא (interest_topic) + קמפיין (source_campaign) בכל כרטיס.
- **`supabase/functions/leads-list/index.ts`** — SELECT כולל source_campaign + interest_topic; תמיכה ב-source מופרד בפסיקים (IN).

---

## 4. פריסה
ראו [webinar-launch-runbook.md](webinar-launch-runbook.md). בקצרה:
```bash
supabase db push
supabase functions deploy broadcasts broadcast-dispatch dispatch-outbound \
  make-intake leads-intake leads-list leads-manage
```
+ SQL: `alter database ... set app.broadcast_dispatch_url`, `vault.create_secret(..., 'broadcast_dispatch_secret')`, `supabase secrets set BROADCAST_DISPATCH_SECRET=...`
+ webhook רב מסר: `make-intake?token=<KEY>&source=webinar&campaign=launch_webinar_2026`
+ פרונט: push → Vercel auto-build.

**❗ אל תפרוס `orchestrate-message` מהענף הזה** — ראו §6.

---

## 5. אימות
1. הרשמת בדיקה → `select source, source_campaign from leads where created_at > now()-interval '10 min'` (מצפים source=webinar, campaign=launch_webinar_2026).
2. אישור נשלח → `select * from automation_runs where rule_code='campaign_webinar_launch_confirm' order by created_at desc`.
3. `/broadcasts` → תפוצה חדשה לסגמנט → תזמון → אנליטיקה מתמלאת (נשלח→נמסר→נקרא).
4. עומס: תפוצה גדולה בזמן שיחת בוט → הבוט (priority 0) לא נדחק.

---

## 6. ⚠️ גוטצ'ות וסביבת git (חובה לקרוא)
- **הפרוד לא רץ מ-master.** ה-`orchestrate-message` החי בפרוד = v52 מענף `feat/ai-quality-tier-a` (כולל תיקוני איכות הבוט). ענף זה מבוסס על master, שבו `orchestrate-message` **ישן יותר**. לכן: **פרוס רק את הפונקציות המפורטות ב-§4; אל תפרוס orchestrate-message מכאן** — זה יחזיר את הפרוד אחורה.
- `feat/ai-quality-tier-a` הוא superset של master (מכיל גם את Tier 8 + make-intake + תיקוני הבוט). אם רוצים בסיס "הכי קרוב לפרוד" לעבודה עתידית — עדיף למזג/לבסס עליו. ענף זה בחר במינימום (master + cherry-pick של make-intake בלבד) כדי לא לגרור ~3600 שורות של שכתוב AI לא-נבדק.
- **תבניות Meta — התאמת שם + מספר משתנים מדויקת חובה** (אחרת #132000). `webinar_launch_confirm` = 0 משתנים (הקוד שולח 0 ✅). `webinar_launch_reminder` = אם קישור הזום הוא `{{1}}` יש למלא בטופס התפוצה; אם קבוע — להשאיר ריק.
- **הנוסח ב-CRM (message_templates.body) הוא לתצוגה מקדימה בלבד** — הלקוח מקבל את טקסט תבנית Meta בפועל. כדאי ליישר את שני הנוסחים.
- **WIP ישן ב-stash:** `git stash@{0}` — עבודת ריבוי-ספקי-AI (Groq/Gemini/Meta webhooks env) שהופרדה בתחילת העבודה כדי לא להסתבך. לא אבדה.

---

## 7. פתוח / המשך עבודה
- **מייל (שלב 2):** ערוץ `email` בטבלת broadcasts קיים אבל מנוטרל ב-UI. הבסיס: `add_to_email_list` (רב מסר REST) כבר קיים; שילוב Resend/רב מסר לשליחת דיוור מלא + webhook פתיחות/קליקים.
- **התראת #132000:** לזהות בקוד שגיאת param-mismatch ולהתריע במקום להיכנס ללולאת retry.
- **לידי וובינר בתור "מענה ראשוני":** מוצג במכוון (ליד חם, "אף ליד לא נופל"). אם רוצים — לגרום להודעת האישור לסגור את פריט התור.
- **rate/tier של מספר וואטסאפ חדש:** ~250–1000 נמענים ייחודיים/יום. לתפוצה גדולה — לתעד אזהרה ב-UI (יש התראה בסיסית מעל 250).
- **צירוף nושא כפילטר מלא:** כרגע סינון נושא דרך רצועת המוצרים; interest_topic (טקסט חופשי) מוצג אך לא מסונן.

---

## 8. אינדקס קבצים
**חדשים:** `supabase/functions/broadcasts/`, `supabase/functions/broadcast-dispatch/`, `supabase/functions/_shared/broadcast-segment.ts`, `supabase/migrations/085_broadcasts.sql`, `apps/web/src/pages/BroadcastsPage.tsx`, `supabase/functions/leads-manage/`.
**שונו:** `dispatch-outbound`, `make-intake`, `leads-intake`, `leads-list`, `_shared/automation-engine.ts`, `_shared/event-context.ts`, `config.toml`, `apps/web/src/lib/{api,types}.ts`, `apps/web/src/router.tsx`, `apps/web/src/pages/{AdminHubPage,LeadsPage,LeadDetailPage}.tsx`, `apps/web/src/components/UnifiedTimeline.tsx`.
