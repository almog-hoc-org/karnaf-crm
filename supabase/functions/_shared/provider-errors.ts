// Mirrored by lib/runtime/provider-errors.ts (unit-tested there). Keep in sync.
//
// Meta template-configuration errors — the template referenced by name
// doesn't exist (#132001) or its approved variable count doesn't match
// what we sent (#132000). Both mean "no retry will help until the
// template is fixed in Meta Business Manager": the right handling is to
// queue the reply for the next inbound (24h window reopens), not to
// hard-fail or retry.

const TEMPLATE_CONFIG_MARKERS = [
  '132001',
  '132000',
  'template name does not exist',
  'number of localizable_params',
  'number of parameters does not match',
];

export function isTemplateConfigError(error: string | null | undefined): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  return TEMPLATE_CONFIG_MARKERS.some((m) => lower.includes(m));
}

// The single canonical param shape for the fallback template wrap —
// every sender (orchestrate-message, dispatch-outbound, send-reply)
// must use this so the approved {{1}} body variable always gets exactly
// one value.
export function fallbackTemplateParams(text: string): Array<{ name: string; value: string }> {
  return [{ name: 'reply', value: text }];
}
