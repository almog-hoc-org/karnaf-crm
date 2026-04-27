# CRM OLD - Salvage Audit for Karnaf CRM Core

## Purpose
This document evaluates CRM OLD strictly as a donor system.
It identifies what should be reused, what should be rewritten, and what should be discarded when building the new primary system: **Karnaf CRM Core**.

The goal is to gain speed without inheriting architectural debt.

---

# 1. Executive summary

CRM OLD contains real, useful infrastructure.
It is not worthless.
However, it should **not** be treated as the main product baseline.

## Core conclusion
### Reuse selected infrastructure.
### Do not reuse the old AI/product logic as the backbone.

The old project appears to have:
- a functioning React/Vite frontend
- Supabase integration
- edge functions
- WhatsApp webhook plumbing
- Meta Cloud API support
- WATI fallback support
- basic work queue patterns
- lead creation/update patterns
- message persistence patterns

But it also contains major weaknesses:
- shallow AI reasoning model
- prompt logic mismatched to current business truth
- weak CRM orchestration depth
- simplistic stage/score logic
- incomplete ownership/handoff design
- outdated product assumptions

---

# 2. Assets worth salvaging

## 2.1 WhatsApp provider connection layer
Potentially reusable:
- `supabase/functions/_shared/whatsapp.ts`
- `supabase/functions/wati-webhook/index.ts`
- parts of `supabase/functions/whatsapp-webhook/index.ts`

Why salvage:
- real provider/API wiring already exists
- supports Meta Cloud API and WATI fallback
- reduces time to get messaging transport live

Caution:
- must be wrapped under the new runtime design
- should not drag in old business logic

## 2.2 Supabase integration patterns
Potentially reusable:
- Supabase client setup
- environment variable patterns
- edge function structure
- auth/data-fetch hooks pattern (frontend reference only)

Why salvage:
- accelerates implementation
- provides a working base for operational runtime

## 2.3 Basic message persistence concepts
Potentially reusable conceptually:
- conversations table usage
- messages table usage
- bot_sessions concept
- work_queue concept
- integration_logs concept

Why salvage:
- these are legitimate building blocks
- can be redesigned and normalized into the new schema

## 2.4 Frontend structural ideas
Potentially reusable only as reference:
- dashboard pages
- leads page structure
- queue concepts
- settings/integration surfaces
- work queue UI ideas

Why salvage:
- may help the developer move faster
- can inspire layout and interaction patterns

Caution:
- should not freeze the new information architecture
- should not force visual or data-model compromise

---

# 3. Assets that should be rewritten

## 3.1 Bot handler / conversation brain
Current file reviewed:
- `supabase/functions/bot-handler/index.ts`

Reason to rewrite:
- current logic is too shallow
- built around a lightweight direct-response model
- prompt is old, tone-specific, and mismatched to the clarified operating model
- structured output is too limited for a serious CRM runtime
- scoring/staging is too simplistic
- product logic still assumes multiple older motions and weak differentiation

Decision:
## Rewrite completely

Possible salvage:
- only the skeleton flow concept: receive inbound, load context, call model, persist response, maybe enqueue transfer

## 3.2 Lead scoring logic
Current logic appears to rely on:
- score delta from model
- simplistic thresholding
- message count heuristics

Reason to rewrite:
- too fragile
- too opaque
- not aligned with current source/fit/readiness framework

Decision:
## Rewrite completely

## 3.3 Stage / state model
Current stage usage appears closer to:
- new
- qualifying
- warm
- hot
- transferred
- closed

Reason to rewrite:
- not rich enough
- does not match clarified CRM state machine
- does not encode ownership, payment, nurture, DNC, dormant, etc.

Decision:
## Rewrite completely

## 3.4 Handoff model
Current transfer behavior seems to be:
- `should_transfer` from the model
- insert pending work queue item
- optional WhatsApp alert

Reason to rewrite:
- lacks clean ownership transfer protocol
- lacks handoff package discipline
- lacks return-to-AI flow
- lacks Mia-centered queue semantics

Decision:
## Rewrite completely

---

# 4. Assets that should not be reused as-is

## 4.1 Default system prompt
The old default prompt should not be reused.

Why:
- wrong persona framing
- too sales-script heavy
- too narrow
- includes risky style assumptions
- not aligned with current business truth or brand discipline

Decision:
## Discard as-is

## 4.2 Old product framing
Old product assumptions include:
- investor guidance emphasis
- webinar-first assumptions
- mixed product motions
- rough social proof style

Reason:
- current north star is one core product: הדרך לדירה
- other inquiries should be side-classified, not primary selling motions

Decision:
## Discard as core logic

## 4.3 Old alert semantics
Example old behavior:
- hot lead alert sent directly to business phone
- transfer alerts via WhatsApp

Reason:
- useful as a fallback pattern, but insufficient as the main operational protocol
- new system should center Mia dashboard + queue + structured notifications

Decision:
## Do not reuse as primary alert architecture

---

# 5. WhatsApp architecture findings from CRM OLD

## Good news
CRM OLD confirms that the WhatsApp side is not purely theoretical.
There is already evidence of:
- webhook handling
- Meta webhook verification
- provider abstraction
- outbound sending helper
- inbound forwarding into bot logic

## Key insight
The transport layer is usable.
The intelligence layer is weak.

This is strategically excellent because it means:
## We likely do not need to rebuild the messaging transport from absolute zero.

We mostly need to:
- refactor the runtime architecture
- replace the orchestration brain
- restructure the CRM state logic
- improve ownership and queue behavior

---

# 6. Recommended salvage map

## Safe to reuse with adaptation
- provider adapter patterns
- message send helper
- webhook verification logic
- normalized phone utilities
- generic lead creation/upsert patterns
- conversation/message persistence concepts
- integration log concepts

## Reuse only as reference
- dashboard/page structure
- hooks naming ideas
- work queue UI ideas
- settings/integration screens

## Rewrite from scratch
- bot handler
- prompt/policy layer
- lead scoring
- lead state machine
- handoff protocol
- ownership model
- follow-up engine
- AI output contract
- analytics semantics
- payment-state logic

## Discard
- old persona prompt
- old sales assumptions
- old simplistic transfer logic as the main design
- old shallow qualification logic

---

# 7. Migration risk warnings

## 7.1 Biggest risk
Accidentally rebuilding the old logic inside a prettier shell.

That would produce:
- the same weak behavior
- more complexity
- more confusion
- harder future iteration

## 7.2 Second risk
Reusing schema blindly and ending up with old table semantics that fight the new model.

## 7.3 Third risk
Keeping too many dual systems alive in parallel.

---

# 8. Recommended implementation stance

Treat CRM OLD as:
- a quarry
- a toolbox
- a transport reference

Not as:
- the app to continue
- the logic to trust
- the architecture to preserve

---

# 9. Immediate action recommendations

## Recommended next moves
1. extract and document the reusable WhatsApp/provider layer
2. define the new Supabase schema cleanly from the new spec, not from old tables alone
3. write the new orchestration contract before coding the new bot runtime
4. build the new runtime behind a fresh repo and fresh structure
5. import only selected old code after the new architecture is already defined

---

# 10. Final verdict

CRM OLD is useful.
CRM OLD is not the future system.

## Best path:
- salvage transport and infrastructure patterns
- discard old brain and old product logic
- build Karnaf CRM Core cleanly as the new primary system
