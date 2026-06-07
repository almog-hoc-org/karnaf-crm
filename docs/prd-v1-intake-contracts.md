# Karnaf CRM PRD v1 — Intake Payload Contracts

All external form/webhook submissions should call `leads-intake` with:

- `source` — active `lead_sources.slug`
- `contract_key` — one of the active `intake_source_contracts.contract_key`
- either `phone`/`mobile` or `email`
- optional consent fields: `consent_whatsapp`, `consent_email`

The intake function applies the contract before classification:

1. resolves aliases (for example `mobile` → `phone`, `name` → `full_name`)
2. validates required contract fields
3. applies default PRD track/stage/topic/tags
4. writes the selected contract key into lead metadata, queue payload, and lead events

## Contracts shipped

### `webinar_registration_v1`

Source: `webinar_registration`

Defaults:

- track: `program`
- stage: `webinar_registered`
- topic: `וובינר תכנית הליווי`

Required:

- `webinar_name`
- `webinar_date`

Example:

```json
{
  "source": "webinar_registration",
  "contract_key": "webinar_registration_v1",
  "full_name": "ישראל ישראלי",
  "phone": "0501234567",
  "email": "lead@example.com",
  "webinar_name": "וובינר הדרך לדירה",
  "webinar_date": "2026-06-10T18:00:00+03:00",
  "consent_whatsapp": true
}
```

### `phone_call_request_v1`

Source: `phone_call_request`

Defaults:

- track: `program`
- stage: `phone_call_booked`
- topic: `בקשת שיחה`

Example:

```json
{
  "source": "phone_call_request",
  "contract_key": "phone_call_request_v1",
  "full_name": "ישראל ישראלי",
  "phone": "0501234567",
  "preferred_time": "מחר בבוקר",
  "message": "רוצה להבין התאמה לתכנית"
}
```

### `presale_form_v1`

Source: `presale_form`

Defaults:

- track: `presale`
- stage: `new`
- topic: `פריסייל`

Required:

- `presale_project`

Example:

```json
{
  "source": "presale_form",
  "contract_key": "presale_form_v1",
  "full_name": "ישראל ישראלי",
  "phone": "0501234567",
  "presale_project": "פרויקט לדוגמה",
  "partner_name": "שותף א"
}
```

### `investor_mentorship_form_v1`

Source: `investor_mentorship_form`

Defaults:

- track: `investor_mentorship`
- stage: `form_submitted`
- topic: `ליווי משקיעים`

Example:

```json
{
  "source": "investor_mentorship_form",
  "contract_key": "investor_mentorship_form_v1",
  "full_name": "ישראל ישראלי",
  "phone": "0501234567",
  "budget": "1.2M",
  "message": "מחפש ליווי להשקעה"
}
```

### `whatsapp_topic_selection_v1`

Source: `whatsapp_topic_selection`

Internal/documentation contract for WhatsApp topic routing events.

## Notes

- Unknown/disabled sources still fall back to `unknown` and do not apply a contract.
- A requested `contract_key` must belong to the submitted `source`; mismatches are ignored and logged.
- Contracts are additive and do not replace the dedicated `webinar-events` webhook for attendance/purchase events.
