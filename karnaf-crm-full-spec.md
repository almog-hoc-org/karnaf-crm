# Karnaf CRM - Full Product, Operations, Data, Automation, and Build Specification

## Document purpose
This document is the build-ready specification for **Karnaf CRM**.
It is intended to serve as the single source of truth for the product designer, frontend developer, backend developer, automation builder, and AI orchestration logic.

The system is designed first and foremost to support the sale of one core product:
## "הדרך לדירה"

At the same time, the architecture must remain extensible so that future lead types such as collaboration requests, consulting inquiries, or other offers can be classified and handled without confusing the current sales flow.

This document is intentionally exhaustive. It covers:
- product scope
- business goals
- operating model
- roles and permissions
- lead lifecycle
- CRM schema
- dashboard structure
- queues and workflows
- AI behavior
- Mia workflow
- escalation rules
- WhatsApp interaction logic
- automation rules
- webhook ingestion
- API contracts
- event model
- SLA and alerting
- analytics
- reporting
- edge cases
- future extensibility

---

# 1. Core business objective

## 1.1 Primary business objective
Karnaf CRM exists to maximize conversion into the digital program:
## "הדרך לדירה"

This is the north star.
The system is not a generic CRM, not a content organizer, and not just a lead tracker.
It is an operational sales system designed to:
- capture leads from multiple sources
- respond quickly
- qualify intelligently
- follow up consistently
- escalate to humans only when useful
- reduce lead leakage
- maximize purchases through the checkout flow
- preserve order, trust, and quality

## 1.2 Secondary objective
The system should also be able to identify and classify non-core inquiries such as:
- collaboration requests
- consulting requests
- investor guidance requests
- partnership inquiries
- irrelevant/support noise

However, these must not pollute the primary product-selling motion.
They should be clearly separated and labeled.

## 1.3 Non-goals
At the initial stage, the system is **not** optimized for:
- selling multiple unrelated products
- heavy outbound sales prospecting
- phone-first closing as the default
- enterprise account management
- long consulting pipelines as the main sales path

---

# 2. Product definition

## 2.1 Core product
### הדרך לדירה
A digital program that includes:
- recorded training content
- practical tools
- structured guidance
- AI or human Q&A support within the program
- confidence-building and decision-support for buying a home or beginning a first real estate path

## 2.2 Commercial model
- likely price range: 4,000-5,000 ILS
- lowest likely floor: 3,500 ILS
- installment payments: yes
- launch/webinar discounts: 20%-35%
- final purchase mechanism: checkout page in **Skooler / Responder (רב מסר)** ecosystem

## 2.3 Commercial truth to preserve
The system should sell the program without promising:
- returns
- guaranteed savings
- guaranteed price outcome
- guaranteed success in buying a home

The system should instead emphasize:
- confidence in process
- structure
- data-based thinking
- professionalism
- practical tools
- reduction of expensive mistakes
- better decision quality

---

# 3. Target customer model

## 3.1 Ideal buyer profile
The ideal buyer is a person who:
- already understands the importance of buying a home in Israel
- wants to do it correctly, not intuitively
- is looking for a first residence or first investment move
- values high-quality information and tools
- respects expertise
- is open, practical, and serious
- often is a young couple, single man, or single woman
- has some equity or real intent to move toward purchase
- has already considered buying a home before

## 3.2 Less suitable profile
A lower-fit lead is someone who:
- mostly wants free information
- is highly cynical or argumentative without real openness
- does not value structured guidance
- tries to extract advisory work for free via chat
- is not actually serious or ready

## 3.3 Edge-case profiles
The CRM must also identify:
- very curious but not ready leads
- spouse-dependent leads
- webinar-warm but financially unclear leads
- operationally hot but strategically low-fit leads
- support inquiries from existing students

---

# 4. Sales philosophy

## 4.1 Default sales path
The system should not be built around mandatory phone sales.
The preferred motion is:
- lead enters
- intelligent first response
- qualification via WhatsApp/chat
- trust/value framing
- objection handling
- checkout link push
- autonomous purchase if possible

## 4.2 Phone is exception, not default
Phone calls should be used only when justified, for example:
- the lead strongly requests a call
- there is clear buying intent but text is not enough
- a human closer is likely to materially improve conversion
- Mia identifies that voice interaction is needed

## 4.3 Core design principle
The system should maximize conversion **without wasting human cost**.

