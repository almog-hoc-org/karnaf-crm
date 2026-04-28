// Pure summarisation helpers used by the runtime transcript-summary
// service. The Deno-side wrapper (`supabase/functions/_shared/transcript-summary.ts`)
// reads the messages from Postgres, hands them to these functions, and
// writes the result back. Keeping the pure logic here lets Vitest test
// the bucketing and condensing without spinning up a DB.

const SUMMARY_MAX_CHARS = 1200;

export interface SummariseRow {
  sender_type: string | null;
  direction: string | null;
  content_text: string | null;
  created_at: string | null;
}

export function firstSentence(s: string): string {
  const m = s.match(/.{1,180}?(?:[.!?\n]|$)/);
  return (m ? m[0] : s).trim();
}

export function condense(items: string[]): string {
  // Cheap keyword-extraction stand-in: keep the first sentence of every
  // fourth message plus the last two messages.
  const picks: string[] = [];
  for (let i = 0; i < items.length; i += 4) {
    const item = items[i];
    if (item) picks.push(firstSentence(item));
  }
  for (const tail of items.slice(-2)) picks.push(firstSentence(tail));
  return Array.from(new Set(picks)).join(' | ');
}

export function synthesise(rows: SummariseRow[], maxChars = SUMMARY_MAX_CHARS): string {
  const buckets: Record<'lead' | 'ai' | 'human' | 'system', string[]> = {
    lead: [], ai: [], human: [], system: [],
  };
  for (const r of rows) {
    const text = (r.content_text || '').trim();
    if (!text) continue;
    if (r.sender_type === 'lead') buckets.lead.push(text);
    else if (r.sender_type === 'ai') buckets.ai.push(text);
    else if (r.sender_type === 'mia' || r.sender_type === 'sales_rep' || r.sender_type === 'admin') buckets.human.push(text);
    else buckets.system.push(text);
  }

  const sections: string[] = [];
  if (buckets.lead.length) sections.push('LEAD: ' + condense(buckets.lead));
  if (buckets.ai.length) sections.push('AI: ' + condense(buckets.ai));
  if (buckets.human.length) sections.push('HUMAN: ' + condense(buckets.human));
  return sections.join('\n').slice(0, maxChars);
}
