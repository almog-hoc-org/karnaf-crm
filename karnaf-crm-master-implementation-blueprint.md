# Karnaf CRM Core - Master Implementation Blueprint

## Purpose
This document defines how Karnaf CRM should actually be built as the single primary operating system for the sales flow around **"הדרך לדירה"**.

This is not a redesign of CRM OLD.
This is a new primary system.
CRM OLD is treated only as a donor for useful infrastructure, credentials, patterns, and selective code reuse.

The goal is to avoid confusion, duplication, and parallel-system chaos.

---

# 1. Governing principle

## One primary system only
From this point forward, the intended production system is:
## Karnaf CRM Core

It should become the only real system of record for:
- leads
- conversations
- CRM state
- work queues
- AI operations
- Mia oversight
- payment status
- automations
- analytics

CRM OLD should not continue as a parallel active product.
It can be used only as:
- a code donor
- an integration reference
- a schema reference
- a WhatsApp/provider reference
- a migration source if needed

---

# 2. High-level architecture decision

## Build new, harvest old
The correct strategy is:
- do **not** rehabilitate CRM OLD as the main application
- do selectively extract useful components from it
- do build Karnaf CRM Core as a fresh, clean, structured system

Why:
- CRM OLD has working plumbing but weak product logic
- its AI brain is too shallow for the target operating model
- its product assumptions do not match the clarified business model
- patching old sales logic into the new vision will create long-term mess

---

# 3. Ownership model

## 3.1 System owner model
Karnaf CRM Core should be managed under a clear operating hierarchy.

### Strategic/business owner
Mogi
- final authority on business truth
- final authority on approvals and access
- final authority on offer, pricing, and allowed actions

### System architecture and operating owner
Kobi
- architecture
- logic design
- CRM behavior model
- state machine
- AI orchestration
- queue behavior
- escalation logic
- operating rules
- roadmap definition
- integration design
- QA logic
- deployment planning

### Build executor
Developer
- frontend implementation
- backend implementation
- Supabase implementation
- Vercel deployment setup
- provider integration wiring
- schema/function coding
- UI/UX polish

### Human oversight operator
Mia
- day-to-day intervention
- queue execution
- human handling
- system monitoring and override

---

# 4. Production truth sources

## 4.1 Single source of truth rules
- Leads = Supabase
- Conversations/transcripts = Supabase
- Work queues = Supabase
- State transitions = Supabase event-driven logic
- Dashboard data = Supabase-backed API/application queries
- Configuration = repo + approved config tables
- WhatsApp delivery state = provider callbacks stored in Supabase
- Payment state = payment webhook/API into Supabase
- Deployment = Vercel
- Auth/roles = Supabase auth or equivalent controlled auth layer

## 4.2 No scattered truth
The following should not be used as primary truth stores:
- random spreadsheets as operational truth
- old CRM UI state
- WhatsApp alone as the source of record
- manual notes outside the system

Google Sheets may be used temporarily or for imports/exports, but not as the authoritative operational store once Karnaf CRM Core is live.

---

# 5. Recommended repository structure

## Primary repo
Recommended canonical repo name:
## karnaf-crm-core

## Suggested structure
- `/docs`
  - product specs
  - ops specs
  - architecture
  - roadmaps
  - migration notes
- `/apps/web`
  - frontend application
- `/supabase`
  - migrations
  - edge functions
  - seed/config scripts
- `/lib`
  - shared utilities
  - shared types
  - orchestration helpers
- `/integrations`
  - provider adapters
  - payment connectors
  - webhook contracts
- `/playbooks`
  - conversation playbooks
  - objection playbooks
  - escalation playbooks
- `/ops`
  - deployment docs
  - env maps
  - secret maps (no actual secrets)
  - runbooks

---

# 6. Build phases

## Phase 0 - Preparation
Goals:
- establish clean repo
- establish core docs
- define target architecture
- define salvage boundaries from CRM OLD
- define environments and ownership

Deliverables:
- master implementation blueprint
- salvage audit
- build roadmap
- environment/secrets map

## Phase 1 - Core foundation
Goals:
- create schema
- create auth/role model
- create event model
- create lead state machine
- create queue model
- create WhatsApp runtime skeleton
- create dashboard data contract

Deliverables:
- Supabase schema migrations
- lead/event/message/task tables
- initial API/function contracts
- role model

## Phase 2 - Operational runtime
Goals:
- working intake from forms/webhooks
- WhatsApp inbound/outbound runtime
- lead creation/update flow
- transcript logging
- AI decision engine with structured outputs
- Mia handoff logic
- SLA/alerting behavior

Deliverables:
- working WhatsApp pipeline
- orchestration engine
- lead state mutation layer
- follow-up scheduler

## Phase 3 - Operator console
Goals:
- functional Mia dashboard
- lead detail view
- queue center
- activity timeline
- automation health view
- settings/config surfaces where appropriate

Deliverables:
- production-usable web UI
- manual override tools
- filters/search/views

## Phase 4 - Payments and lifecycle completion
Goals:
- payment webhook/API integration
- purchase confirmation flow
- won state handling
- onboarding task creation
- post-sale transitions

Deliverables:
- checkout/payment flow integration
- onboarding state logic

