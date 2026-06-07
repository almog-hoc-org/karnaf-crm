# Operator Customer Flow QA — 2026-06-07

Scope: `push-whatsapp-fix` operator UX slice for Karnaf CRM.

Goal: verify the CRM behaves like a sales operating system, not just a nicer screen. A new operator should be able to open Inbox, understand the lead, choose the right owner, and close the loop safely.

## Manual / semi-automated scenarios

### 1. General interest lead
- Example customer: “ראיתי את התוכנית שלכם, אפשר להבין מה מקבלים?”
- Expected classification: info seeker / program details / AI can start.
- Expected AI behavior: short answer, one diagnostic question, no long lecture.
- Expected Inbox/LeadDetail: AI active or follow-up only; no human takeover unless the customer asks for personal guidance.
- Completion decision: if no human action is needed, keep AI active; do not create manual queue noise.
- Result on current slice: UI supports this via AI active guidance and “only monitor” action.

### 2. Hot lead asking for price
- Example customer: “כמה זה עולה? אני רוצה להתחיל השבוע.”
- Expected classification: hot sales / pricing / high urgency.
- Expected AI behavior: answer briefly, qualify budget/readiness, escalate if buyer intent is clear.
- Expected Inbox/LeadDetail: hot/call/reply lane; operator sees why the lead is hot and what to say next.
- Completion decision: transfer to Mia or phone sales if human close is needed; close queue only after handoff/call is logged.
- Result on current slice: LeadDetail action guidance supports phone/human escalation; completion guide now names the handoff rule explicitly.

### 3. Lead asking for a call
- Example customer: “אפשר לדבר עם מישהו בטלפון?”
- Expected classification: phone request / phone_sales_pending.
- Expected AI behavior: acknowledge and collect/confirm phone + preferred time if missing.
- Expected Inbox/LeadDetail: call lane, “השלב הנכון הוא שיחת טלפון”, quick action to mark phone escalation.
- Completion decision: after call, document outcome; if still active, assign Mia/next action; if done, close queue.
- Result on current slice: supported by Inbox lane + LeadDetail phone insight.

### 4. Existing customer / support
- Example customer: “כבר רכשתי, לא מצליח להתחבר לכלים.”
- Expected classification: support_or_existing / support.
- Expected AI behavior: avoid sales pitch; route to human/support.
- Expected Inbox/LeadDetail: human handoff/Mia, clear note that this is not a new sales lead.
- Completion decision: assign to Mia/support; return to AI only if the support issue is resolved and automation is safe.
- Result on current slice: classification labels include support/existing; completion guide now makes the “Mia vs AI” decision explicit.

### 5. Irrelevant / asks not to be contacted
- Example customer: “לא רלוונטי, אל תפנו אליי יותר.”
- Expected classification: opt out / DNC.
- Expected AI behavior: acknowledge once if appropriate, stop outreach.
- Expected Inbox/LeadDetail: DNC / suppressed / closed, no reply box action if disabled.
- Completion decision: mark DNC or lost; never return to AI unless admin reopens because it was a mistake.
- Result on current slice: LeadDetail already disables reply on DNC/removed; completion guide now names the no-contact rule.

## Product QA checklist

- [x] Operator default route lands on Inbox.
- [x] Inbox explains first-day workflow and lane priority.
- [x] Queue close templates include handled, Mia, AI return, and opt-out/lost guidance.
- [x] LeadDetail gives action-first guidance by state: closed, failed automation, phone, human handoff, AI active, unknown owner.
- [x] LeadDetail now includes one explicit “סיום טיפול” decision guide: handled / Mia / AI / lost-DNC.
- [x] The five customer scenarios above have a documented expected path and completion rule.

## Remaining product risks

- This is still mostly UI + workflow QA; it does not prove the live AI classifier/reply quality against real WhatsApp data.
- A future deeper pass should seed fixtures for all five scenarios and assert backend classification + playbook selection.
- Credentialed Playwright E2E remains environment-dependent; public smoke is the available automated gate in this branch.
