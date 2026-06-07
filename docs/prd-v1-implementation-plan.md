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

## Still recommended for Phase 2d

- Add working-hours logic for human handoff.
- Submit/approve WhatsApp templates before using proactive out-of-window router messages.
- Add a light audit/export view for router option changes if operators start changing options frequently.

## Recommended Phase 3

Meetings + onboarding:
- meeting scheduling endpoint
- calendar integration
- meeting status/no-show automation
- program onboarding tasks and keep-alive state

## Recommended Phase 4

Measurement:
- conversion funnel by track/stage/source
- webinar registered → attended → purchased dashboard
- rep activity / response-time dashboard
- program member progress report
