import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SCAN_ROOTS = ['apps/web/src', 'supabase/functions', 'docs'];
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.md']);
const replacement = String.fromCharCode(0xfffd);
const BAD_TEXT_MARKERS = [
  replacement, // Unicode replacement character: usually mojibake / bad decoding.
  replacement.repeat(3),
  `?${'T'}?`,
  `?${'c'}?`,
  `?${'x'}?`,
  `?${'~'}?`,
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...walk(path));
    else if (SCAN_EXTENSIONS.has(path.slice(path.lastIndexOf('.')))) out.push(path);
  }
  return out;
}

describe('Hebrew text encoding guard', () => {
  it('keeps user-facing source/docs free of mojibake markers', () => {
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of walk(root)) {
        const content = readFileSync(file, 'utf8');
        for (const marker of BAD_TEXT_MARKERS) {
          if (content.includes(marker)) offenders.push(`${file}: contains ${JSON.stringify(marker)}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
