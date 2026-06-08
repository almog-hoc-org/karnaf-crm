# Karnaf CRM PRD v1 — Implementation Plan

## Product direction

The CRM should remain one unified system, not three separate CRMs. The existing `leads` table is the unified Contact record. Product-specific sales journeys are represented as Deals/Pipelines attached to the same lead.

## PRD tracks

- `program` — תכנית הליווי
- `presale` — פריסייל / חתימה
- `investor_mentorship` — ליווי משקיעים

## Phase 1 shipped foundation

- Added PRD contact fields to `leads`:
  - `primary_track`
  - `active_tracks`
  - `interest_topic`
  - `tags`
  - `consent_whatsapp`
  - `consent_email`
  - `consent_updated_at`
- Added core entities:
  - `deals`
  - `meetings`
  - `webinars`
  - `webinar_registrations`
  - `program_members`
- Updated `leads-intake` so submissions can resolve a PRD track/stage and create/update an open Deal per lead+track.
- Updated `payment-webhook` so successful program payments create/update `program_members` and close the relevant Deal as won.
- Updated `lead-detail` and the Lead Detail UI to show the new pipeline/deal/meeting/program-member context.

## Current stage mapping

### Program
- `new`
- `webinar_registered`
- `phone_call_booked`
- `paid_program_member`

### Presale
- `new`
- future: `phone_call_done`, `meeting_scheduled`, `office_meeting_held`, `signed`

### Investor mentorship
- `form_submitted`
- future: `shahar_phone_call_done`, `zoom_meeting`, `closed_won`

## Still open from PRD

1. WhatsApp router menu: static vs dynamic by active presales.
2. Working hours + human handoff rules.
3. Presale fields: active project catalogue and partner ownership model.
4. Shared investor list permissions for Shahar/partners.
5. Final WhatsApp/email template copy and Meta approvals.
6. Exact progress metrics for program-member reports.
7. No-show/cancellation automation rules.
8. Multi-product conflict rules when a contact has several open Deals.

## Phase 2 shipped routing/capture foundation

- Added configurable WhatsApp router options in `whatsapp_router_options`.
- Added `whatsapp_router_state` so new WhatsApp contacts can be prompted for a topic and routed once they reply.
- `whatsapp-webhook` now prompts untracked WhatsApp leads with a simple text menu, routes replies to `program` / `presale` / `investor_mentorship`, and queues human follow-up where needed.
- Added `deal_stage_history` and `advance_deal_stage(...)` RPC for audited Deal stage transitions.
- Added operator buttons in Lead Detail to advance Deal stages by track.
- Added `webinar-events` webhook for webinar registration/attendance/purchase signals, updating `webinars`, `webinar_registrations`, Deals, and follow-up queue items.
- Added queue labels/filters for WhatsApp router and webinar follow-up lists.

## Phase 2b shipped intake contracts

- Added `intake_source_contracts` for explicit external form contracts.
- Seeded PRD contracts for webinar registration, phone-call request, presale form, investor mentorship form, and WhatsApp topic-selection documentation.
- `leads-intake` now applies contract aliases, validates required contract fields, applies default track/stage/topic/tags, and records the contract key in events/queue metadata.
- The Sources admin page now shows configured intake contracts per source.
- Added `docs/prd-v1-intake-contracts.md` with integration examples.

## Phase 2c shipped dynamic WhatsApp router management

- Added owner/admin `whatsapp-router-options` function for CRUD over `whatsapp_router_options`.
- Added `/admin/whatsapp-router` UI to create, edit, activate/deactivate, reorder, and delete topic routing options.
- Router changes now affect WhatsApp topic selection from DB without code changes or SQL access.

## Phase 2d shipped working-hours handoff logic

- Added explicit `active_hours.workingDays` config, defaulting to Israel work week Sunday-Thursday.
- Human WhatsApp handoff now schedules `work_queue.due_at` and `leads.next_action_due_at` according to active hours.
- Customer acknowledgement now distinguishes immediate handoff from outside-hours handoff without promising an instant human reply.
- Queue payload/events include whether the request arrived during open hours and the next opening label.

