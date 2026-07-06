import { describe, expect, it } from 'vitest';
import { parseImportRows } from './importParse';

describe('parseImportRows', () => {
  it('parses phone, name and email regardless of column order', () => {
    const { rows, invalid } = parseImportRows(
      '050-1234567, ישראל ישראלי, israel@example.com\nisrael2@example.com\t0527654321\tדנה כהן',
    );
    expect(invalid).toHaveLength(0);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ phone: '050-1234567', fullName: 'ישראל ישראלי', email: 'israel@example.com' });
    expect(rows[1]).toEqual({ phone: '0527654321', fullName: 'דנה כהן', email: 'israel2@example.com' });
  });

  it('skips blank lines and reports lines without a phone', () => {
    const { rows, invalid } = parseImportRows('\n\nרק שם בלי טלפון\n0501112222, משה\n');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.phone).toBe('0501112222');
    expect(invalid).toEqual(['רק שם בלי טלפון']);
  });

  it('handles phone-only lines', () => {
    const { rows } = parseImportRows('0501234567');
    expect(rows).toEqual([{ phone: '0501234567', fullName: null, email: null }]);
  });
});
