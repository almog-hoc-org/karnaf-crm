# Karnaf CRM — Developer Handoff

_Last updated: 2026-04-28._

מסמך זה הוא נקודת ההתחלה של המפתח שמקבל את הפרויקט. הוא משלים את [DEPLOYMENT.md](DEPLOYMENT.md) (פעולות פריסה מעשיות) ואת [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md) (תיעוד מצב הקוד). מחליף את [OPEN-WORK-PLAN.md](OPEN-WORK-PLAN.md) הישן.

---

## 1. סקירה כללית

**מה זה:** CRM מבוסס WhatsApp + AI שנועד למכור את התוכנית הדיגיטלית "הדרך לדירה". ליד נכנס מטופס/WhatsApp/אימייל → AI מסווג ומגיב → Mia (אדם) מתערבת רק כשצריך → תשלום → ליד ב־`won` → אונבורדינג אוטומטי.

**Stack בקצרה:**
- **DB:** Supabase Postgres 15 + RLS + pg_cron + pg_net + Storage.
- **Backend:** Supabase Edge Functions ב־Deno (טייפסקריפט).
- **AI:** OpenAI Chat Completions עם playbook system + forbidden-claim filter + state-machine enforcement + circuit breaker.
- **Frontend:** React 19 + Vite 7 + Tailwind 4 + TanStack Query 5 + React Router 6 + Supabase JS 2.

**ריפו:** https://github.com/mogibot/karnaf-crm  
**ענף ראשי:** `master`  
**Last commit בעת כתיבת המסמך המקורי:** `248edcc` (docs)

**Pipeline מאומת לאחר סבב הייצוב האחרון:**
```
typecheck  ✓
lint       ✓
tests      ✓  suites הורחבו מעבר ל-151 המקוריים
build      ✓
```

---

## 2. ארכיטקטורה

```
┌─────────────────────────────────────────────────────────┐
│ Public webhooks (verify_jwt=false, signed + rate-limited)│
│ whatsapp-webhook ─── payment-webhook ─── email-webhook  │
│ provider-status-webhook ─── leads-intake                │
└─────────────┬─────────────────────────┬─────────────────┘
              │                         │
              ▼                         ▼
   ┌────────────────────┐   ┌──────────────────────┐
   │ Internal cron jobs │   │ AI orchestrator      │
   │ sla-worker         │   │ orchestrate-message  │
   │ nightly-jobs       │   │ (advisory locks +    │
   │ purge-rate-limit   │   │  state-machine RPC)  │
   └─────────┬──────────┘   └──────────┬───────────┘
             │                         │
             └──────────┬──────────────┘
                        ▼
        ┌───────────────────────────────────┐
        │  Postgres + RLS + RPCs            │
        │  18 migrations (001 → 018)        │
        │  • lead lifecycle state machine   │
        │  • prompt_variants A/B            │
        │  • whatsapp-media storage bucket  │
        └───────────────┬───────────────────┘
                        ▼
        ┌───────────────────────────────────┐
        │  Operator endpoints (JWT-gated)   │
        │  dashboard / lead-detail /        │
        │  leads-list / queue-list /        │
        │  analytics / users-manage /       │
        │  prompt-variants / admin-actions /│
        │  send-reply / queue-resolve       │
        └───────────────┬───────────────────┘
                        ▼
        ┌───────────────────────────────────┐
        │  React operator console           │
        │  Login → Dashboard / Leads /      │
        │  LeadDetail / Queue / Analytics / │
        │  Users / Prompts                  │
        └───────────────────────────────────┘
```

---

## 3. מבנה הריפו