---

# 5. North-star priorities
Initial stage priorities, in order:
1. do not miss leads
2. maximize conversion
3. reduce operational noise
4. keep strong visibility and control
5. learn from real interactions and improve over time

---

# 6. System name
## Karnaf CRM

This should be the canonical internal and product name of the system.

---

# 7. Operating model

## 7.1 Roles
### Kobi (AI operator)
Responsible for:
- intake handling
- first response
- qualification
- follow-up
- status updates
- queue management
- basic objection handling
- escalation triggering
- transcript analysis
- data hygiene
- detection of stuck leads
- prioritization
- analytics review support

### Mia (human operations + support)
Responsible for:
- daily oversight (1-2 hours/day)
- handling escalated human interactions
- answering professional/explanatory questions when needed
- helping leads complete purchase when friction exists
- handling first-level human rescue for delayed or problematic leads
- verifying that system automation is healthy
- marking leads for phone escalation when necessary

### Phone sales rep
Responsible for:
- high-intent phone escalations only
- verbal closing when text is insufficient
- handling cases where a call is likely to improve conversion materially

### Owner / business lead
Responsible for:
- strategic direction
- approval rules
- pricing/offer constraints
- messaging boundaries
- final exception decisions

---

# 8. Core channels and source model

## 8.1 Initial intake sources
The system must support ingestion from:
- landing page forms
- webinar forms
- Responder / רב מסר forms
- lead magnet forms
- website forms
- WhatsApp inbound messages
- Instagram DMs
- manual lead entry
- screenshot/manual transcription of inquiries

## 8.2 Source normalization model
Every lead must be normalized into a common source taxonomy, e.g.:
- landing_page
- webinar
- responder_form
- lead_magnet
- whatsapp_direct
- instagram_dm
- manual_entry
- screenshot_manual
- unknown

## 8.3 Source heat assumption at launch
Initial prior ranking:
1. WhatsApp / Instagram initiative by lead
2. webinar lead who left details
3. standard form lead
4. lead magnet lead

This should later be corrected using real conversion data.

---

# 9. Dedicated WhatsApp number model

## 9.1 Decision
A separate dedicated WhatsApp number should be used for this system.

## 9.2 Why
This avoids:
- mixing operations with unrelated business communication
- breaking context
- contaminating the CRM with irrelevant conversations
- operational confusion for Mia

## 9.3 Shared usage model
That dedicated number must be usable by:
- the AI operator
- Mia
- future human intervention agents

## 9.4 Principle
There should be one shared operational conversation source of truth.
The system must preserve continuity when moving between AI and human handling.

---

# 10. Working hours and SLA principles

## 10.1 Official working window
### 09:00-21:00

## 10.2 Weekend handling
On Friday/Saturday or outside human-active windows:
- the system should still provide first response and directional guidance when allowed
- if the lead requires human follow-up, the system must mark the lead cleanly for Mia on the next available work window
- if urgency is high, the system must create a visible alert

## 10.3 Hard rule
### No lead should remain unanswered for more than 12 hours
If a lead is approaching this threshold and not progressing, the system must alert Mia.

---

# 11. System architecture overview

The recommended architecture is layered:

## Layer 1. Intake layer
Collects leads from all supported channels.

## Layer 2. CRM state engine
Stores lead records, states, next actions, ownership, history, score, and escalation state.

## Layer 3. Conversation engine
Runs first-response, follow-up, qualification, and redirect behavior through WhatsApp.

## Layer 4. Human oversight console
Allows Mia to supervise, intervene, prioritize, and operate.

## Layer 5. Analytics and learning layer
Tracks source quality, response quality, conversion patterns, SLA misses, and optimization opportunities.

## Layer 6. WhatsApp integration and runtime layer
Responsible for:
- inbound webhook intake
- outbound message sending
- delivery/read status handling
- session window awareness
- template/freeform selection
- media handling
- retry/failure handling
- AI/human ownership switching
- transcript logging and message deduplication

---

# 12. WhatsApp runtime architecture

## 12.1 Purpose
This layer is the operational bridge between Karnaf CRM and the actual WhatsApp channel.
It must not be implemented as a simple "send prompt, get answer" bot.
It must behave like a message runtime connected to CRM state, policy, transcripts, and escalation logic.

