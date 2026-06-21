// Authorized links the bot may share. Info pages only — NEVER a payment/checkout
// link (those are sent by a human). Only real, known URLs are listed here so the
// bot never invents one. Add per-track pages here as they go live.
//
// Node-side mirror of supabase/functions/_shared/links.ts. Keep in sync.

export interface SiteLink {
  label: string;
  url: string;
}

const GENERAL: SiteLink[] = [
  { label: 'אתר קרנף נדל״ן', url: 'https://karnafnadlan.com' },
];

const BY_TRACK: Record<string, SiteLink[]> = {
  program: [],
  presale: [
    { label: 'דף פרויקט הפריסייל בפתח תקווה', url: 'https://karnaf-pt-sinai.vercel.app' },
  ],
  investor_mentorship: [],
};

export function linksForTrack(trackCode?: string | null): SiteLink[] {
  const t = (trackCode ?? '').trim();
  return [...GENERAL, ...(BY_TRACK[t] ?? [])];
}