```
karnaf-crm/
├─ apps/web/                  React operator console (Vite root)
│  └─ src/
│     ├─ auth/                AuthProvider, ProtectedRoute, LoginPage
│     ├─ components/          Layout, Toast, Spinner, Badge, ErrorBoundary
│     ├─ lib/                 api, supabase, types, format, i18n,
│     │                       observability, queryClient, hooks
│     ├─ pages/               Dashboard, Leads, LeadDetail, Queue,
│     │                       Analytics, Users, PromptVariants
│     ├─ test/setup.ts        Testing-Library bootstrap
│     ├─ index.css            Tailwind v4 entry + design tokens
│     ├─ main.tsx, router.tsx
│     └─ vite-env.d.ts
│
├─ lib/                       Node-side mirrors of Deno _shared
│  ├─ runtime/                state-machine, phone, ai-validation,
│  │                          forbidden-claims, conversation-window,
│  │                          webhook-signature, transcript-summary,
│  │                          playbooks, client-identifier  (+ tests)
│  └─ view-models/            דanis* helpers used by lib/runtime
│
├─ supabase/
│  ├─ migrations/             001 → 017 (see DEPLOYMENT.md §1)
│  ├─ functions/
│  │  ├─ _shared/             env, cors, logger, auth, supabase,
│  │  │                       webhook-signature, lead-service,
│  │  │                       queue-service, conversation-lock/window,
│  │  │                       circuit-breaker, idempotency, rate-limit,
│  │  │                       whatsapp-provider, ai-* runtime,
│  │  │                       playbooks, forbidden-claims,
│  │  │                       prompt-variant, transcript-summary,
│  │  │                       media-fetch
│  │  ├─ whatsapp-webhook/    Public webhooks
│  │  ├─ payment-webhook/
│  │  ├─ provider-status-webhook/
│  │  ├─ email-webhook/
│  │  ├─ leads-intake/
│  │  ├─ orchestrate-message/  Service-role internals
│  │  ├─ sla-worker/
│  │  ├─ nightly-jobs/
│  │  ├─ admin-actions/        JWT-gated operator endpoints
│  │  ├─ dashboard-summary/
│  │  ├─ lead-detail/
│  │  ├─ leads-list/
│  │  ├─ queue-list/
│  │  ├─ analytics-summary/
│  │  ├─ send-reply/
│  │  ├─ queue-resolve/
│  │  ├─ users-manage/
│  │  └─ prompt-variants/
│  ├─ config.toml             verify_jwt mapping per function
│  └─ seed.sql
│
├─ e2e/                       Opt-in Playwright (login.spec.ts)
├─ integration/               Opt-in vitest vs `supabase start`
├─ .github/workflows/ci.yml   typecheck → lint → test → build
├─ DEPLOYMENT.md              ← קרא ראשון
├─ IMPLEMENTATION-STATUS.md
├─ HANDOFF.md                 ← המסמך הזה
├─ OPEN-WORK-PLAN.md          (ישן, מוחלף ע"י HANDOFF.md)
├─ karnaf-crm-full-spec.md    מפרט מקורי, מקור אמת מוצרי
└─ <שאר מסמכי ה-spec>          רקע מעמיק
```

---

## 4. מה הושלם — סיכום ב־commits

הריפו ב־GitHub כעת מכיל 6 commits שנדחפו ב־2026-04-28:

| Commit | תיאור |
|---|---|
| `fc91ecc` | **chore: workspace tooling** — package.json, package-lock.json, tsconfig (strict + paths), vite/vitest/eslint/prettier configs, .env.example, GitHub Actions CI, playwright.config.ts |
| `62b8473` | **feat(db): hardening migrations 002-017** — profiles + RLS + state-machine RPCs + analytics views + rate limit + retention + scheduled jobs + prompt_variants A/B + media bucket + email/summary config |
| `2ee2449` | **feat(backend): hardened Edge Functions** — 5 public webhooks (HMAC + rate-limit), 3 service-role workers (orchestrator, sla-worker, nightly-jobs), 9 JWT-gated operator endpoints, AI runtime עם playbooks + variants + circuit breaker |
| `ff830aa` | **feat(frontend): Tailwind shell + auth + 7 pages** — Dashboard, Leads, LeadDetail, Queue, Analytics, Users, PromptVariants עם toasts + i18n seam + a11y |
| `9c59977` | **test: 151 vitest suites + Playwright + integration harness** — 77 unit (lib/runtime) + 74 component (apps/web), opt-in E2E + integration |
| `248edcc` | **docs: DEPLOYMENT.md + IMPLEMENTATION-STATUS.md + OPEN-WORK-PLAN.md** |
| `f1063ab` | **fix: stabilize operator auth and queue urgency** |
| `7238334` | **docs(README): rewrite root README as router to HANDOFF / DEPLOYMENT / STATUS** |
| `e76a5ea` | **feat(i18n): route more high-traffic UI through dictionary seam** |
| `db2160b` | **test: component coverage for AnalyticsPage, QueuePage, PromptVariantsPage** |
| `b8e53d5` | **feat(analytics): cohort breakdown + first-response SLA tracking** |

`git log origin/master..HEAD` יראה את אלה אם מ־clone חדש.

---

## 5. מה לא מוכן עדיין — סדור לפי דחיפות

