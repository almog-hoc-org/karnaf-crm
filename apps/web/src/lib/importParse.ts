// Parses a pasted roster (CSV / Excel paste / plain lines) into import
// rows. Accepts one contact per line; fields split by comma, tab or
// semicolon. Field roles are detected by shape — email has '@', phone is
// digit-heavy — so column order doesn't matter; leftover text is the name.

export interface ParsedImportRow {
  phone: string;
  fullName: string | null;
  email: string | null;
}

const PHONE_RE = /^[\d\s\-+().]{7,}$/;

export function parseImportRows(text: string): { rows: ParsedImportRow[]; invalid: string[] } {
  const rows: ParsedImportRow[] = [];
  const invalid: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const fields = line.split(/[,\t;]/).map((f) => f.trim()).filter(Boolean);
    let phone: string | null = null;
    let email: string | null = null;
    const nameParts: string[] = [];
    for (const field of fields) {
      if (!email && field.includes('@')) {
        email = field;
      } else if (!phone && PHONE_RE.test(field)) {
        phone = field;
      } else {
        nameParts.push(field);
      }
    }
    if (!phone) {
      invalid.push(line);
      continue;
    }
    rows.push({ phone, fullName: nameParts.join(' ') || null, email });
  }
  return { rows, invalid };
}
