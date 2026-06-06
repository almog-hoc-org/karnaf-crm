# Karnaf CRM — AI bot ↔ real customer E2E test plan

Purpose: prove that a real WhatsApp lead can move through intake, AI response, status changes, human takeover, return to AI, provider delivery statuses, failure handling, and final lifecycle states without silent drops or wrong-owner replies.

## Preconditions

- CRM Supabase project reachable.
- Supabase function secrets configured: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, WhatsApp provider secrets, `OUTBOUND_DISPATCH_SECRET`, selected AI provider secret (`AI_PROVIDER=openai|gemini`, matching key), webhook signatures.
- `dispatch-outbound` cron active or manually invokable.
- Operator user exists with `owner/admin/mia` role.
- Test WhatsApp phone that is allowed to receive messages from the configured provider.
- Use a unique test identity per run: `E2E <timestamp>` and phone `<real test phone>`.

## Observability to capture every run

For each scenario, record:

- `lead.id`, `conversation.id`, latest `correlationId`.
- Rows in `messages`, `lead_events`, `work_queue`, `outbound_dispatch`, `integration_logs`.
- Lead fields before/after: `lead_status`, `ownership_mode`, `lead_heat`, `lead_score`, `last_inbound_at`, `last_outbound_at`, `human_owner_id`, `last_human_touch_at`, `do_not_contact`, `removed_by_request`.
- Provider callback status: `sent → delivered → read` or `failed` with `provider_error`.

## Test matrix

### 1. Fresh real WhatsApp lead → AI first response

Steps:
1. Send inbound WhatsApp from the real test phone: "היי, אני רוצה להבין אם התוכנית מתאימה לי".
2. Verify webhook returns 200 and creates/updates lead.
3. Verify `messages` has inbound lead message.
4. Verify `outbound_dispatch` row is queued, then completed after dispatcher.
5. Verify `orchestrate-message` sends one AI reply.

Expected:
- `lead.source=whatsapp`, `ownership_mode=ai_active`.
- Status moves legally, normally `new → first_contact_sent` or `responded` depending playbook decision.
- One outbound AI message only; no duplicate reply on webhook retry.
- Provider status eventually updates via `provider-status-webhook`.

### 2. Duplicate inbound webhook/idempotency

Steps:
1. Replay the exact same provider message payload/signature.

Expected:
- No second inbound message.
- No second outbound dispatch.
- Response is success with duplicate/skipped reason.

### 3. Human takeover from active AI

Steps:
1. In CRM, send a manual reply as Mia on the same lead.
2. Then send another WhatsApp inbound from the customer.
3. Run/observe dispatcher.

Expected:
- Manual reply sends through provider and is saved as `sender_type=mia` or `sales_rep`.
- `ownership_mode` flips `ai_active → mia_active`.
- If current status legally allows it, status transitions to `human_handoff`.
- Conversation ownership stays synced with lead ownership.
- The next customer inbound is logged and creates/keeps a human queue item.
- AI does **not** send a reply while ownership is `mia_active`.

### 4. Explicit assign to Mia

Steps:
1. Trigger `admin-actions.assign_to_mia`.
2. Send customer inbound.

Expected:
- Lead and open conversation ownership both `mia_active`.
- Status `human_handoff`.
- `work_queue` has `human_handoff`.
- AI is deterministically suppressed; no reliance on prompt/model behavior.

### 5. Return from Mia to AI

Steps:
1. Trigger `admin-actions.return_to_ai` with the active `conversationId`.
2. Observe orchestrator invocation.
3. Send a customer follow-up if needed.

Expected:
- `ownership_mode=mia_active → ai_active` and `human_owner_id=null`.
- If status was `human_handoff`, it moves back to `responded`.
- AI sends a relevant next reply once, not zero and not duplicate.
- Future customer inbound is handled by AI.

### 6. Phone escalation

Steps:
1. Customer asks for a call or AI triggers phone escalation after repeated free advice.
2. Alternatively trigger `admin-actions.mark_phone_escalation`.
3. Send customer inbound.

Expected:
- `ownership_mode=phone_sales_pending`, `requested_phone_call=true`.
- `work_queue.queue_type=phone_escalation`, priority 1.
- AI does not continue chatting while phone owner is pending.
- Sales/operator can log phone call; `last_human_touch_at` updates.

### 7. Suppression / DNC / removed by request

Steps:
1. Customer says "תפסיקו לשלוח לי הודעות" or operator marks DNC.
2. Send another inbound.

Expected:
- `do_not_contact=true` or `removed_by_request=true`.
- Status moves to `do_not_contact`/`removed_by_request` legally.
- Orchestrator returns skipped `suppressed`.
- No outbound AI/manual send is allowed.

### 8. Provider send failure

Steps:
1. Temporarily use an invalid provider token or a blocked test number in staging.
2. Trigger AI or manual send.

Expected:
- No silent success.
- `integration_logs.status=error`.
- `work_queue.queue_type=failed_automation`, priority 1.
- `outbound_dispatch` retries then dead-letters according to policy.

### 9. Payment lifecycle

Steps:
1. Move lead to checkout/payment pending through AI or webhook.
2. Fire signed payment webhook for pending, failed, and paid.

Expected:
- Pending → `payment_pending`.
- Paid → `won`, `payment_status=paid`, `won_at` set.
- Failed does not incorrectly close the lead; queue/task created if needed.
- Closed leads require audited `reopen_lead` before AI resumes.

### 10. Non-WhatsApp channels

Steps:
1. Create an email/inbound non-WhatsApp conversation.
2. Invoke orchestrator.

Expected:
- Orchestrator skips with `non_whatsapp_channel`.
- Human handoff queue item exists.
- No WhatsApp message is sent for non-WhatsApp conversation.

## Known blockers for a true live run

- Need Vercel access to `almoghocs-projects` for the website live-domain handoff.
- Need a real test WhatsApp number and provider credentials/allowlist.
- Need operator CRM login/session for UI-driven human takeover tests.

## Current code gaps fixed in this pass

- AI replies are now deterministically suppressed when `leads.ownership_mode !== 'ai_active'`.
- Lead ownership updates now sync open conversations' `ownership_mode`.
- Manual reply takeover now marks ownership as Mia and transitions to `human_handoff` when the state machine allows it.
- Manual reply now fails clearly if the lead has no phone.