### P0 — חוסמי הפעלה בפרודקשן

אלה דברים שאי אפשר לקבל לידים אמיתיים בלעדיהם. כולם תלויים ב־credentials שלך (לא בקוד).

| # | משימה | עומק | תלות |
|---|---|---|---|
| P0.1 | **לפתוח Supabase project + לחבר ה־CLI** (`supabase link`) | 30 דק' | חשבון Supabase |
| P0.2 | **`supabase db push`** של 17 המיגרציות | 5 דק' | P0.1 |
| P0.3 | **להפעיל extensions:** pgcrypto, pg_cron, pg_net, vault | 2 דק' | P0.1 — Dashboard > Database > Extensions |
| P0.4 | **להגדיר `app.sla_worker_url` + `app.nightly_jobs_url`** ב־Postgres + להכניס `sla_worker_secret` ל־vault | 10 דק' | P0.3 — DEPLOYMENT.md §2 |
| P0.5 | **להכניס את כל ה־secrets ל־Edge Functions** (טבלה ב־DEPLOYMENT.md §3) | 30 דק' | חשבונות Meta/Open AI/payment |
| P0.6 | **`supabase functions deploy`** של כל 19 ה־functions | 5 דק' | P0.5 |
| P0.7 | **להגיש ל־Meta את template `karnaf_followup_v1` בעברית + לחכות לאישור** | 10 דק' עבודה + 24-72 שעות המתנה | חשבון Meta WABA |
| P0.8 | **לחבר webhook ב־Meta** ל־`/whatsapp-webhook` עם ה־VERIFY_TOKEN | 10 דק' | P0.6 |
| P0.9 | **לקבל מ־רב מסר/Skooler דוגמת payload + מנגנון חתימה** ולהתאים אם צריך | 1-2 שעות | קשר עם רב מסר |
| P0.10 | **לחבר את הטפסים** (landing pages, webinar) ל־`/leads-intake` עם HMAC | 1 שעה לכל מקור | INTAKE_WEBHOOK_SECRET |
| P0.11 | **ליצור משתמש ראשון Mia** + לקדם ל־`role='owner'` (DEPLOYMENT.md §7) | 5 דק' | P0.6 |
| P0.12 | **לפרוס frontend ב־Vercel** עם `VITE_SUPABASE_*` envs | 30 דק' | חשבון Vercel + דומיין |
| P0.13 | **CORS_ALLOWED_ORIGINS** בדומיין הפרודקשן + לדפלוי functions שוב | 5 דק' | P0.12 |
| P0.14 | **לרוץ על Pre-flight checklist** ב־DEPLOYMENT.md §9 | 1 שעה | הכל למעלה |

> סה"כ עבודה אנושית: ~6-8 שעות + 24-72 שעות המתנה לאישור template ב־Meta.

### P1 — דורש עבודת מפתח, לא חוסם הפעלה אבל קריטי לאיכות

| # | משימה | עומק | סטטוס |
|---|---|---|---|
| P1.1 | **Sentry SDK אמיתי** במקום ה־POST hook הבסיסי שב־`lib/observability.ts` | חצי יום | hook קיים → לחבר `@sentry/react` |
| P1.2 | **Iteration על ה־prompts בעברית** מול 50 שיחות אמת בשבועיים הראשונים. `/prompts` UI מוכן | מתמשך, 5-10 שעות בשבוע | Infra A/B מוכן |
| P1.3 | **Component tests** לזרמי מסך חסרים נוספים מעבר לכיסוי החדש של AnalyticsPage, QueuePage, PromptVariantsPage | חצי יום | כיסוי למסכים הללו כבר נוסף |
| P1.4 | **Playwright** הרחבת `e2e/` מעבר ל־login: send-reply, mark_won, queue resolve, admin role gating | יום | בסיס מוכן |
| P1.5 | **Integration tests מול `supabase start`** הרחבת `integration/orm.spec.ts` ל־webhooks דרך HTTP, לא רק RPCs | יום-יומיים | בסיס מוכן |
| P1.6 | **Outbound email composer** (היום email-webhook הוא inbound only). דורש ספק email + form ב־UI | 1-2 ימים | תלוי בבחירת ספק |
| P1.7 | **תרגום מלא של ה־UI דרך `t()` seam** (היום יותר מסכי ליבה כבר מחוברים, אך לא הכל) — מועיל גם אם נשארים בעברית | חצי יום | infra קיים |
| P1.8 | **Bootstrap admin promotion** (`014_bootstrap_admin.sql`) — לסקור ולוודא שהיא תואמת אסטרטגיית הצטרפות | שעה | אתה כתבת את זה ידנית |

