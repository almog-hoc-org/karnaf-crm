import { describe, expect, it } from 'vitest';
import { SOURCE_OPTIONS } from './BroadcastsPage';
import { SOURCE_LABELS } from '@/lib/format';

// The broadcast source picker must carry EVERY slug behind a Hebrew label
// (comma-joined, matched with IN by broadcast-segment). A one-slug-per-label
// picker silently under-targeted broadcasts: "אתר" reached only
// services_page, dropping website + landing_page registrants.
describe('BroadcastsPage SOURCE_OPTIONS', () => {
  it('has exactly one option per Hebrew label', () => {
    const labels = SOURCE_OPTIONS.map((o) => o.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(new Set(labels)).toEqual(new Set(Object.values(SOURCE_LABELS)));
  });

  it('covers every slug of a multi-slug label', () => {
    const website = SOURCE_OPTIONS.find((o) => o.label === SOURCE_LABELS.website);
    expect(website).toBeDefined();
    const slugs = website!.value.split(',');
    expect(slugs).toEqual(expect.arrayContaining(['website', 'landing_page', 'services_page']));
  });

  it('every slug in SOURCE_LABELS appears in exactly one option', () => {
    const seen = new Map<string, number>();
    for (const o of SOURCE_OPTIONS) {
      for (const slug of o.value.split(',')) {
        seen.set(slug, (seen.get(slug) ?? 0) + 1);
      }
    }
    for (const slug of Object.keys(SOURCE_LABELS)) {
      expect(seen.get(slug)).toBe(1);
    }
  });
});