## 12.2 Required capabilities
The WhatsApp runtime must support:
- inbound message webhook ingestion
- outbound freeform message sending
- outbound template message sending when required by provider/session rules
- message delivery, sent, failed, and read status callbacks
- media message ingestion and storage metadata
- conversation ownership state (AI / Mia / phone rep)
- suppression and opt-out enforcement
- retry logic for transient failures
- duplicate inbound event protection
- conversation-session tracking

## 12.3 Runtime components
Recommended components:
1. **WhatsApp Connector**
   - provider-facing adapter
   - receives inbound events
   - sends outbound messages
   - normalizes provider payloads
2. **Conversation Orchestrator**
   - decides what to do with each inbound event
   - loads lead state and context
   - picks playbook and response mode
3. **Context Builder**
   - assembles the exact context package for the model
4. **AI Decision Engine**
   - generates structured response and state recommendations
5. **Action Writer**
   - writes CRM updates, tasks, and events
6. **Human Handoff Manager**
   - transfers conversation ownership to Mia or phone sales cleanly
7. **Reliability Guard**
   - retries failed sends
   - blocks duplicate processing
   - raises alerts when webhook/provider health degrades

## 12.4 Provider abstraction rule
The CRM must not hardcode business logic directly into one provider SDK.
All provider-specific logic should be isolated behind a connector adapter so the system can later change provider without rewriting CRM behavior.

## 12.5 Message lifecycle
Each inbound or outbound WhatsApp message should move through a lifecycle:
- received
- normalized
- stored
- classified
- context-resolved
- responded or queued
- CRM updated
- delivery tracked
- audit event recorded

---

# 13. Conversation orchestration specification

## 13.1 Goal
For every relevant inbound message, the system must decide:
- who owns the conversation now
- what this message means
- what playbook applies
- whether AI should respond now
- whether Mia should be alerted
- what CRM updates must happen
- what next action and timer should be created

## 13.2 Orchestration flow
Recommended flow:
1. receive inbound webhook
2. verify provider signature if supported
3. deduplicate by provider message id
4. normalize message payload
5. resolve lead by phone / conversation id
6. create lead if unknown and allowed
7. append transcript entry
8. classify message intent and conversation state
9. load lead profile + state + transcript summary + policy bundle
10. decide ownership path:
   - AI reply
   - queue for Mia
   - phone escalation recommendation
   - no reply / stop / DNC
11. call model with structured context
12. parse structured output
13. validate against policy
14. send message if approved
15. write CRM state updates
16. create tasks/alerts/events
17. schedule follow-up if needed

## 13.3 Ownership states
Conversation ownership should be explicit:
- ai_active
- mia_active
- phone_sales_pending
- shared_watch
- do_not_contact

No ambiguous ownership should exist on a live lead.

## 13.4 Orchestrator outputs
The orchestrator should produce structured outputs such as:
- reply_text
- reply_channel_mode (freeform/template/manual_only)
- lead_status_update
- lead_heat_update
- score_delta
- escalate_to_mia
- escalate_to_phone_sales
- next_action_type
- next_action_due_at
- tags_to_add
- notes_for_mia
- policy_flags

---

# 14. Context assembly specification

## 14.1 Context goal
The model should never answer from raw prompt alone.
Each turn must be assembled from the minimum complete relevant context.

## 14.2 Required context blocks per reply
- lead identity block
- source block
- current CRM status block
- lead score / heat block
- readiness / blocker summary
- partner context
- transcript summary
- last relevant messages window
- applicable playbook goal
- allowed claims and forbidden claims
- working-hours context
- ownership context
- checkout/payment state if relevant

## 14.3 Transcript policy
Do not dump the entire conversation into the model each time.
Use:
- a rolling short message window for recent turns
- a maintained structured summary for older context

## 14.4 Knowledge retrieval bundle
When relevant, inject:
- product facts
- price framing rules
- objection rules
- checkout path info
- support boundaries
- approved language constraints

---

# 15. Structured model output contract

## 15.1 Principle
The AI layer must not return only message text.
It should return a structured action object that the system can validate and execute.

## 15.2 Suggested JSON contract
```json
{
  "reply_text": "...",
  "reply_confidence": "high",
  "intent_classification": "price_objection",
  "lead_heat": "hot",
  "lead_status_update": "qualified",
  "score_delta": 8,
  "escalate_to_mia": false,
  "escalate_to_phone_sales": false,
  "next_action_type": "follow_up",
  "next_action_due_at": "2026-04-27T14:00:00+03:00",
  "tags_to_add": ["price-sensitive", "high-fit"],
  "notes_for_mia": "...",
  "policy_flags": [],
  "send_mode": "freeform"
}
```

