# supabase

This folder should contain:
- SQL migrations for the Karnaf CRM Core schema
- edge functions for intake, WhatsApp runtime, orchestration, payments, and admin actions
- optional seed/config scripts

Recommended first implementation order:
1. `migrations/001_initial_schema.sql`
2. `functions/whatsapp-webhook`
3. `functions/orchestrate-message`
4. `functions/payment-webhook`