## Phase 5 - Analytics and optimization
Goals:
- source conversion visibility
- objection analytics
- SLA analytics
- AI vs Mia outcome comparison
- drop-off analysis

Deliverables:
- analytics views
- QA loops
- optimization dashboards

## Phase 6 - Production hardening
Goals:
- retries
- observability
- alerting
- recovery behavior
- secret handling
- backup and rollback logic

Deliverables:
- production runbook
- incident playbooks
- retry/error policies

---

# 7. V1 scope definition

## V1 must be real, not decorative
The first live version should include only the critical path, but it must be production-real.

## V1 required capabilities
- lead intake from forms/webhooks
- WhatsApp inbound/outbound
- lead creation/update
- transcript logging
- lead detail storage
- AI first response
- qualification behavior
- Mia handoff
- work queue management
- SLA alerts
- do-not-contact flow
- payment confirmation intake
- operator dashboard

## V1 excluded or not required immediately
- polished advanced analytics
- multi-product selling
- complex partnership pipeline
- extensive outbound campaign tooling
- advanced BI/report builder

---

# 8. CRM OLD salvage strategy

## 8.1 What CRM OLD is good for
CRM OLD appears useful as a source of:
- WhatsApp provider connection patterns
- webhook handling patterns
- Supabase table ideas
- queue concepts
- existing send-message helpers
- auth/frontend scaffolding ideas
- sample dashboard concepts

## 8.2 What CRM OLD should not define
CRM OLD should not define:
- new product logic
- new lead scoring logic
- new AI behavior
- new conversation policy
- new sales state machine
- new ownership/handoff model
- new product framing

## 8.3 Safe salvage rule
Only reuse a component from CRM OLD if:
- it reduces engineering time
- it does not force old business assumptions
- it fits the new architecture cleanly
- it does not increase long-term complexity

---

# 9. Environment model

## Required environments
- local/dev
- staging
- production

## Environment rules
- no direct experimentation on production
- staging should be capable of provider/webhook simulation where possible
- production secrets must not live in repo

## Main managed systems
- Supabase project
- Vercel project
- WhatsApp provider account / Meta app
- payment integration credentials

---

# 10. Permissions and auth model

## Roles expected
- owner
- admin/operator
- Mia/operator
- sales_rep
- readonly/auditor (optional future)

## Core permissions
### Owner/admin
- full access
- settings
- integrations
- overrides
- queue force actions

### Mia/operator
- see leads
- reply to leads
- own conversations
- resolve handoffs
- change states within allowed set
- view alerts and queues

### sales_rep
- access phone-escalation leads
- update call outcomes
- limited view of necessary data

---

# 11. WhatsApp runtime authority model

The WhatsApp channel should be controlled through Karnaf CRM Core, not around it.

## Principle
The system should always know:
- who owns the conversation
- what the current state is
- whether AI may respond
- whether Mia must respond
- whether the thread is suppressed

## Ownership states
- ai_active
- mia_active
- phone_sales_pending
- shared_watch
- suppressed

---

# 12. Lead lifecycle authority model

Every lead must have:
- one current state
- one current owner or ownership mode
- one next action
- one next action due time
- one audit trail

No invisible transitions.
No silent logic.
No side-channel ownership.

---

# 13. Deployment strategy

## Primary deployment target
- Frontend app: Vercel
- Backend/runtime/API: Supabase edge functions and supporting services as needed
- Database/auth/storage: Supabase

## Deployment rule
There must be one production-grade live stack, not multiple partially live copies.

## Secrets rule
All secrets should live only in:
- Supabase secrets
- Vercel environment variables
- secure local dev env

Never in repo.
Never in docs.
Never in static client code.

---

# 14. Migration philosophy

## Do not migrate old mess blindly
Migration should be selective.
Only move over:
- useful schema concepts
- useful provider details
- necessary existing integration credentials
- possibly existing leads if worth importing

## Avoid inheriting old assumptions
Do not import:
- old stages blindly
- old prompts
- old score logic
- old queue semantics
- old product classification assumptions

---

# 15. Operational control philosophy

Karnaf CRM Core should feel like:
- one operational console
- one source of truth
- one owner architecture
- one runtime brain
- one WhatsApp control layer

Mia should not need to jump between:
- WhatsApp
- random dashboards
- old tools
- sheets
- side logs

The system should centralize operation.

---

# 16. Delivery strategy for the developer

The developer should receive a structured execution pack, not only a product vision.

## Required build docs
- full spec
- master implementation blueprint
- salvage audit
- roadmap
- schema spec
- WhatsApp runtime spec
- deployment and secrets map

This reduces ambiguity and speeds clean implementation.

---

# 17. Immediate next implementation documents

The next required documents are:
1. **CRM OLD salvage audit**
2. **Build roadmap v1 to production**
3. **Supabase schema implementation spec**
4. **Environment + secrets + deployment map**
5. **WhatsApp provider migration/connection plan**

---

# 18. Final recommendation

The smart move is:
## Build Karnaf CRM Core as the only real future system.

Use CRM OLD only to harvest:
- credentials patterns
- webhook/provider know-how
- optional UI/code fragments
- optional importable historical assets

Do not let CRM OLD remain the architectural center.

Karnaf CRM Core should become the new center of gravity.
