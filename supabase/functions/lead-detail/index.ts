import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getServiceSupabase } from '../_shared/supabase.ts';
import { AuthError, requireStaff } from '../_shared/auth.ts';

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'GET') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  try { await requireStaff(req); } catch (err) {
    if (err instanceof AuthError) return jsonResponse(req, { error: err.message }, err.status);
    throw err;
  }

  const url = new URL(req.url);
  const leadId = url.searchParams.get('leadId');
  if (!leadId) return jsonResponse(req, { error: 'Missing leadId' }, 400);

  const supabase = getServiceSupabase();

  const [leadRes, conversationsRes, messagesRes, queueRes, tasksRes, eventsRes] = await Promise.all([
    supabase.from('leads').select('*').eq('id', leadId).single(),
    supabase.from('conversations').select('*').eq('lead_id', leadId),
    supabase.from('messages').select('*').eq('lead_id', leadId).order('created_at', { ascending: true }).limit(200),
    supabase.from('work_queue').select('*').eq('lead_id', leadId).order('created_at', { ascending: false }).limit(50),
    supabase.from('lead_tasks').select('*').eq('lead_id', leadId).order('created_at', { ascending: false }).limit(50),
    supabase.from('lead_events').select('*').eq('lead_id', leadId).order('created_at', { ascending: false }).limit(100),
  ]);

  if (leadRes.error) return jsonResponse(req, { error: leadRes.error.message }, 404);

  // Surface secondary query failures rather than returning silently empty
  // arrays — those would look like "no messages" / "no events" to the
  // operator and hide a real DB problem.
  const secondary = [
    { label: 'conversations', err: conversationsRes.error },
    { label: 'messages', err: messagesRes.error },
    { label: 'queueItems', err: queueRes.error },
    { label: 'tasks', err: tasksRes.error },
    { label: 'events', err: eventsRes.error },
  ].find((r) => r.err);
  if (secondary) {
    return jsonResponse(req, { error: `${secondary.label}: ${secondary.err!.message}` }, 500);
  }

  // Resolve the human owner profile (if any) so the operator UI can show
  // "מטפל: דנה כהן" rather than a UUID. Skips silently if no human is
  // assigned — that's the AI's lead.
  let humanOwnerProfile: { id: string; full_name: string | null; email: string | null; role: string | null } | null = null;
  const humanOwnerId = (leadRes.data as { human_owner_id?: string | null }).human_owner_id;
  if (humanOwnerId) {
    const { data } = await supabase
      .from('profiles')
      .select('id, full_name, email, role')
      .eq('id', humanOwnerId)
      .maybeSingle();
    humanOwnerProfile = data ?? null;
  }

  return jsonResponse(req, {
    ok: true,
    lead: leadRes.data,
    conversations: conversationsRes.data ?? [],
    messages: messagesRes.data ?? [],
    queueItems: queueRes.data ?? [],
    tasks: tasksRes.data ?? [],
    events: eventsRes.data ?? [],
    humanOwnerProfile,
  });
});
