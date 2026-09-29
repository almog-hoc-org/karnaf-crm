#!/usr/bin/env bash
# Applies every migration, in order, to a throwaway Postgres with stand-ins
# for the Supabase platform (roles, auth/storage/vault schemas, pg_cron and
# pg_net stubs that never schedule or send anything), then runs
# supabase/tests/db-smoke/smoke.sql against the result.
#
# CI has no database, so a trigger that raises on every insert passed CI and
# `db push` alike and took down lead intake in production (migration 128).
#
# Needs: a running Postgres reachable with the usual PG* variables as a
# superuser, and write access to its extension directory (for the stubs).
set -euo pipefail

here="supabase/tests/db-smoke"
ext_dir="${PG_EXTENSION_DIR:-$(pg_config --sharedir)/extension}"
psql_cmd=(psql -X -q -v ON_ERROR_STOP=1)

sudo_if_needed() { if [ -w "$ext_dir" ]; then "$@"; else sudo "$@"; fi; }
sudo_if_needed cp "$here"/pg_cron.control "$here"/pg_cron--1.0.sql "$here"/pg_net.control "$here"/pg_net--1.0.sql "$ext_dir/"

"${psql_cmd[@]}" -f "$here/bootstrap.sql"

failed=0
for f in $(ls supabase/migrations/*.sql | sort -V); do
  if ! out=$("${psql_cmd[@]}" -1 -f "$f" 2>&1); then
    echo "::error file=$f::$(echo "$out" | grep -m1 ERROR)"
    failed=1
  fi
done
[ "$failed" = 0 ] || { echo "Some migrations failed to apply"; exit 1; }
echo "All $(ls supabase/migrations/*.sql | wc -l) migrations applied"

"${psql_cmd[@]}" -f "$here/smoke.sql"
