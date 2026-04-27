# Karnaf CRM Core - Build Roadmap from V1 to Production

## Purpose
This roadmap translates the Karnaf CRM vision into a practical execution sequence.
It is designed to help the developer build in the correct order, avoid architectural drift, and reach a stable production-ready CRM without wasting cycles on decorative work too early.

---

# 1. Strategic build order

The correct order is:
1. foundation
2. runtime
3. operator control
4. payment lifecycle completion
5. analytics
6. hardening

Do not reverse this order.

---

# 2. Milestone 0 - Setup and control

## Objective
Create a clean project base and governance structure.

## Deliverables
- canonical repo structure established
- docs folder populated
- environment plan defined
- developer alignment on architecture
- old-project salvage boundaries frozen
- naming conventions frozen

## Exit criteria
- one agreed repo
- one agreed architecture direction
- no ambiguity about primary system ownership

---

# 3. Milestone 1 - Data and schema foundation

## Objective
Build the core truth model in Supabase.

## Deliverables
- leads table
- conversations table
- messages table
- events table
- work_queue table
- tasks/actions table
- payment state fields/entities
- config tables if needed
- role/auth model

## Exit criteria
- schema supports the full V1 CRM lifecycle
- all critical entities exist
- migrations are versioned and reproducible

---

# 4. Milestone 2 - Intake and WhatsApp runtime skeleton

## Objective
Get lead entry and message plumbing working reliably.

## Deliverables
- form/webhook lead intake endpoint(s)
- WhatsApp inbound webhook
- WhatsApp outbound send helper
- transcript persistence
- provider status handling
- duplicate protection
- normalized phone handling
- initial conversation ownership states

## Exit criteria
- a new inbound message creates or resolves a lead
- conversation is logged correctly
- outbound messages can be sent reliably
- provider errors are visible

---

# 5. Milestone 3 - AI orchestration core

## Objective
Replace shallow bot behavior with a real CRM-aware AI engine.

## Deliverables
- context builder
- structured output contract
- orchestration engine
- policy validation layer
- first-response logic
- qualification logic
- follow-up scheduling logic
- Mia escalation recommendation logic
- DNC/remove logic

## Exit criteria
- inbound messages trigger policy-aware AI decisions
- AI outputs mutate CRM state safely
- system can distinguish between reply, escalate, suppress, and follow-up

---

# 6. Milestone 4 - Mia operator console

## Objective
Give Mia a real place to operate the system from.

## Deliverables
- dashboard
- leads workspace
- lead detail page
- queue center
- transcript viewer
- action buttons
- ownership transfer controls
- basic system health block

## Exit criteria
- Mia can work end-to-end from one place
- no need to juggle side systems for normal operation

---

# 7. Milestone 5 - SLA, queues, and operational discipline

## Objective
Make the system operationally trustworthy.

## Deliverables
- SLA timers
- hot lead queue
- handoff queue
- payment pending queue
- phone escalation queue
- dormant review queue
- alerts for approaching 12h threshold
- weekend carryover logic

## Exit criteria
- no lead can silently disappear
- Mia can see risk before failure

---

# 8. Milestone 6 - Payment and purchase completion

## Objective
Close the loop from interest to purchase.

## Deliverables
- payment webhook or payment signal ingestion
- checkout state tracking
- purchase confirmation flow
- won-state transitions
- onboarding task generation
- post-purchase handoff rules

## Exit criteria
- a paid lead becomes a won lead automatically or near-automatically
- onboarding begins without manual chaos

---

# 9. Milestone 7 - Analytics and improvement layer

## Objective
Turn the system into a learning engine.

## Deliverables
- source performance reporting
- response/qualification/close metrics
- objection frequency metrics
- SLA performance metrics
- AI vs Mia intervention analysis
- drop-off and stuck-state analysis

## Exit criteria
- the business can see what is working
- playbook improvements can be evidence-driven

---

# 10. Milestone 8 - Production hardening

## Objective
Make the system dependable enough for live business operation.

## Deliverables
- error handling and retries
- alerting for failures
- audit logging everywhere important
- webhook health visibility
- secret handling finalized
- deployment workflow stabilized
- rollback and recovery notes

## Exit criteria
- production incidents are diagnosable
- critical failures are visible
- deployment is repeatable

---

# 11. Recommended first live slice

If we want the earliest meaningful version, the first live slice should be:
- one or two lead sources
- WhatsApp inbound/outbound
- lead creation
- transcript logging
- AI first response
- Mia handoff
- dashboard + lead detail
- SLA warnings

Not everything at once.

---

# 12. What not to do

Do not:
- overbuild analytics before runtime works
- over-polish UI before queues and ownership work
- migrate old logic blindly
- connect every source on day one
- build too many side admin tools before the critical flow works

---

# 13. Success criteria for V1

V1 is successful if:
- leads enter reliably
- WhatsApp replies work reliably
- conversations are logged
- AI behaves better than the old system
- Mia can intervene clearly
- no lead falls through silently
- payment completion can be recognized
- system can be operated from one main console

---

# 14. Final build recommendation

Build Karnaf CRM Core in milestone order, with discipline.
Do not let CRM OLD dictate the shape of the new system.
Use it only to accelerate the wiring where that is safe.

The first priority is a working operational machine.
The second priority is a strong operator console.
The third priority is optimization and polish.
