-- Karnaf CRM Core - Realtime publication for live operator UI.
--
-- ⚠️ BUG FIX (operator-reported, 2026-05-15):
-- Mia reports the LeadDetailPage doesn't update LIVE — incoming WhatsApp
-- messages don't appear while she's viewing the conversation, so she
-- misses messages mid-conversation. Root cause: the `supabase_realtime`
-- publication doesn't include the tables the operator UI watches, AND
-- the frontend had no `refetchInterval` on lead-detail. Both sides of the
-- bug land in this PR (migration here, frontend hook in apps/web).
--
-- This migration adds the four hot tables to the realtime publication so
-- Supabase broadcasts row INSERT/UPDATE/DELETE events to subscribed
-- clients. The frontend's `useRealtimeInvalidate` hook will invalidate
-- React Query caches on each event, refreshing the page within ~1s of
-- the inbound WhatsApp landing in `messages`.
--
-- Why these four tables:
--   * messages         — the "new WhatsApp arrived" event. Critical.
--   * leads            — status/heat/ownership/score changes.
--   * work_queue       — sla-worker emits queue items; operator sees
--                        new "SLA risk" / "human handoff" rows live.
--   * conversation_claims — multi-operator collision avoidance.
--
-- Idempotent: if a table is already in the publication, the alter is a
-- no-op (Postgres errors on duplicate, so we wrap each statement).

do $$
begin
  begin
    alter publication supabase_realtime add table public.messages;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.leads;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.work_queue;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.conversation_claims;
  exception when duplicate_object then null;
  end;
end $$;
