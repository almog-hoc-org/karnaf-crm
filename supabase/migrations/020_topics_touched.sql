-- Karnaf CRM Core - Topics touched memory.
--
-- The runtime detects which conversational topics the bot has already
-- covered with a lead (price, timeline, format, etc.) and stores a
-- rolling tally on leads.topics_touched. The AI prompt receives a
-- compact view of this so the bot can avoid re-explaining the same
-- topic three times in a row.
--
-- Stored shape (newest entries last, capped server-side):
--   [
--     { "topic": "price",     "count": 3, "last_at": "2026-05-13T10:30:00Z" },
--     { "topic": "timeline",  "count": 1, "last_at": "2026-05-13T11:05:00Z" }
--   ]
--
-- We intentionally keep this denormalised on the lead row to avoid an
-- extra round-trip on every AI turn. The orchestrator merges new hits
-- in code on each reply.

alter table leads
  add column if not exists topics_touched jsonb not null default '[]'::jsonb;
