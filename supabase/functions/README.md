# supabase/functions

Suggested first function set:
- `whatsapp-webhook` - receives inbound provider payloads and normalizes them
- `orchestrate-message` - loads context, invokes the AI decision engine, writes CRM updates
- `payment-webhook` - ingests payment completion events and moves leads toward `won`
- `admin-actions` - optional protected actions for queue resolution / ownership changes