## 15.3 Validation layer
Before execution, the system must validate:
- no forbidden claim is present
- output status transition is legal
- send mode is allowed by current WhatsApp window/provider rules
- escalation decisions are internally consistent

---

# 16. Human handoff protocol

## 16.1 Goal
When AI should stop owning the thread, handoff must be clean, explicit, and reversible.

## 16.2 Handoff package must include
- reason for handoff
- short lead summary
- current state
- main blocker
- last messages summary
- suggested human next move
- urgency level
- SLA timer state

## 16.3 Handoff UI requirements
Mia should see:
- handoff badge
- why it was escalated
- suggested draft reply
- risk level
- ownership control buttons

## 16.4 Return-to-AI protocol
After Mia handles the critical moment, she should be able to:
- keep ownership manually
- return ownership to AI
- return ownership to AI with constraints
- mark for phone escalation instead

---

# 17. WhatsApp operational constraints

## 17.1 Session and template awareness
The system must account for provider/session rules such as:
- freeform replies within allowed windows
- template initiation when outside allowed windows
- fallback if template approval is missing

## 17.2 Opt-out compliance
If the lead asks to stop, remove, or not be contacted:
- suppress automation immediately
- record suppression reason
- prevent future outbound messages except allowed compliance/admin flows

## 17.3 Delivery-state awareness
The CRM should store message states such as:
- queued
- sent
- delivered
- read
- failed

This should be visible on the lead timeline.

## 17.4 Failure handling
For failed sends:
- retry if transient
- raise system alert if repeated
- create manual review task if needed

## 17.5 Duplicate and race-condition protection
The runtime should:
- deduplicate inbound webhook events
- prevent double replies from parallel workers
- lock per-conversation processing when needed

---

# 18. Product design philosophy for the UI

## 12.1 Functional first
The dashboard should be:
- clear
- fast
- actionable
- not overloaded
- visually ordered
- confidence-inducing

## 12.2 Not overdesigned
This is not a decorative mission control screen.
It should feel like:
- a serious operator console
- a lead operations desk
- a system where Mia can immediately see what matters now

## 12.3 Design qualities
- high signal density
- low clutter
- clear urgency hierarchy
- color and motion used to highlight state, not to entertain
- everything visible should support action

---

# 13. Main product surfaces

## 13.1 Overview dashboard
Purpose: give Mia a fast operational picture.

Must show:
- leads received today
- leads awaiting first response
- leads close to SLA breach
- hot leads
- payment-pending leads
- human handoff queue
- conversion funnel snapshot
- channel/source distribution
- last 24h activity stream

## 13.2 Leads workspace
Purpose: inspect and manage leads.

Must allow:
- search
- filtering
- sorting
- segmentation by source
- segmentation by heat/score
- segmentation by ownership
- segmentation by state
- segmentation by payment / escalation / DNC flags

## 13.3 Lead detail page
Purpose: full operational context per lead.

Must include:
- profile block
- source and intake metadata
- current state
- lead score
- tags
- pain point / readiness summary
- transcript timeline
- next action
- action buttons
- AI summary
- escalation notes
- Mia notes
- payment history / purchase state if applicable

## 13.4 Queues center
Purpose: action-first workbench.

Queues should include:
- first response due
- hot leads
- SLA risk
- handoff required
- payment pending
- no response follow-up
- nurture due
- weekend carryover
- phone escalation candidates
- DNC / cleanup review

## 13.5 Analytics view
Purpose: learn and improve.

Must include:
- source performance
- response rate by source
- qualification rate by source
- checkout push rate
- checkout completion rate
- lead-to-sale time
- objection frequency map
- lost reasons distribution
- AI vs Mia intervention impact

## 13.6 Automation control center
Purpose: system health and automation visibility.

Must include:
- active automations
- failed automations
- webhook status
- WhatsApp delivery issues
- queue backlog anomalies
- last sync time per source
- retry / reprocess options

---

# 14. CRM schema

