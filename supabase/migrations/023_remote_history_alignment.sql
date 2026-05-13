-- 023_remote_history_alignment.sql
--
-- This migration intentionally performs no schema changes.
--
-- Background:
-- - remote migration history contained versions 023-026 that were not present in git
-- - the underlying schema is already present on the remote project
-- - the missing source migrations could not be reconstructed automatically here
--
-- Purpose:
-- - re-establish a consistent local/remote migration chain after history repair
-- - allow future `supabase db push` runs to proceed without version-gap errors

select '023_remote_history_alignment' as migration_marker;
