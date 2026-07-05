# Handoff — קמפיין וובינר "הדרך לדירה" + מודול הודעות תפוצה

מסמך העברה למפתח. מרכז מה נבנה, למה, ואיך פורסים. משלים את
[webinar-launch-runbook.md](webinar-launch-runbook.md) (צעדי פריסה מדויקים).

עודכן: 2026-07-05.

> **הערת מימוש חשובה:** התוכנית המקורית נכתבה מול ענף `feat/campaign-broadcasts`
> שהתבסס על `feat/ai-quality-tier-a`, שבו `dispatch-outbound` היה השולח הישיר
> ל-WhatsApp. במימוש הזה, שנבנה מחדש על `master` הנוכחי, `dispatch-outbound`
> **מנקז את התור ומוסר ל-`orchestrate-message`**. לכן ההתאמה: `dispatch-outbound`
> קיבל **נתיב שליחה ישיר** ל-payload שנושא תבנית (`kind:'template'`), והנתיב הישן
> (מסירה ל-AI) לא נגע. `make-intake` לא קיים ב-master — במקומו הותאם `leads-intake`.

---

## 1. המטרה
קמפיין להשקת "הדרך לדירה":
1. נרשם בדף הנחיתה נכנס ל-CRM עם `source=webinar`, `source_campaign=launch_webinar_2026`.
2. הנרשם מקבל וואטסאפ אחד — אישור הרשמה (אוטומטי, פעם אחת, מכבד DNC).
3. ביום הוובינר — תזכורת ידנית מ-`/admin/broadcasts` לכל הסגמנט.
4. מודול תפוצה: שליחה לסגמנטים לפי סיווג, שליטה בנוסח/שעה, אנליטיקה, ו-priority
   שלא חוסם את הבוט.

---

## 2. הארכיטקטורה — מה נבנה

### 2.1 כניסה + סיווג (§3.1)
- **`leads-intake`** — כבר קלט `campaign_name` → `leads.source_campaign`. נוסף:
  קריאת `?campaign=` / `?source=` מה-query כ-fallback (הטופס נותן אותם ב-URL),
  והעברת `source_campaign` להקשר המנוע ב-`lead.created`.
- **`_shared/event-context.ts`** — נוסף `source_campaign` לשדות ה-`lead.*`
  (טיפוס + SELECT + base). בלי זה תנאי הכלל לא היה מתאים.

### 2.2 שליחת תבנית Meta מאושרת בשמה (§3.2)
- **`_shared/automation-engine.ts`** — action `send_template` מקבל:
  - `meta_template:{name,lang,params}` — נשלח בשם ל-payload (נתיב לקהל קר). כשקיים,
    ה-body של `message_templates` הוא לתצוגה מקדימה בלבד ולא חוסם על משתנים חסרים.
  - `once:true` — יורה לכל היותר פעם אחת לכל (ליד, key) דרך ledger
    `engine_template_sends` (unique(lead_id, once_key)).
- **`dispatch-outbound`** — נתיב חדש: payload עם `kind:'template'` נשלח ישירות
  (`sendWhatsAppTemplate` אם יש `meta_template`, אחרת `sendWhatsAppText`), מכבד DNC,
  כותב `messages` (ל-provider-status rollup), ומעדכן `broadcast_recipients`. שאר
  ה-payloads ממשיכים ל-`orchestrate-message` כרגיל. **תיקון אמיתי:** לפני כן payload
  כזה (ללא conversation) היה מקבל 400 מ-orchestrate ונופל ל-DLQ.

### 2.3 הודעת אישור (§3.3) — migration `085`
כלל `campaign_webinar_launch_confirm`: trigger `lead.created`, תנאי
`source_campaign=launch_webinar_2026` + `do_not_contact=false`, action `send_template`
key `webinar_launch_confirm` `once:true` + `meta_template:{name:'webinar_launch_confirm',lang:'he'}`.
נזרעת גם שורת `message_templates` לתצוגה מקדימה.

### 2.4 מודול תפוצה (§3.4) — migration `085`
- **טבלאות:** `broadcasts` (name, channel, template_key, meta_template, body_snapshot,
  segment, scheduled_at, status, ספירות), `broadcast_recipients` (unique(broadcast_id,lead_id)).
- **priority:** `outbound_dispatch.priority` (default 0). `claim_outbound_dispatch` ממיין
  `priority asc, next_attempt_at asc`. בוט=0 לפני תפוצה=10 — **התפוצה לא חוסמת את הבוט.**