## 14.1 Lead entity
Required fields:
- lead_id
- created_at
- updated_at
- full_name
- phone
- email
- source
- source_detail
- campaign_name
- webinar_name
- lead_magnet_name
- intake_channel
- lead_status
- lead_score
- lead_heat
- sales_motion_type
- pain_point_summary
- goal_summary
- readiness_level
- fit_level
- main_blocker
- partner_involved (boolean)
- partner_alignment_state
- requested_phone_call (boolean)
- should_escalate_to_mia (boolean)
- should_escalate_to_phone_sales (boolean)
- do_not_contact (boolean)
- remove_requested (boolean)
- human_owner
- ai_owner_state
- next_action_type
- next_action_due_at
- last_touchpoint_at
- checkout_link_sent_at
- checkout_opened_at (if available)
- payment_status
- payment_completed_at
- won_at
- lost_at
- lost_reason
- notes

## 14.2 Transcript entity
Fields:
- transcript_id
- lead_id
- channel
- sender_type (lead / ai / mia / sales_rep / system)
- sender_name
- message_text
- message_timestamp
- message_type (text / media / system_event)
- ai_classification
- sentiment_signal
- requires_review

## 14.3 Task / action entity
Fields:
- task_id
- lead_id
- task_type
- owner
- due_at
- priority
- status
- created_by
- completed_at
- notes

## 14.4 Event log entity
Fields:
- event_id
- lead_id
- event_type
- event_timestamp
- actor_type
- actor_id
- payload_json

## 14.5 Source record entity
Fields:
- source_record_id
- lead_id
- original_payload
- source_system
- received_at
- ingestion_status
- normalized_fields_json

---

# 15. Lead classes and fit model

## 15.1 Lead fit classes
- high_fit
- medium_fit
- low_fit
- not_fit

## 15.2 Heat classes
- hot
- warm
- cool
- cold

## 15.3 Decision context classes
- self_decider
- partner_involved
- unclear

## 15.4 Readiness classes
- ready_now
- ready_soon
- researching
- low_readiness

---

# 16. Lead scoring model

## 16.1 Scoring dimensions (0-100)
- urgency: 0-20
- program fit: 0-20
- openness to expertise: 0-15
- responsiveness: 0-15
- purchase readiness: 0-15
- pain severity / desire to avoid mistakes: 0-15

## 16.2 Score modifiers
- WhatsApp/Instagram self-initiated: +10
- webinar attendee + details: +12
- repeated free-advice extraction behavior: -12
- partner hesitation signal: -7 risk modifier
- asked for phone call: +5 heat, not necessarily +fit
- strong value recognition statement: +10
- explicit price rejection without engagement: -8

## 16.3 Score bands
- 80-100 = hot
- 60-79 = warm
- 40-59 = nurture-short
- 0-39 = low-fit / nurture-long / possible disqualify

---

# 17. Lead lifecycle states

Primary sales states:
- new
- first_contact_sent
- responded
- qualified
- nurture
- checkout_pushed
- payment_pending
- human_handoff
- won
- lost
- dormant

Post-sale states:
- onboarding_active
- active_student
- support_active
- referral_candidate
- upsell_future

Administrative states:
- do_not_contact
- removed_by_request
- duplicate
- manual_review_required

---

# 18. State machine

| From | To | Trigger | Owner | Required before transition |
|---|---|---|---|---|
| new | first_contact_sent | first WhatsApp message sent | AI | source, contact, intake timestamp |
| first_contact_sent | responded | lead responded | AI | transcript logged |
| responded | qualified | pain + readiness + fit understood | AI | score, blocker, goal summary |
| responded | nurture | not ready, but worth warming | AI | reason |
| qualified | checkout_pushed | smart conversion moment reached | AI/Mia | value framed, lead fit confirmed |
| checkout_pushed | payment_pending | lead clicked/shows buying intent but not complete | AI/Mia | friction note |
| any active | human_handoff | human-needed condition met | AI | handoff package |
| payment_pending | won | payment webhook or confirmed completion | System/AI | payment signal |
| any active | lost | hard no / value rejection / non-fit | AI/Mia | loss reason |
| nurture | dormant | no engagement after SLA/cadence exhaustion | AI | attempts logged |
| won | onboarding_active | access/setup begun | System/Mia | onboarding trigger |
| any | removed_by_request | lead asked for removal | AI/Mia | remove reason |

Rules:
- no silent state changes
- no skipping required data fields
- any high-risk ambiguity triggers review, not blind automation

---

# 19. Human-vs-AI authority logic

