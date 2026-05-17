# Runbook — AI provider quota exhausted

**Symptom:** orchestrate-message logs report `circuit_open` repeatedly;
new inbound WhatsApp messages don't get AI replies. Mia notices the
queue filling up with `human_handoff` items.

## Triage (≤ 5 min)

1. `supabase functions logs orchestrate-message | head -20`
   - Look for `ai_circuit_open` events (breaker tripped).
   - Look for `openai_timeout` or `openai_error:<status>` lines.
2. Check OpenAI status: https://status.openai.com
3. Check OpenAI usage dashboard for quota / billing block.

## Mitigation

### If quota legitimately hit

- Top up billing at https://platform.openai.com/account/billing
- Wait 5 minutes — the circuit breaker auto-cools (`threshold:3, cooldownMs:5min`).
- Verify by triggering a test inbound; should get an AI reply.

### If OpenAI is genuinely down

- Set `crm_config.ai_enabled_channels` to `[]` so the orchestrator queues
  `human_handoff` for every inbound instead of trying to call OpenAI.
- Telegram-alert the team — Mia takes the wheel.
- Once OpenAI is back, restore `ai_enabled_channels` to `['whatsapp']`.

### Force a model swap

```bash
supabase secrets set OPENAI_MODEL=gpt-4o --project-ref svkzkpgccahwmyflobvn
supabase functions deploy orchestrate-message --project-ref svkzkpgccahwmyflobvn
```

## After the incident

- Reset breaker won't be needed; auto-recovers.
- File postmortem if outage > 30 min.
