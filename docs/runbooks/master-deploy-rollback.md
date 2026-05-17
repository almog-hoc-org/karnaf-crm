# Runbook — Roll back a bad master deploy

**Symptom:** A deploy to master made it to production (Vercel auto-deploys
master on merge), and something is now broken in prod. Need quick revert.

## Triage (≤ 2 min)

1. Vercel Dashboard → Deployments. Most recent at top.
2. Identify the last green deploy BEFORE the regression.

## Roll back

### Vercel frontend

1. Vercel Dashboard → Deployments.
2. Find last green deploy.
3. Click "Promote to Production." ~10s.
4. Verify: `curl https://karnaf-crm.vercel.app/api/healthz` → 200.

### Supabase Edge Functions

There's no Supabase-native rollback. Redeploy from the prior git tag:

```bash
git fetch --tags
git checkout v<previous-tag>
supabase functions deploy <name> --project-ref svkzkpgccahwmyflobvn
git checkout master
```

If you don't tag releases (you should — see below), use the last good
commit SHA:

```bash
git checkout <sha>
supabase functions deploy <name>
```

### Migrations

**Don't roll back migrations.** Once applied to prod they're load-bearing
state. Write a forward-compensating migration (e.g. `034_revert_field_x.sql`)
that undoes the bad change.

## Damage-control checklist

- [ ] Frontend reverted, smoke green
- [ ] Edge Functions reverted if needed
- [ ] No migration applied since the bad deploy? If yes, write compensator
- [ ] Telegram-announce: "rolled back deploy X — root cause pending"
- [ ] Open postmortem in `docs/postmortems/<date>-<incident>.md`

## Preventing the next one

- **Tag releases:** `release-YYYYMMDD-HHMM` per prod deploy.
- **Master branch protection** (per `production-hardening-user-actions.md` §2).
- **CI smoke** tests promoted to required status check.