## 19.1 AI can do directly
- create/update leads
- send first response
- ask qualification questions
- send follow-ups within approved playbooks
- redirect free-advice seekers after limit
- push checkout link intelligently
- classify lead heat and fit
- mark SLA risks
- produce summaries

## 19.2 AI can do by policy
- multiple follow-ups
- nurture sequencing
- dormant classification
- Mia escalation recommendation
- phone escalation recommendation
- cleanup recommendations

## 19.3 Requires Mia / human review
- emotional or tense interactions
- unclear professional answers beyond scope
- high-potential lead stuck at purchase friction
- lead near SLA threshold with unresolved ambiguity
- partner-related complexity
- repeated skepticism that may still be recoverable

## 19.4 Requires phone sales rep
- lead explicitly asks for a call
- Mia determines call is likely to close
- strong buying intent but text path stalls

---

# 20. Free-advice boundary model

## Policy
2-3 meaningful knowledge/support answers are acceptable.
After that, the system must redirect toward the program.

## Objective
Be useful and respectful without leaking the paid value engine into free endless advisory chat.

## Pattern
- answer briefly
- acknowledge seriousness
- frame the limitation
- connect the deeper answer to the program
- move to action

## When to stop
A lead becomes a likely low-fit/free-extraction case if:
- they ask many detailed advisory questions without progressing
- they repeatedly reject program framing while seeking continued value
- they show strong skepticism with little openness

Then:
- redirect once more
- if necessary mark as low-fit or dormant

---

# 21. Objection handling framework

Expected objections:
- too expensive
- I need to think
- send me details
- I’m not sure this is for me
- I only want free information
- I’m skeptical
- my partner isn’t aligned
- I don’t have time now

Rule:
Do not “win” objections.
Instead classify the underlying gap:
- value gap
- trust gap
- timing gap
- money gap
- readiness gap
- complexity gap

Then route accordingly.

---

# 22. WhatsApp agent behavior spec

## 22.1 Tone
- personal
- professional
- direct
- courteous
- not flattering
- not aggressive
- one emoji max per message when naturally useful
- use lead name if known
- if unknown, neutral opening

## 22.2 First message purpose
- establish contact
- anchor source/context
- create relevance
- ask for one meaningful next-step answer

## 22.3 Qualification behavior
- one or two questions at a time
- no interrogation block
- gather additional missing CRM fields through conversation naturally
- infer behavior and readiness from answers

## 22.4 Conversion behavior
- do not rush too early
- move to checkout when fit + value recognition + relevance are sufficiently clear
- use Mia or phone rep when text friction is real and valuable to address

## 22.5 Stop / remove handling
System must recognize:
- stop
- remove me
- not interested
- irrelevant

Then:
- mark do_not_contact / removed_by_request as needed
- stop future automated contact
- preserve suppression log

---

# 23. Playbook architecture

Must exist for:
- WhatsApp hot inbound lead
- Instagram DM lead
- webinar lead
- landing page form lead
- lead magnet lead
- no response follow-up sequence
- value framing before checkout
- price objection
- skepticism objection
- free-advice boundary
- payment pending rescue
- partner hesitation
- Mia handoff
- phone-sales handoff
- dormant reactivation after 1-2 months
- post-purchase onboarding nudge
- referral request

Each playbook should define:
- trigger
- objective
- allowed message structure
- escalation criteria
- stop conditions
- CRM updates

---

# 24. Mia operating model

## 24.1 Mia goals
- ensure no lead is neglected
- catch what AI should not own alone
- answer human-level questions when needed
- rescue high-potential stalled leads
- maintain system hygiene and oversight

## 24.2 Mia daily workflow (1-2h/day)
Must review:
- leads close to 12h threshold
- hot leads
- human_handoff queue
- payment_pending queue
- phone escalation candidates
- failed automations / webhook failures
- weekend carryover

## 24.3 Mia actions from system
Mia should be able to:
- open lead
- see full transcript
- send reply from same system
- change status
- tag lead
- mark for phone escalation
- assign notes
- mark as resolved / continue AI ownership

## 24.4 Mia SLA
- hot human handoff: <= 15 min inside active oversight window
- warm handoff: <= 1 hour within active handling window
- unresolved after-hours issues: queued with priority for next day

---

# 25. Phone escalation model