### P2 — איכות לטווח קצר-בינוני

| # | משימה | עומק |
|---|---|---|
| P2.1 | **Mobile UI smoke** ב־iPhone + Android אמיתיים (ה־responsive Tailwind נראה טוב, צריך לוודא) | חצי יום, ידיים על מכשיר |
| P2.2 | **Accessibility audit ידני** ב־axe-core/Lighthouse + תיקונים | יום |
| P2.3 | **`prompt-variants` analytics לעומק** — חיתוך לפי source/heat, לא רק playbook | יום |
| P2.4 | **Phone sales rep workflow** — היום יש form לתיעוד שיחה, אפשר להעמיק (call queue, scheduling, callbacks) | 2-3 ימים |
| P2.5 | **שיפור transcript summary** — קונפיגורציה ב־`crm_config.summary_runtime` קיימת, אפשר להעמיק עם chunking, multi-turn distillation | 1-2 ימים |
| P2.6 | **Backups verification** — Supabase יש PITR אוטומטי, אבל לתעד RPO/RTO ולעשות restore drill | חצי יום |
| P2.7 | **API documentation** — להפיק OpenAPI מה־Edge Functions (לטובת אינטגרציות עתידיות) | יום |

### P3 — מעבר 100/100, מסלול ארוך טווח

| # | משימה | עומק |
|---|---|---|
| P3.1 | **Multi-product support** — היום ה־schema תומך, אבל ה־AI/playbooks מקודדים ל"הדרך לדירה" | 3-5 ימים |
| P3.2 | **Cohort analytics** — להעמיק מעבר ל-week/source שכבר נוספו, לכיוון retention, time-to-purchase, source ROI | 1-2 ימים |
| P3.3 | **WhatsApp media analysis** (תמונות, אודיו) ב־AI — היום נשמר ב־Storage אבל לא נקרא | 2-3 ימים |
| P3.4 | **Instagram DM ingestion** דרך Meta Graph API | 1-2 ימים |
| P3.5 | **Slack/Telegram notifications** ל־alerts (SLA breach, hot lead) | יום |

---

## 6. תלויות חיצוניות שהמפתח לא יכול לפתור לבד

המפתח יצטרך ממך:

| תלות | למה | מי הולך להשיג? |
|---|---|---|
| Supabase project credentials | DB + Edge Functions | בעל המוצר |
| Meta WhatsApp Business Account + permanent token + WABA Phone ID + App Secret | Inbound + Outbound WhatsApp | בעל המוצר (verification דורש מסמכים עסקיים) |
| OPENAI_API_KEY | AI runtime | בעל המוצר (חשבון בתשלום) |
| חתימת webhook ל־רב מסר/Skooler + sample payload | Payment integration | קשר ישיר עם הספק |
| INTAKE_WEBHOOK_SECRET (אתה ממציא) + הגדרת HMAC בכל טופס לידים | Lead intake | בעל המוצר + מי שמתחזק טפסים |
| EMAIL_WEBHOOK_SECRET + ספק email (Mailgun/Postmark/SendGrid) | Email channel | בעל המוצר |
| נוסח טקסט ל־`karnaf_followup_v1` template + שפה | Outbound מחוץ ל־24h window | בעל המוצר + Mia |
| First Mia user email + password | Login first time | בעל המוצר |
| Production domain | CORS + Vercel | בעל המוצר |
| Vercel team/account | Frontend hosting | בעל המוצר |

עד שכל הפריטים האלה זמינים — המפתח יכול:
1. להריץ את הכל מקומית מול `supabase start`.
2. לכתוב בדיקות אינטגרציה.
3. לעבוד על P1/P2/P3 שלא תלויים ב־credentials.
4. להמשיך iterating על ה־UI.

---

## 7. סדר עבודה מומלץ למפתח

### שבוע 1 — חיבור לסביבה אמיתית
1. ליצור Supabase **staging** project (לא prod עדיין).
2. לעבור על P0.1-P0.6 ב־staging כדי לראות שהכל קם.
3. להגיש את ה־template ל־Meta (פעולה ארוכת המתנה — להתחיל מוקדם).
4. להפעיל את הוובהוקים מול Meta sandbox (ולא מספר פרודקשן עדיין).
5. לוודא שכל ה־checklist ב־DEPLOYMENT.md §9 עוברים על staging.

