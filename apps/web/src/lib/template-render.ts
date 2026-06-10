// Render a template body against a flat context map.
//
// The body uses {{var_name}} markers; each one is replaced by
// context[var_name] coerced to a string. Missing variables are
// returned in the `missing` array so the caller can decide whether
// to send a half-filled message or refuse.
//
// Trims double-curly with optional whitespace inside, so both
// {{first_name}} and {{ first_name }} work.

export interface RenderResult {
  text: string;
  missing: string[];
}

const TOKEN_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

export function renderTemplate(body: string, context: Record<string, unknown>): RenderResult {
  const missing: string[] = [];
  const text = body.replace(TOKEN_RE, (_match, varName: string) => {
    const value = context[varName];
    if (value === undefined || value === null || value === '') {
      if (!missing.includes(varName)) missing.push(varName);
      return `{{${varName}}}`;
    }
    return String(value);
  });
  return { text, missing };
}

// Build a context from a LeadDetail-ish object. Used by the reply
// composer when previewing/sending a template. Any field that isn't
// present stays undefined so the renderer marks it as missing.
export function contextFromLead(lead: {
  full_name?: string | null;
  phone?: string | null;
  email?: string | null;
  city?: string | null;
}): Record<string, unknown> {
  const firstName = lead.full_name?.split(/\s+/u)[0] ?? '';
  return {
    first_name: firstName,
    full_name: lead.full_name ?? '',
    phone: lead.phone ?? '',
    email: lead.email ?? '',
    city: lead.city ?? '',
  };
}
