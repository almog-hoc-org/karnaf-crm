# מדריך תפעול מלא ל-Karnaf CRM — לסוכן אוטונומי (OpenClaw)

> מסמך זה מלמד סוכן AI לתפעל ולנהל את מערכת karnaf-crm מקצה לקצה דרך משתמש
> אדמין רגיל (JWT של Supabase Auth עם role=admin). כל מה שכתוב כאן אומת מול
> הקוד בפועל. עדכון אחרון: 2026-07 (אחרי מיגרציה 112).

---

## 1. מה המערכת

CRM נדל"ן בעברית (RTL) של "קרנף נדל"ן": קליטת לידים מהאתר/וואטסאפ/אינסטגרם/
פייסבוק/רב מסר, בוט AI שעונה ללקוחות בוואטסאפ, ניהול משפך מכירה, תפוצות
וואטסאפ+מייל, דפי נחיתה, מסעות טיפוח אוטומטיים, שותפים/פרויקטים/עמלות.

ארכיטקטורה בקצרה:
- **Backend**: Supabase — Postgres עם RLS, ‏~55 פונקציות Edge ‏(Deno), ‏pg_cron.
- **Frontend**: React/Vite ב-Vercel — `https://karnaf-crm.vercel.app`.
- **עובדים אוטומטיים** (cron, לא נגישים לך ישירות): בוט ה-AI ‏(orchestrate-message),
  תור שליחה ‏(dispatch-outbound, כל דקה), תפוצות ‏(broadcast-dispatch, כל דקה),
  אוטומציות ומסעות ‏(automation-tick, כל 10 דק'), ‏SLA ‏(sla-worker), ‏nightly-jobs.
- **התראות תפעול** נשלחות לטלגרם של המפעיל (דו"ח בוקר 08:00, תפוצה שהושהתה,
  תבניות לא מאושרות).

### עקרונות עבודה לסוכן
1. **אל תדרוס את הבוט**: ליד ב-`ai_active` שייך לבוט. עניית בן-אדם (send-reply)
   מעבירה אוטומטית ל-`mia_active` ומשתיקה את הבוט. החזרה לבוט: `return_to_ai`.
2. **פעולות בלתי הפיכות** (purge, pii-delete, cancel לתפוצה) — רק לפי בקשה
   מפורשת של המפעיל.
3. **חוק הספאם הישראלי**: מייל שיווקי רק ל-`consent_email=true` (נאכף בשרת —
   אל תעקוף). וואטסאפ שיווקי לקהל קר — רק תבניות Meta מאושרות.
4. **כבד את ה-DNC**: `do_not_contact` / `removed_by_request` הם סופיים מבחינתך.
   רק המפעיל מחליט על reopen.
5. כל בקשה שלך נושאת `x-correlation-id` — שמור אותו ללוג/דיווח; הוא מאפשר
   למפעיל לאתר את הפעולה ב-lead_events ובלוגים.

---

## 2. התחברות וגישה

### 2.1 לוגין
```
POST {SUPABASE_URL}/auth/v1/token?grant_type=password
apikey: {SUPABASE_ANON_KEY}
{ "email": "<admin email>", "password": "<password>" }
```
או דרך supabase-js: `supabase.auth.signInWithPassword(...)`. שמור את
`access_token` (JWT) ורענן אותו (refresh_token / autoRefreshToken).

### 2.2 קריאת API — פונקציות Edge
```
GET/POST {FUNCTIONS_BASE}/<function-name>
Authorization: Bearer <access_token>
Content-Type: application/json
x-correlation-id: <uuid חדש לכל קריאה>
```
`FUNCTIONS_BASE` = `https://<project-ref>.functions.supabase.co`
(או `{SUPABASE_URL}/functions/v1`). תשובות: `{ ok: true, ... }` או
`{ error: "..." }` עם קוד HTTP. אין DELETE — הכל GET/POST.

### 2.3 גישת PostgREST ישירה (באותו JWT)
בנוסף לפונקציות, ה-RLS מתיר לך כאדמין:
- **קריאה** מכל טבלאות הליבה: `leads, conversations, messages, lead_events,
  work_queue, lead_tasks, payment_events, ai_decisions, automation_runs,
  integration_logs, system_heartbeats` + כל ה-views (`v_*`, `commission_*`...).
- **כתיבה ישירה** לטבלאות תוכן: `message_templates, automation_rules,
  journey_definitions, journey_runs, saved_lists, landing_pages, broadcasts,
  partners, projects, commissions, deals, meetings, program_members` ועוד.
- **כתיבה ל-`crm_config`** — כל מפתח (ראה §7.3; להשתמש בזהירות).
- **אסור/חסום**: כתיבה ישירה ל-`leads/messages/work_queue` (מדיניות
  no-write מפורשת — חובה דרך הפונקציות), וטבלאות service-role בלבד
  (`outbound_dispatch, webhook_inbox, webhook_idempotency, job_runs`...).

**כלל אצבע: העדף תמיד את הפונקציות** — הן מבצעות ולידציה, אודיט
(lead_events) ותופעות לוואי נכונות. גישה ישירה = רק לקריאה/דוחות, ולכתיבת
crm_config כשאין endpoint.

### 2.4 תפקידים
`owner / admin` (הכל) · `mia` (תפעול מלא חוץ ממסכי אדמין) · `sales_rep`
(עבודה על לידים) · `viewer` (קריאה). אתה admin — הכל פתוח לך.

---

## 3. מודל המידע — מה שחייבים להבין

### 3.1 מחזור חיים של ליד (`lead_status`)
```
new → first_contact_sent → responded → qualified → checkout_pushed
    → payment_pending → won → onboarding_active → active_student
צדדים: nurture ⇄ responded/qualified · dormant · lost (→ nurture/dormant)
סופיים: do_not_contact, removed_by_request, duplicate, active_student
חריג: manual_review_required → first_contact_sent/human_handoff/lost/dnc
```
מעבר לא-חוקי פשוט לא יקרה (safeTransition). יציאה ממצב סופי — רק
`reopen_lead` (אדמין בלבד).

### 3.2 בעלות (`ownership_mode`)
- `ai_active` — הבוט עונה לבד. אל תשלח send-reply אלא אם אתה מתכוון להשתלט.
- `mia_active` — בן-אדם (או אתה) מטפל; הבוט שותק.
- `phone_sales_pending` — ממתין לשיחת טלפון.
- בנוסף: `conversation-claims` נועל שיחה זמנית (TTL) בלי לשנות בעלות.

### 3.3 תור העבודה (`work_queue`)
פריטים עם `queue_type` (23 סוגים: `first_response_due, hot_lead, sla_risk,
human_handoff, payment_pending, phone_escalation, failed_automation,
ai_stuck, deal_stalled, meeting_outcome_pending, phone_overdue, ...`),
`status ∈ pending/claimed/resolved`, ‏`priority_level` (1=קריטי).

### 3.4 תיבת "היום שלי" (attention-inbox)
ה-RPC מאחד הכל לשורות עם `kind` ו-lane:
- lane **reply** (הכי דחוף): `awaiting_reply` (לקוח כתב ולא נענה),
  `mia_reply` (לקוח בטיפול אנושי השיב).
- lane **call**: `phone_escalation`, `phone_overdue`.
- lane **risk**: `ai_stuck`, `deal_stalled`, `overdue_action`.
- lane **ops**: `meeting_outcome_pending`, `queue`.
מעל שעתיים המתנה = קריטי. **זה המסך שמתחילים ממנו כל בוקר.**

### 3.5 צינור התפוצות
`broadcasts` (draft→scheduled→sending→sent/failed/cancelled) →
broadcast-dispatch (cron דקתי) ממלא `broadcast_recipients` בקצב →
`outbound_dispatch` (עדיפות נמוכה מתעבורת בוט) → שליחה בפועל.
קיצוב מ-`crm_config.broadcast_pacing`:
`{per_tick:20, daily_cap:2000, pause_min_sample:20, pause_failure_pct:30}` —
20 נמענים לדקה, עד 2000 ב-24 שעות, ומעל 30% כשלונות (אחרי 20 נסיונות)
התפוצה נעצרת אוטומטית (status=failed + התראת טלגרם). **אין pause/resume ידני
ואין "שלח עכשיו"** — רק scheduled_at + ה-cron.

### 3.6 אוטומציות ומסעות
- `automation_rules` — כללי מנוע (trigger_event + conditions + actions).
  הפעלה/כיבוי: `POST /automations {action:'toggle', id, enabled}`.
- `journey_definitions` / `journey_runs` — רצפים מתוזמנים (למשל
  `website_nurture`: יום 2/5/9 בוואטסאפ, מתבטל כשהליד עונה).
- כללים שנזרעו כבויים עם `metadata.enable_after_meta_approval=true` מחכים
  לאישור תבניות במטא לפני הפעלה.

---

## 4. מדריך API מלא (לפי endpoint)

> חובה שדות מסומנים ב-*. כל POST הוא `{action: '...', ...}` אלא אם צוין אחרת.

### לידים
**`GET /leads-list`** — פרמטרים: `status, heat, ownershipMode, source`
(מופרד פסיקים), `search, searchIn(lead|messages), createdFrom/To,
inboundFrom, awaiting=true, member=true, productGroup(program|investor|
presale|consultation), campaign` (תואם utm_campaign או source_campaign),
`limit(≤200), offset`. מחזיר גם `awaiting_reply` ו-`is_program_member`
מחושבים לכל שורה.

**`GET /lead-detail?leadId=*`** — התיק המלא: lead, conversations, messages,
queueItems, tasks, events, deals, meetings, activities, programMember.

**`POST /leads-manage`** — actions:
- `create`: phone או email* (+fullName, source, sourceDetail, campaignName,
  city, notesInternal). טלפון חייב לעבור נרמול ישראלי.
- `update`: leadId* + phone/fullName/email/source/sourceDetail/campaignName/
  webinarName/leadMagnetName/city/notesInternal (+`expectedUpdatedAt`
  לזיהוי דריסה, 409 על conflict). **המקום היחיד לתקן טלפון.**
- `delete`: leadId* — מחיקה **רכה** (removed+DNC). `restore`: ביטול.
- `purge`: leadId* — מחיקה קשה בלתי הפיכה. חסום לליד ששילם (409).
- `import`: `rows:[{phone*, fullName?, email?}]` עד 500, `markMember?`,
  `source?`.

**`POST /bulk-lead-actions`** — `assign_owner {leadIds(≤200), assigneeUserId}`
או `change_heat {leadIds, heat: hot|warm|cool|cold}`.

**`POST /admin-actions`** — הפעולות התפעוליות על ליד (body: action, leadId, ...):
| action | מה עושה |
|---|---|
| `assign_to_mia` | העברה לטיפול אנושי (mia_active + human_handoff + פריט תור) |
| `return_to_ai` | החזרה לבוט (ai_active; מפעיל את הבוט על השיחה) |
| `mark_phone_escalation` | הסלמה לטלפון |
| `mark_dnc` | סימון לא-ליצור-קשר (סופי) |
| `mark_lost` | אבוד (+note→lost_reason; סוגר deal פתוח; אירוע deal.lost) |
| `mark_won` | זכייה — **דורש deal פתוח** (אחרת 400 no_open_deal) |
| `reopen_lead` | חילוץ ממצב סופי — targetStatus: responded/qualified/nurture/human_handoff |
| `resolve_queue` | סגירת פריט תור (queueItemId) |
| `log_phone_call` | תיעוד שיחה (callOutcome, callDurationMinutes) |
| `schedule_meeting` | קביעת פגישה (meetingStartsAt*, meetingType: phone/zoom/office) |
| `update_meeting_status` | scheduled/held/cancelled/no_show (ביטול/הברזה → פריט טלפון) |
| `advance_deal_stage` | קידום שלב עסקה (dealId, targetStage) |
| `update_lead_meta` | עדכון שדות תוכן (metaUpdates{}) — heat/fit/readiness/track/סיכומים; **לא טלפון** |
| `merge_lead_duplicate` | מיזוג כפילות (leadId=שורד, duplicateLeadId) |
| `mark_program_member` | סימון חבר תוכנית |

### שיחות ותגובות
**`POST /send-reply`** — `{leadId*, conversationId*, text* (≤2000)}`.
בתוך חלון 24ש' → נשלח חופשי (`mode:'freeform'`). מחוץ לחלון → נכנס לתור +
נשלחת תבנית fallback מאושרת (`mode:'queued_template'`). 409 על ליד DNC.
תופעת לוואי: הליד עובר אליך (`mia_active`).
**`POST /conversation-claims`** — `claim {conversationId, ttlMinutes≤240}` /
`release`. נעילת שיחה מולI הבוט.

### תור ותיבה
**`GET /queue-list?queueType&status&limit`** · **`POST /queue-resolve`**
`{queueItemId*, resolutionNote?}` · **`GET /attention-inbox?limit≤500`**.

### דשבורד ואנליטיקה
**`GET /dashboard-summary`** — KPIs: leadsToday, awaitingReplyNow,
hotLeadsNow, paymentPendingNow, slaRiskCount, funnel, queueCounts.
**`GET /analytics-summary`** — sourcePerformance, campaignPerformance
(ביצועי utm_campaign), aging, cohorts, aiVsHuman, firstResponseTimes.
**`GET /reports`** — עמלות, פריסייל בסיכון, שימור.
**`GET /team-workload`** — עומס פר חבר צוות.

### תפוצות
**`GET /broadcasts`** (רשימה+pacing) · **`GET /broadcasts?id=`** (סטטיסטיקה
מלאה + פירוט דילוגים).
**`POST /broadcasts`** actions:
- `create`: name*, channel(whatsapp|email), meta_template{name,lang:'he',
  params[]} (חובה לוואטסאפ בשלב schedule), subject* + body_html (מייל),
  segment, scheduled_at. HTML עובר sanitize בשרת.
- `update` (רק draft; לא מעדכן subject/body_html — צור מחדש), `schedule`,
  `cancel` (מ-scheduled/sending), `delete` (draft/cancelled/failed).
- `preview_count {segment, channel}` — ספירה + דגימה בלי כתיבה. **תמיד לפני schedule.**
- `save_list {name, definition}` / `list_lists` / `delete_list {id}` — קהלים שמורים.

צורת segment (רק המפתחות האלה):
`{source?, source_campaign?, utm_campaign?, utm_source?, primary_track?,
product_interest?, tags?: string[]}` — ערכי טקסט תומכים בריבוי ערכים
מופרדי-פסיק; tags = חפיפה כלשהי (עד 20). DNC מסונן תמיד; מייל מסנן גם
consent_email=true + email קיים.

### תבניות הודעה
**`GET /message-templates?channel&status`**.
**`POST`**: `create {key* (a-z0-9_), channel*(whatsapp|sms|email), name_he*,
body*, subject?, body_html?, variables_used[], tags[]}` ·
`update {id*, ...}` (key/channel קבועים; להוציא משימוש: status:'deprecated').
משתנים בגוף: `{{first_name}}, {{full_name}}, {{phone}}, {{email}}, {{city}}`.

**`GET /meta-template-status`** — מצב חי מול Meta (סטטוס אישור לכל תבנית).
**`POST {action:'sync'}`** — סנכרון: מייבא תבניות חדשות ממטא, מדווח drift
(לא דורס גוף מקומי), מתריע על לא-מאושרות. רץ גם לילית אוטומטית.

### דפי נחיתה
**`GET /landing-pages`** · **`POST`**: `create {slug* (a-z0-9-), title*,
headline*, campaign*, subheadline?, body_md?, cta_label?, form_config?,
active?}` · `update {id, ...}` (slug קבוע) · `delete {id}`.
URL ציבורי: `https://karnaf-crm.vercel.app/api/lp/<slug>`.
`active:false` מוריד את הדף מיידית. הקמפיין של הדף הופך ל-source_campaign
של כל נרשם → ניתן לסנן ולתפוצץ עליו.

### אוטומציות ומסעות
**`GET /automations`** (+`?runs=1` ללוג, `?contact_id=` פר-ליד) ·
**`POST {action:'toggle', id, enabled}`** · `{action:'update_dsl', id,
conditions?, actions?}` (עריכה מתקדמת — זהירות).
**`GET /journeys`** (+`?runs=1`) · **`POST {action:'cancel_run', id}`** ·
`{action:'update_def', id, steps?, enabled?, ...}`.

### הגדרות מערכת
**`GET /runtime-config`** · **`POST`** actions:
- `update_ai_safety_net {enabled, ackText(≤500), oncePerHours(1-168)}` —
  הודעת "קיבלנו את הפנייה" כשה-AI נכשל.
- `update_active_hours {start,end HH:MM, timezone:'Asia/Jerusalem', workingDays[]}`
- `update_follow_up_delays {firstResponseMinutes, nurtureHours, paymentPendingHours}`
- `update_sla_thresholds {firstResponseWarnHours ≤ HighWarn ≤ Breach, paymentPendingHours}`
- `update_forbidden_claims {claims: string[]}` — משפטים שאסור לבוט להגיד.

### משתמשים
**`GET /users-manage`** · **`POST`**: `create {email*, password*(≥12),
role*, fullName}` · `update {userId, role?, isActive?, fullName?, password?}`.
אין מחיקה — `isActive:false`.

### שותפים / פרויקטים / עמלות
**`/partners`**: create/update/archive/pause/restore.
**`/projects`**: create/update + מכונת מצבים recruiting→closed→executed
(+cancel/reopen) + `publish` (מפיץ project.recruiting עד 500 לידי פריסייל).
**`/commissions`**: `?status=` · `mark_paid {id, amount_received?}` (רק
מ-to_bill) · `cancel {id, cancellation_reason*}`.

### מתקדם (אדמין בלבד)
**`/prompt-variants`** — ‏A/B לפרומפטים של הבוט (create/update/delete).
**`/lead-sources`** — רישום מקורות ליד. **`/whatsapp-router-options`** —
תפריט הכניסה של הבוט (עם audit). **`/pii-export`** `{leadId|phone|email}` —
ייצוא GDPR מלא. **`/pii-delete`** `{leadId, reason(≥5), confirmUpdatedAt}` —
אנונימיזציה מיידית בלתי הפיכה (חובה confirmUpdatedAt=updated_at הנוכחי).
**`/webhook-replay`** `{inboxId}` או `{filter:'failed_recent', limit≤50}` —
הרצה חוזרת של webhooks שנכשלו.

---

## 5. פלייבוקים — שגרות עבודה

### 5.1 שגרת בוקר (וכל כמה שעות)
1. `GET /attention-inbox` — טפל לפי סדר: lane reply (מעל שעתיים = מיידי) →
   call → risk → ops.
2. לכל `awaiting_reply`/`mia_reply`: `GET /lead-detail` → הבן הקשר → ענה
   ב-`send-reply`, או אם הבוט אמור לטפל — `return_to_ai`.
3. `GET /dashboard-summary` — חריגות: slaRiskCount גבוה, paymentPendingNow
   תקוע, queueCounts חריגים (בפרט `failed_automation` ו-`ai_stuck`).
4. `GET /queue-list?queueType=failed_automation` — חקור כל כשל (בליד:
   lead_events + ai_decisions), פתור ידנית וסגור עם `resolve_queue`.

### 5.2 שליחת תפוצת וואטסאפ
1. ודא תבנית מאושרת: `POST /meta-template-status {action:'sync'}` →
   הבדוק שהשם אינו ב-nonApproved.
2. בנה segment → `preview_count` — ודא שהמספר הגיוני (וזכור: עד 2000/יום).
3. `create` עם meta_template{name, lang:'he'} + scheduled_at → `schedule`.
4. מעקב: `GET /broadcasts?id=` — אם status=failed עם sent נמוך, בדוק את
   פירוט ה-skipped/failed לפני שמנסים שוב. אין resume — תפוצה שנעצרה
   יוצרים מחדש (לרוב אחרי הבנת הכשל!).

### 5.3 שליחת תפוצת מייל
כמו 5.2, אבל: channel:'email', חובה subject, גוף = body_html (או תבנית
email עם body_html). נשלח דרך רב מסר; רק נמענים עם email+consent_email.
דילוגים מדווחים כ-no_email/no_consent/invalid_email.

### 5.4 יצירת דף נחיתה + קמפיין מקצה לקצה
1. `POST /landing-pages create` עם slug+campaign ייחודיים.
2. בדוק את `https://karnaf-crm.vercel.app/api/lp/<slug>` (טופס עובד).
3. הנרשמים יקבלו source_campaign=<campaign> → סנן ב-`/leads-list?campaign=`,
   עקוב ב-analytics (campaignPerformance), ותפוצץ עליהם עם segment
   `{source_campaign:'<campaign>'}`.

### 5.5 טיפול בליד ששילם
בדרך כלל אוטומטי (payment-webhook → won → onboarding). ידנית:
`mark_won` (רק אם יש deal פתוח; אם אין — צור deal דרך advance_deal_stage
או בקש הנחיה), או `mark_program_member` לחבר תוכנית.

### 5.6 ניקוי ותחזוקת דאטה
- כפילות: `merge_lead_duplicate` (השורד ראשון).
- לידים מתים: `delete` (רך) כברירת מחדל; `purge` רק בהוראת מפעיל מפורשת.
- ייבוא רשימות: `leads-manage import` (עד 500 בכל קריאה, phone חובה).

### 5.7 בעיה: הבוט לא עונה ללקוח
בדוק בסדר: (1) `ownership_mode` — אם mia_active הבוט מושתק בכוונה;
(2) conversation claim פעיל? (3) `GET /queue-list?queueType=failed_automation`
ו-`ai_stuck`; (4) lead_events של הליד — חפש generic_ack_sent /
failed statuses; (5) אם צריך — `return_to_ai` מפעיל את הבוט מחדש.
רשת הביטחון (ai_safety_net) שולחת ללקוח "קיבלנו את הפנייה..." אוטומטית
כשה-AI קורס — ודא שהיא enabled ב-`GET /runtime-config`.

### 5.8 בעיה: תפוצה תקועה ב"מתוזמן" אחרי הזמן
`GET /broadcasts?id=` — אם עדיין scheduled הרבה אחרי scheduled_at, ה-cron
worker כנראה לא רץ (בעיה תשתיתית — דווח למפעיל). בדוק גם
`system_heartbeats` (PostgREST) — heartbeat של broadcast-dispatch עדכני?

### 5.9 webhook שנכשל (ליד/תשלום שלא נקלט)
`POST /webhook-replay {filter:'failed_recent'}` — מריץ מחדש כשלונות
מ-7 הימים האחרונים. לאירוע ספציפי: מצא inboxId ב-integration_logs/
webhook_inbox (דרך המפעיל) → `{inboxId}`.

---

## 6. גבולות — מה אתה לא יכול לעשות (אסקלציה למפעיל)
- פריסות קוד, מיגרציות, secrets (טוקן וואטסאפ, מפתחות AI, רב מסר, CAPI),
  ‏pg_cron — הכל דרך GitHub/Supabase console בלבד.
- להריץ ידנית את העובדים (בוט/תור/תפוצות) — הם cron בלבד. אין "שלח עכשיו".
- pause/resume לתפוצה; עריכת subject/body_html של תפוצה קיימת; שינוי
  key/channel של תבנית או slug של דף נחיתה (יוצרים מחדש).
- מחיקת משתמש (רק השבתה), purge המוני (אחד-אחד), purge לליד ששילם
  (רק pii-delete).
- אישור תבניות ב-Meta (WhatsApp Manager) — פעולת מפעיל; אתה רק מסנכרן
  ובודק סטטוס.

## 7. אזהרות קריטיות

### 7.1 בלתי הפיך — לבצע רק בהוראה מפורשת
`leads-manage purge` · `pii-delete` · `broadcasts cancel` (אין resume) ·
`delete_list` · `landing-pages delete` (עדיף active:false).

### 7.2 קצב ומוניטין וואטסאפ
לעולם אל תנסה לעקוף את הקיצוב (2000/יום, 20/דקה) — הוא מגן על המספר
מחסימה של Meta. אם המפעיל ביקש להגדיל — עדכן את
`crm_config.broadcast_pacing` (PostgREST) רק אחרי שהוא אישר שהמכסה
ב-Meta אכן גדלה.

### 7.3 crm_config ישיר — בזהירות
מפתחות שמותר לגעת בהם ישירות (אין endpoint): `broadcast_pacing`,
`email_channel {provider, fromName, fromEmail, requireConsent}`,
`whatsapp_waba_id`. **אל תיגע** ב-`ai_runtime`, `whatsapp_session`,
`cron_*_url`, `product` בלי הנחיה מפורשת — טעות שם משביתה את הבוט.
לעולם אל תכבה `email_channel.requireConsent` (חוק הספאם).

### 7.4 סימנים שמשהו דחוף
- `attention-inbox` עם reply מעל שעתיים · `slaRiskCount` מטפס ·
  `failed_automation`/`ai_stuck` מצטברים · תפוצה failed עם pause אוטומטי ·
  heartbeat ישן ב-`system_heartbeats` (worker מת) → דווח למפעיל מייד.

## 8. סטטוס נוכחי של המערכת (2026-07)
- ערוץ מייל דרך רב מסר פעיל (דורש RAVMESSER_* secrets תקינים).
- מסע `website_nurture` + כלל הגשר קיימים אך **כבויים** עד אישור תבניות
  `karnaf_website_nurture_d2/d5/d9_v1` + `karnaf_landing_welcome_v1` במטא.
  אחרי אישור: toggle ב-`/automations`.
- ‏Meta CAPI מוכן אך כבוי עד הזנת META_PIXEL_ID + META_CAPI_TOKEN.
- ‏webhook סליקה מוכן ל-Grow (‎₪5,490, product_code=course_5490) — ממתין
  לפתיחת חשבון והגדרת PAYMENT_STATIC_TOKEN.
- סנכרון תבניות מ-Meta דורש טוקן עם הרשאת whatsapp_business_management
  (אם sync מחזיר Graph #100 — הטוקן עדיין חסר את ההרשאה; דווח למפעיל).