### שבוע 2 — חיווט מקורות אמיתיים
1. לחבר טופס אחד ל־`/leads-intake`.
2. לחבר webhook של רב מסר/Skooler ל־`/payment-webhook` (אחרי שיש sample payload).
3. לרוץ E2E מול staging (ידנית): ליד נכנס מ־טופס → AI עונה → תשלום → `won` → onboarding queue.
4. לבדוק ש־SLA worker רץ נכון (חיכיון של 12 שעות מבושם דרך `update leads set last_inbound_at = now() - interval '13 hours'` ידני).

### שבוע 3 — Cutover לפרודקשן
1. ליצור Supabase **production** project.
2. לעבור על P0 כולו על ה־prod project.
3. להחליף ב־Meta את ה־webhook לכתובת ה־prod.
4. להחליף ב־טפסים ובקופה את ה־webhooks לכתובת ה־prod.
5. לפרוס ב־Vercel עם ה־ENVs של prod.
6. לעקוב על ה־logs (Supabase > Functions > Logs) ב־24 שעות הראשונות.

### שבוע 4+ — Iteration + P1/P2
1. Sentry + alerts.
2. Tuning של ה־prompts בעברית מול שיחות אמיתיות.
3. הרחבת ה־component tests + Playwright.
4. כל מה שמ־P1.

---

## 8. צ'קליסט קבלה (QA) לפני go-live

לפני שמספר WhatsApp אמיתי מפנה לוובהוק:

- [ ] `supabase db push` הצליח על production project, כל 17 המיגרציות.
- [ ] `select * from cron.job` מציג: `karnaf_sla_worker`, `karnaf_nightly_jobs`, `karnaf_purge_rate_limit`.
- [ ] `pgcrypto`, `pg_cron`, `pg_net`, `vault` מופעלים.
- [ ] `vault.create_secret('<random>', 'sla_worker_secret')` רץ.
- [ ] `app.sla_worker_url` ו־`app.nightly_jobs_url` מוגדרים ב־`alter database postgres set ...`.
- [ ] Frontend עולה ב־Vercel; דף login מופיע ב־production domain.
- [ ] Mia user נוצר עם `role='owner'`. הצליח להתחבר.
- [ ] `/dashboard` נטען ללא שגיאות.
- [ ] `GET /whatsapp-webhook?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=42` מחזיר `42`.
- [ ] שלחת הודעה מ־WhatsApp אישי לטסטים — היא הופיעה ב־`messages` עם `provider_message_id` ייחודי.
- [ ] ב־`ai_decisions` יש שורה עם `execution_status='openai_success'` (אם מודל מחובר).
- [ ] AI שלח reply שהגיעה ל־WhatsApp.
- [ ] שלחת payload בדיקה ל־`/payment-webhook` עם signature תקין → ליד עבר ל־`won` + `lead_tasks` עם `flow=onboarding_kickoff` נוצרו.
- [ ] Mia הצליחה לסמן ליד DNC מתוך `/leads/<id>` → סטטוס עבר ל־`do_not_contact`.
- [ ] Mia שלחה manual reply דרך LeadDetail → ההודעה הגיעה לוואטסאפ.
- [ ] Mia הוסיפה log of phone call → טאסק `phone_call_logged` נוצר.
- [ ] Owner נכנס ל־`/users` והוסיף משתמש viewer חדש; viewer לא רואה את `/users` ולא את `/prompts`.
- [ ] Owner נכנס ל־`/prompts`, יצר variant נוסף עם weight=50 על playbook `qualification`, וראה אותו ב־`/analytics` תוך כמה דקות.
- [ ] בקשת "תסיר אותי" מ־WhatsApp → `lead_status='do_not_contact'`, ה־AI לא שולח עוד.

---

## 9. תפעול שוטף (Day-2)

### Logs
- Supabase Studio > Logs > Edge Functions. סנן לפי `fn` או `correlationId`.
- כל webhook ו־orchestrator עוטף עם `correlation_id` שמתפזר לאורך כל ה־chain — זה ה־primary key ל־debug.

### Metrics
- `/analytics` ב־UI מציג funnel + source perf + AI vs Mia + prompt variants.
- `select * from v_recent_activity limit 20` ב־SQL ל־live activity.

### Health checks (אוטומטיים)
- `karnaf_sla_worker` רץ כל 10 דקות. אם אין `select * from work_queue where queue_type='sla_risk'` למרות שיש לידים ישנים — הבעיה היא ב־vault secret או ב־`app.sla_worker_url`.
- `karnaf_nightly_jobs` רץ ב־02:00 IL.

