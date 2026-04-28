// Israeli phone number normalization. Mirrors the Deno-only copy in
// supabase/functions/_shared/phone.ts so the same logic can be unit-tested
// from Vitest.

export function normalizeIsraeliPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let phone = raw.replace(/[\s\-().]/g, '');
  if (phone.startsWith('+972')) phone = '0' + phone.slice(4);
  else if (phone.startsWith('00972')) phone = '0' + phone.slice(5);
  else if (phone.startsWith('972') && phone.length > 9) phone = '0' + phone.slice(3);
  phone = phone.replace(/^\+/, '');
  if (!phone.startsWith('0') && phone.length === 9) phone = '0' + phone;
  return phone.length >= 9 ? phone : null;
}

export function toWhatsAppPhone(raw: string): string {
  const normalized = normalizeIsraeliPhone(raw) || raw.replace(/[^\d]/g, '');
  if (normalized.startsWith('0')) return '972' + normalized.slice(1);
  if (normalized.startsWith('972')) return normalized;
  return '972' + normalized;
}