## Phase 2e shipped admin runtime settings

- Added owner/admin `runtime-config` function for low-risk runtime settings.
- Added `/admin/settings` UI to edit active hours, timezone, and working days without SQL.
- Active-hours edits immediately affect new human handoff scheduling.

## Phase 2f shipped router option audit

- Added persistent audit table for WhatsApp router option create/update/delete events.
- Added a light audit log inside `/admin/whatsapp-router` showing recent changes and changed fields.

## Phase 2g shipped router audit export

- Added CSV export for the WhatsApp router audit log from `/admin/whatsapp-router`.

## Phase 2h shipped WhatsApp template readiness

- Added a safe runtime-config readout for WhatsApp session settings.
- Added `/admin/settings` visibility for the configured fallback template and the hard Meta approval blocker.

## Still recommended for Phase 2i

- Submit/approve WhatsApp templates in Meta Business before using proactive out-of-window router messages.

## Phase 3a shipped daily inbox operator clarity

- Improved `היום שלי` as the primary rep work surface:
  - each card now shows clear reason chips such as overdue, hot lead, sales call, support/customer, blocked/risk, and product context.
  - daily focus highlights the first lead to open and why.
  - cards include a short `מה להגיד עכשיו` talk-track personalized by lane, first name, and product where available.
  - reps can copy the talk-track directly; this is only operator assistance and never sends a customer message automatically.
- Extended `attention_inbox` with `queue_type` and `queue_summary` so the UI can classify and explain queue cards using structured backend context instead of relying only on free-text reasons.
- Kept the implementation lightweight: no new heavy CRM screen, no WhatsApp policy bypass, and no automation behavior change.

## Phase 3b shipped daily inbox safe actions + WhatsApp policy visibility

Continued improving rep execution before adding heavier workflows:
- Extended `attention_inbox` with `last_inbound_at` and `last_outbound_at` so the UI can explain WhatsApp customer-care window state from structured lead timestamps.
- Daily inbox cards now show explicit WhatsApp state:
  - `WhatsApp פתוח למענה חופשי` when the last customer inbound is inside the 24h freeform window.
  - `WhatsApp מחוץ לחלון 24 שעות` when replies should be queued until customer inbound or a Hebrew Meta template is approved.
- Added safe `פתיחת WhatsApp` action on WhatsApp-relevant daily inbox cards using normalized `wa.me` links.
- This action only opens WhatsApp and never sends a customer message automatically.
- The blocker remains visible: proactive reopen after 24h still requires an approved Hebrew Meta template.

## Phase 3c in progress — rep execution actions

Started with low-risk rep-execution improvements before heavier scheduling/calendar work:
- Daily inbox call cards now expose a clear `חיוג עכשיו` tel action when a phone number exists.
- Call cards can record `אין מענה` directly from `היום שלי` through the audited `log_phone_call` admin action, after confirmation.
- Lead Detail PRD pipeline cards can schedule a CRM-only meeting through the audited `schedule_meeting` admin action.
- Meeting scheduling updates `meetings`, `next_action_type`, `next_action_due_at`, `last_human_touch_at`, and logs a `meeting_scheduled` event.
- Scheduled meetings can be marked from Lead Detail as `התקיימה`, `לא הגיע`, or `בוטלה` through the audited `update_meeting_status` admin action.
- These are internal CRM actions only: no customer message is sent and no external Calendar event is created yet.

Still recommended for Phase 3c:
- calendar integration for meetings after the CRM-only scheduling path is stable.
- follow-up automation after no-show/cancellation.
- program onboarding tasks and keep-alive state.

## Recommended Phase 4

Measurement:
- conversion funnel by track/stage/source
- webinar registered → attended → purchased dashboard
- rep activity / response-time dashboard
- program member progress report