### Operations Mia עושה יומיומית
1. בודקת `/queue` (תור אדום = SLA risk / human handoff / phone escalation).
2. עוברת על `/leads?heat=hot` לסקירה.
3. סוגרת payment-pending leads.
4. בסוף יום: marks won/lost/dnc.

### Audit trail
- כל פעולה ידנית כותבת ל־`lead_events` עם `actor_type`, `actor_id`, `event_payload.correlation_id`.
- `select event_type, actor_type, count(*) from lead_events where created_at > now() - interval '7 days' group by 1,2 order by 3 desc` ייתן תמונת פעילות.

---

## 10. שאלות שאני ממליץ לסגור עם המפתח לפני התחלה

1. **Staging vs Production** — האם פותחים שני Supabase projects? (מומלץ; ההפרדה זולה.)
2. **Domain strategy** — `crm.karnaf.com` או subdomain אחר? אצל איזה רשם?
3. **WhatsApp number** — האם זה מספר חדש ייעודי או הרחבת מספר קיים? (ה־spec ממליץ על מספר ייעודי.)
4. **Email provider** — אם רוצים inbound email, איזה ספק? (Mailgun/Postmark/SendGrid כולם עובדים עם הקוד הקיים בלי שינוי.)
5. **Outbound email** — האם בכלל רלוונטי? אם כן, צריך SMTP/API נפרדים.
6. **Sentry / Logflare** — חשבון קיים? אם לא, איזה ספק?
7. **Backup retention** — Supabase ברירת מחדל 7 ימים PITR. צריך יותר?
8. **Migration ownership** — מי כותב מיגרציות חדשות? פרוצדורת PR?
9. **Prompt iteration ownership** — מי כותב/מאשר נוסחי הודעות בעברית? Mia? בעלים?
10. **SLA אמיתי** — 12 שעות ב־spec, אבל בפועל מה האירוע בשעות הלילה? האם מותר ל־AI לענות אחרי 21:00?

---

## 11. מקורות לקריאה

לפי סדר חשיבות למפתח שמתחיל:

1. **DEPLOYMENT.md** — runbook פריסה צעד אחר צעד.
2. **IMPLEMENTATION-STATUS.md** — מה קיים בכל שכבה.
3. **HANDOFF.md** (המסמך הזה) — מה לעשות הלאה.
4. **karnaf-crm-full-spec.md** — מפרט מקורי, מקור אמת מוצרי.
5. **karnaf-crm-master-implementation-blueprint.md** — אדריכלות גבוהה.
6. **karnaf-crm-supabase-schema-spec.md** — תיאור הסכמה (יושב ביישום בפועל ב־migrations).
7. **karnaf-crm-env-secrets-deploy-map.md** — מפת secrets (כפול על DEPLOYMENT.md אבל מתאר את ה־"למה").
8. **autonomous-crm-operating-model.md** — אופי המוצר ופילוסופיית התפעול.
9. **karnaf-crm-build-roadmap.md, karnaf-crm-v1-engineering-backlog.md** — backlog מקורי, נחתך ב־HANDOFF.md הזה.

ב־`supabase/functions/README.md` יש מפת Edge Functions קצרה.

---

## 12. תמיכה / שאלות

הקוד מתועד בשפע inline. כל פונקציה גדולה כתובה בלשון עיתון: רישא קצרה שמסבירה למה הקוד קיים, לא רק מה הוא עושה. נקודות חשובות:

- **`supabase/functions/_shared/auth.ts`** — איך JWT verification + role gate עובדים. אם אי פעם תהיה תקלת 403 פתאומית — להתחיל כאן.
- **`supabase/functions/_shared/state-machine.ts`** + **`supabase/migrations/008_runtime_rpcs.sql`** — מה מותר ומה אסור במעברי lead_status. שינוי שם דורש זהירות.
- **`supabase/functions/_shared/ai-validation.ts`** — כל ה־guardrails על ה־AI. שם נחסמות תגובות עם הבטחות אסורות.
- **`supabase/functions/_shared/playbooks.ts`** — לוגיקת בחירת ה־flow לפי הקשר. הוסף playbook חדש כאן.
- **`apps/web/src/lib/api.ts`** — קליינט API טייפ-בטוח. כל endpoint חדש צריך typed function כאן.

תאריך: 2026-04-28.
