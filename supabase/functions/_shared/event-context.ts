// Canonical event context builders. Tier 7.B.1.
//
// Until this file, every emitter (leads-intake, admin-actions/mark_won,
// admin-actions/mark_lost, sla-worker, automation-tick, projects publish)
// built its own context object with a *slightly* different field set.
// Audit found 5 active emitters with 4 distinct lead.* shapes — meaning
// a rule listening on `lead.dormant` couldn't condition on the same
// fields as a rule listening on `lead.created`, and silent-skips were
// possible whenever a rule was moved between triggers.
//
// This file is the single source of truth for what's in the `lead`
// block of every engine trigger event's context. Every emitter calls
// `buildLeadContext` with the lead id and adds per-event blocks
// (deal, project, lost_reason, …) on top.
//
// ## Canonical lead.* shape
//
//   id, full_name, first_name, phone, email, city
//   product_interest, intake_segment, primary_track
//   lead_status, ownership_mode, lead_heat
//   do_not_contact, removed_by_request
//   source
//   created_at, last_inbound_at, last_outbound_at
//   hours_since_intake, hours_since_last_inbound, hours_since_last_outbound
//   has_won_program            (boolean — needs deal lookup)
//   is_program_member          (boolean — needs program_members lookup)
//   days_since_program_join, program_progress_stage  (needs program_members lookup)
//
// Heavier fields (program_members, has_won_program) are gated behind
// `opts.includeDerived = true` because not every event needs them and
// the extra two queries × N-leads in automation-tick adds up.
//
// ## Usage
//
//   const lead = await buildLeadContext(supabase, leadId);
//   await runMatchingRules(supabase, {
//     triggerEvent: 'deal.won',
//     context: { lead, deal: {...} },
//     contactId: leadId,
//   });
//
// For the per-tick path (where we already SELECTed the row inline), use
// `buildLeadContextFromRow` to avoid a duplicate query.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

// The narrow subset of columns that buildLeadContextFromRow accepts.
// More fields can be added without breaking call sites because the
// builder copies what's present and synthesises the rest as null.
export interface LeadRowForContext {
  id: string;
  full_name?: string | null;
  phone?: string | null;
  email?: string | null;
  city?: string | null;
  product_interest?: string | null;
  intake_segment?: string | null;
  primary_track?: string | null;
  lead_status?: string | null;
  ownership_mode?: string | null;
  lead_heat?: string | null;
  do_not_contact?: boolean | null;
  removed_by_request?: boolean | null;
  source?: string | null;
  source_campaign?: string | null;
  created_at?: string | null;
  last_inbound_at?: string | null;
  last_outbound_at?: string | null;
}

export interface LeadContextOptions {
  // When true, runs the two extra lookups (has_won_program from deals,
  // is_program_member + days_since_program_join + program_progress_stage
  // from program_members). The automation-tick lead scan path uses this.
  // One-off emitters (mark_won, mark_lost, dormant, lead.created) leave
  // it false because the rules listening on those events rarely need
  // course-related context.
  includeDerived?: boolean;
}

export interface LeadContext {
  id: string;
  full_name: string | null;
  first_name: string;
  phone: string | null;
  email: string | null;
  city: string | null;
  product_interest: string | null;
  intake_segment: string | null;
  primary_track: string | null;
  lead_status: string | null;
  ownership_mode: string | null;
  lead_heat: string | null;
  do_not_contact: boolean;
  removed_by_request: boolean;
  source: string | null;
  // Segmentation key for campaign broadcasts. Set at intake from the
  // form's campaign field (e.g. 'launch_webinar_2026'); durable so a
  // rule listening on lead.created can gate a confirmation send on it.
  source_campaign: string | null;
  hours_since_intake: number | null;
  hours_since_last_inbound: number | null;
  hours_since_last_outbound: number | null;
  // Derived (null when includeDerived=false).
  has_won_program: boolean | null;
  is_program_member: boolean | null;
  days_since_program_join: number | null;
  program_progress_stage: string | null;
}

const LEAD_SELECT_COLUMNS =
  'id, full_name, phone, email, city, product_interest, intake_segment, ' +
  'primary_track, lead_status, ownership_mode, lead_heat, do_not_contact, ' +
  'removed_by_request, source, source_campaign, created_at, last_inbound_at, last_outbound_at';

// Resolve the lead from id then delegate. The common case for one-off
// emitters (mark_won, mark_lost, dormant).
export async function buildLeadContext(
  supabase: SupabaseClient,
  leadId: string,
  opts: LeadContextOptions = {},
): Promise<LeadContext | null> {
  const { data, error } = await supabase
    .from('leads')
    .select(LEAD_SELECT_COLUMNS)
    .eq('id', leadId)
    .maybeSingle();
  if (error || !data) return null;
  // The select string is built by concatenation, so supabase-js can't infer
  // a row type and widens `data` to GenericStringError — cast through unknown.
  return buildLeadContextFromRow(supabase, data as unknown as LeadRowForContext, opts);
}

// The path automation-tick uses: it already has the row in memory from
// the bulk scan, no need for a per-lead round-trip.
export async function buildLeadContextFromRow(
  supabase: SupabaseClient,
  row: LeadRowForContext,
  opts: LeadContextOptions = {},
): Promise<LeadContext> {
  const firstName = row.full_name?.split(/\s+/u)[0] ?? '';
  const now = Date.now();
  const round1 = (n: number) => Math.round(n * 10) / 10;
  const hoursSince = (iso?: string | null): number | null =>
    iso ? round1((now - new Date(iso).getTime()) / 3600000) : null;

  const base: LeadContext = {
    id: row.id,
    full_name: row.full_name ?? null,
    first_name: firstName,
    phone: row.phone ?? null,
    email: row.email ?? null,
    city: row.city ?? null,
    product_interest: row.product_interest ?? null,
    intake_segment: row.intake_segment ?? null,
    primary_track: row.primary_track ?? null,
    lead_status: row.lead_status ?? null,
    ownership_mode: row.ownership_mode ?? null,
    lead_heat: row.lead_heat ?? null,
    do_not_contact: !!row.do_not_contact,
    removed_by_request: !!row.removed_by_request,
    source: row.source ?? null,
    source_campaign: row.source_campaign ?? null,
    hours_since_intake: hoursSince(row.created_at),
    hours_since_last_inbound: hoursSince(row.last_inbound_at),
    hours_since_last_outbound: hoursSince(row.last_outbound_at),
    has_won_program: null,
    is_program_member: null,
    days_since_program_join: null,
    program_progress_stage: null,
  };

  if (!opts.includeDerived) return base;

  // Cheap two queries — the same ones automation-tick was doing inline.
  // Centralised here so any future emitter that needs the derived fields
  // gets the same shape.
  const { data: wonProgram } = await supabase
    .from('deals')
    .select('id', { head: false })
    .eq('lead_id', row.id)
    .eq('track', 'program')
    .eq('status', 'won')
    .limit(1)
    .maybeSingle();
  base.has_won_program = !!wonProgram;

  const { data: memberRow } = await supabase
    .from('program_members')
    .select('joined_at, progress_stage')
    .eq('lead_id', row.id)
    .maybeSingle();
  base.is_program_member = !!memberRow;
  base.days_since_program_join = memberRow?.joined_at
    ? Math.round((now - new Date(memberRow.joined_at).getTime()) / 86400000)
    : null;
  base.program_progress_stage = memberRow?.progress_stage ?? null;

  return base;
}
