-- Karnaf CRM Core - Ownership consistency check.
--
-- Audit flagged: leads.ownership_mode can diverge from
-- conversations.ownership_mode. When the orchestrator updates one row
-- without the other (rare but possible during migration or via a buggy
-- function), inbound messages route to the wrong owner.
--
-- This trigger fires on conversation row updates and logs to
-- integration_logs whenever the conversation's ownership doesn't match
-- the lead's. We don't auto-correct because the truth depends on
-- which side moved first; surface for /admin/health to triage.

create or replace function check_ownership_consistency()
returns trigger
language plpgsql
as $$
declare
  v_lead_owner text;
begin
  if new.ownership_mode is null or new.lead_id is null then
    return new;
  end if;
  select ownership_mode into v_lead_owner from leads where id = new.lead_id;
  if v_lead_owner is null then return new; end if;
  if v_lead_owner <> new.ownership_mode then
    insert into integration_logs (source, status, lead_id, request_data, response_data, error_message)
    values (
      'ownership_consistency_check',
      'warning',
      new.lead_id,
      jsonb_build_object('conversation_id', new.id,
                         'conversation_ownership', new.ownership_mode,
                         'lead_ownership', v_lead_owner),
      null,
      'lead.ownership_mode <> conversation.ownership_mode'
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_check_ownership_consistency on conversations;
create trigger trg_check_ownership_consistency
  after update of ownership_mode on conversations
  for each row execute function check_ownership_consistency();
