-- Store representative replies that were typed while WhatsApp's 24h
-- customer-care window was closed. These replies are sent automatically
-- when the customer reopens the window by messaging again.

CREATE TABLE IF NOT EXISTS public.pending_manual_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  text text NOT NULL CHECK (char_length(text) > 0 AND char_length(text) <= 2000),
  sender_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  sender_type text NOT NULL DEFAULT 'mia',
  sender_name text,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'reopen_sent', 'sent', 'failed', 'cancelled')),
  reopen_template_name text,
  reopen_provider_message_id text,
  send_provider_message_id text,
  last_error text,
  queued_at timestamptz NOT NULL DEFAULT now(),
  reopen_sent_at timestamptz,
  sent_at timestamptz,
  failed_at timestamptz,
  cancelled_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS pending_manual_replies_ready_idx
  ON public.pending_manual_replies (lead_id, conversation_id, queued_at)
  WHERE status IN ('queued', 'reopen_sent', 'failed');

CREATE INDEX IF NOT EXISTS pending_manual_replies_status_idx
  ON public.pending_manual_replies (status, queued_at);
