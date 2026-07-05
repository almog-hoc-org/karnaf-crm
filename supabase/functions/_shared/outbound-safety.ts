const BLOCKED_OUTBOUND_PATTERNS = [
  'יא אפס',
  'אפס',
  'טיפש',
  'טיפשה',
  'מטומטם',
  'מטומטמת',
  'סתום',
  'סתומה',
  'קול סקסי',
  'סקסי',
  'idiot',
  'stupid',
  'sexy',
];

export function validateOutboundText(text: string): { ok: true } | { ok: false; reason: string } {
  const normalized = text.toLocaleLowerCase('he-IL').replace(/\s+/g, ' ').trim();
  const hit = BLOCKED_OUTBOUND_PATTERNS.find((pattern) => normalized.includes(pattern.toLocaleLowerCase('he-IL')));
  if (hit) return { ok: false, reason: `unsafe_outbound_phrase:${hit}` };
  return { ok: true };
}