- **`_shared/broadcast-segment.ts`** — resolver סגמנט (source/source_campaign/primary_track/
  product_interest), תמיד מסנן DNC + removed_by_request + דורש טלפון.
- **`broadcasts`** (edge) — CRUD + `schedule`/`cancel`/`preview_count`/`stats`. Staff-gated
  (owner/admin/mia).
- **`broadcast-dispatch`** (edge, cron כל דקה) — broadcasts due → מממש recipients (idempotent)
  → מכניס לתור בבאטצ'ים (priority 10 + broadcast_id) → מסמן `sent` כשהכל enqueued.
- **cron `run_broadcast_dispatch`** — כמו `run_outbound_dispatch`; no-op בשקט עד קונפיג.
- **אנליטיקה:** `dispatch-outbound` כותב `messages` עם `provider_message_id`;
  `provider-status-webhook` הקיים מעדכן delivered/read → נאסף ב-`stats` דרך embed.

### 2.5 Frontend (§3.5)
- **`BroadcastsPage.tsx`** — route `/admin/broadcasts`, כרטיס ב-AdminHub. רשימה + יצירה
  (בורר סגמנט + preview חי + שם תבנית Meta + קישור זום + תזמון) + אנליטיקה + אזהרת rate >250.
- **`lib/api.ts` + `types.ts`** — `fetchBroadcasts/fetchBroadcast/fetchBroadcastStats/
  previewBroadcastSegment/postBroadcastAction` + טיפוסי `Broadcast*`.

### 2.6 ניקוי חלונית שיחה (§3.6)
- **`UnifiedTimeline.tsx`** — מסתיר אירועי מערכת רועשים (`inbound_message_received`,
  `provider_message_status_updated`, `whatsapp_router_prompted`, `manual_return_to_ai`),
  ממפה לעברית (`EVENT_LABELS`), ומקפל רצף זהה ל-`×N`. שום מחיקה — הכל ב-lead_events.
- **`LeadDetailPage.tsx`** — סיכום ה-AI הארוך מקופל מאחורי toggle "הצג עוד".

### 2.7 מקור + נושא ברשימת הלידים (§3.7)
- **`LeadsPage.tsx`** — דרופדאון "כל המקורות" (אופציה לכל תווית עברית, מתאים לכל ה-slugs
  שלה דרך IN); הצגת קמפיין (source_campaign) + נושא (interest_topic) בכל כרטיס.
- **`leads-list`** — SELECT כולל source_campaign + interest_topic; source מופרד בפסיקים (IN).

---

## 3. פריסה
ראה [webinar-launch-runbook.md](webinar-launch-runbook.md). בקצרה:
```bash
supabase db push
supabase functions deploy broadcasts broadcast-dispatch dispatch-outbound leads-intake leads-list
```
+ `alter database ... set app.broadcast_dispatch_url`, `vault.create_secret(..., 'broadcast_dispatch_secret')`,
`supabase secrets set BROADCAST_DISPATCH_SECRET=...`, והגשת תבניות Meta.

---

## 4. ⚠️ גוטצ'ות
- **תבניות Meta — התאמת שם + מספר משתנים מדויקת חובה** (אחרת #132000). `webinar_launch_confirm`
  = 0 משתנים (הקוד שולח 0 ✅).
- **`message_templates.body` = תצוגה מקדימה בלבד** — הלקוח מקבל את טקסט תבנית Meta.
- **באג הפרוד `karnaf_followup_v1`** (#132000) — תיקון ב-Meta (הוסף `{{1}}`), לא בקוד הזה.
- **אל תפרוס `orchestrate-message`** — לא נגענו בו, אין צורך.

---

## 5. אימות
```
typecheck ✓   lint ✓   298 tests ✓   build ✓
```
(edge functions נבדקים ב-CI עם `deno check`.)

---

## 6. אינדקס קבצים
**חדשים:** `supabase/functions/broadcasts/`, `supabase/functions/broadcast-dispatch/`,
`supabase/functions/_shared/broadcast-segment.ts`, `supabase/migrations/085_broadcasts.sql`,
`apps/web/src/pages/BroadcastsPage.tsx`, `docs/webinar-launch-runbook.md`.
**שונו:** `dispatch-outbound`, `leads-intake`, `leads-list`, `_shared/automation-engine.ts`,
`_shared/event-context.ts`, `_shared/env.ts`, `config.toml`, `apps/web/src/lib/{api,types}.ts`,
`apps/web/src/router.tsx`, `apps/web/src/pages/{AdminHubPage,LeadsPage,LeadDetailPage}.tsx`,
`apps/web/src/components/UnifiedTimeline.tsx`.
