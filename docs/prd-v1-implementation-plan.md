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

## Recommended Phase 2

Build capture and routing surfaces:
- intake payload contract per form/source
- WhatsApp topic router config
- explicit Deal stage transitions per track
- webinar registration and attendance import/update endpoint
- queue views for “לא בחר נושא” and “מבקש נציג”

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