Phone escalation is not default.
It is justified when:
- lead explicitly requests a call
- lead is high-fit and high-intent but textually blocked
- Mia judges that voice interaction is likely to materially improve close probability

The system should surface a queue:
- phone_escalation_candidates

Fields needed:
- why phone recommended
- urgency
- suggested angle
- summary of transcript

---

# 26. Working-hours logic

## Official hours
09:00-21:00

## Outside hours
- AI may still send first response if policy allows
- if issue requires Mia and can wait, queue for next active window
- if hot lead is at risk, create visible high-priority alert

## Weekend logic
- provide first response and basic guidance where appropriate
- if human intervention needed, carry context to Sunday queue
- system must generate structured carryover note

---

# 27. SLA framework

Hard rule:
## no lead should remain unanswered for more than 12 hours

SLA table:
| Lead type | Target first response | Max first response | Follow-ups | Dormant threshold |
|---|---:|---:|---:|---:|
| WhatsApp/IG hot | <= 30 min | 12h | 5 | 5 days |
| Webinar lead | <= 2h | 12h | 5 | 7 days |
| Form lead | <= 4h | 12h | 4 | 7 days |
| Lead magnet lead | <= 8h | 12h | 3 | 14 days |
| Nurture lead | <= 24h | 24h | 2 | 30 days |

Alerting:
- 8h no response -> warning
- 10h no response -> high warning
- 12h no response -> Mia escalation alert

---

# 28. Queue design

Required queues:
- new_unanswered
- hot_leads
- sla_risk
- human_handoff
- payment_pending
- phone_escalation_candidates
- nurture_due
- dormant_review
- removed/do_not_contact
- failed_automation
- weekend_carryover
- low_fit_cleanup

Each queue should support:
- count
- urgency indicator
- sort by risk / age / source / score
- click into lead detail

---

# 29. Dashboard spec

## Dashboard must answer in under 10 seconds:
- what needs action now
- which leads are hottest
- where risk exists
- whether automation is healthy
- where conversion leakage is happening

## Dashboard sections
### Top KPI bar
- leads today
- unanswered now
- hot leads now
- payment pending now
- won today/week/month
- SLA at-risk count

### Conversion snapshot
- new -> responded
- responded -> qualified
- qualified -> checkout_pushed
- checkout_pushed -> won

### Action queues block
- first response due
- hot leads
- Mia handoffs
- payment pending
- phone candidates
- SLA breach risk

### Activity stream
- last inbound messages
- last AI messages
- last human interventions
- last state changes

### Source performance
- lead count by source
- conversion by source
- response rate by source

### System health
- webhook health
- WhatsApp delivery issues
- automation errors
- sync freshness

---

# 30. Lead detail page spec

Sections:
1. Header summary
   - name, source, status, score, heat, owner
2. Quick actions
   - send reply
   - assign to Mia
   - mark phone escalation
   - push checkout
   - mark low-fit
   - mark won/lost
3. Snapshot summary
   - goal
   - pain
   - blocker
   - readiness
   - partner context
4. Transcript timeline
5. AI summary block
6. Mia notes block
7. Next action panel
8. Audit / event log
9. Payment / checkout panel

---

# 31. Automation rules

## 31.1 Intake automations
- new form/webinar/responder leads create lead record
- normalized source assigned
- first response queue item created

## 31.2 Messaging automations
- send first response by playbook
- schedule follow-up according to source/heat
- stop automation on DNC/remove

## 31.3 Escalation automations
- lead approaching 12h no-answer threshold -> alert Mia
- payment pending > defined window -> queue Mia
- explicit phone request -> phone candidate queue
- repeated free-advice pattern -> low-fit warning

## 31.4 Post-purchase automations
- payment signal -> won
- onboarding task created
- access / support follow-up task created

---

# 32. Payment and purchase signal model

The system must support payment-state confirmation through:
- webhook from Responder/Skooler if available
- API integration if available
- alternative structured confirmation path if webhook is not available initially

Events expected:
- checkout_link_generated
- checkout_link_sent
- payment_started (optional if available)
- payment_completed
- payment_failed (optional)

If payment completed:
- lead_status -> won
- purchase timestamp stored
- onboarding flow begins

---

# 33. API and webhook contracts

## 33.1 Lead intake webhook
`POST /api/leads/intake`

Payload example:
```json
{
  "source": "webinar",
  "source_detail": "webinar-april-launch",
  "full_name": "...",
  "phone": "...",
  "email": "...",
  "campaign_name": "...",
  "metadata": {}
}
```

Response:
```json
{
  "ok": true,
  "lead_id": "lead_xxx"
}
```

## 33.2 Manual lead creation
`POST /api/leads/manual`

## 33.3 WhatsApp inbound event
`POST /api/channels/whatsapp/inbound`

Payload should include:
- message id
- sender number
- timestamp
- message text/media
- channel metadata

## 33.4 Instagram/manual ingestion
Can enter via manual tool or import endpoint.

## 33.5 Payment webhook
`POST /api/payments/responder`

Payload should include at minimum:
- phone/email/customer id
- product id
- order id
- payment status
- timestamp

## 33.6 Alerting endpoint (internal)
`POST /api/alerts/create`

---

# 34. Event model

Recommended event types:
- lead_created
- source_normalized
- first_response_sent
- lead_responded
- lead_scored
- lead_qualified
- lead_nurture_assigned
- checkout_pushed
- payment_pending_detected
- payment_completed
- mia_handoff_created
- phone_escalation_marked
- lead_lost
- lead_dormant
- lead_removed
- automation_failed
- sla_warning
- sla_breach

All major actions should emit events.

---

# 35. DNC / cleanup rules

The system must support:
- not_interested
- not_relevant
- do_not_contact
- removed_by_request
- dormant

Rules:
- if lead explicitly asks for removal -> removed_by_request immediately
- if lead explicitly says not relevant / not interested -> no aggressive follow-up
- dormant leads may receive delayed reactivation after 1-2 months only if not DNC/removed

---

# 36. Learning and self-improvement model

The AI operator should improve based on conversation data.

Track over time:
- which first-message variants produce higher response
- which objections occur most often
- which sources produce best close rates
- which leads get saved by Mia
- which cases truly needed phone
- where checkout drop-off occurs
- where free-advice leakage is highest

Learning outputs:
- updated playbooks
- adjusted scoring
- refined source weighting
- improved Mia queue logic
- better checkout push timing

---

# 37. Quality assurance loop

## Daily review (Mia)
- unanswered leads
- SLA risk leads
- handoff queue
- payment pending queue
- automation failures

## Weekly review
- source performance
- objection clusters
- best messages
- failed messages
- stuck states
- Mia vs AI resolution patterns

## Monthly review
- conversion economics
- overall funnel leakage
- need for more phone involvement or less
- policy changes
- new playbooks required

---

# 38. Economics and business analytics

Initial business goal:
- dream target: ~20 customers per month
- annual target: ~200-250 customers
- expected annual revenue: ~600k-700k ILS
- ideal post-expense outcome: ~500k ILS

The system should later help determine:
- acceptable CPL by source
- acceptable CAC
- conversion rate required to sustain target
- when paid campaigns are efficient
- when webinar strategy performs better than standard lead magnets

---

# 39. Future extensibility

Although the current focus is one product, the architecture should later support additional inquiry classes without confusing the UI or lead-handling flow.

Future inquiry classes may include:
- partnership inquiry
- consulting inquiry
- investor guidance inquiry
- support request

These should be separate paths, not mixed into the main דרך לדירה flow.

---

# 40. Open questions that can be refined later
- exact launch and webinar pricing rules
- exact checkout tracking capability from Responder/Skooler
- approved testimonials/case studies
- exact reactivation timing policy
- exact threshold for handing more leads to phone sales if conversion data suggests benefit

These are not blockers for building the system skeleton.

---

# 41. Build strategy recommendation

## Recommended order
1. build data model + intake + dashboard skeleton
2. build queues + lead detail + transcript view
3. build WhatsApp operator hooks and state updates
4. build Mia console actions
5. build alerting and SLA logic
6. build payment webhooks and purchase state
7. build analytics and QA layer

## Important recommendation
Start with **lean and real**, not overpolished and fake.
Then layer premium UI once the underlying machine is correct.

---

# 42. Final summary
Karnaf CRM should be built as:

## a no-lead-left-behind sales operating system
for one core product, **הדרך לדירה**,
with:
- centralized lead intake
- smart CRM state management
- advanced WhatsApp-first AI interaction
- human oversight by Mia
- selective phone escalation
- fast SLA discipline
- strong cleanup and prioritization
- analytics and learning loops
- one functional dashboard where the whole operation can be run

This is the system the developer should build.
