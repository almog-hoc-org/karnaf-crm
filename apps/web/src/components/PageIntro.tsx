import { type ReactNode } from 'react';

// Tier 7.C.3 — reusable opening copy disclosure.
//
// Admin-facing pages (Partners / Projects / Commissions / Templates /
// Sources / Automations / Journeys / Reports) all had multi-sentence
// opening paragraphs above the data table or list. Pre-Tier 7 they
// pushed the table 60–120 pixels down on every page load — useful for
// a new admin on day one, noise for everyone else from day two on.
//
// PageIntro wraps that copy in a <details> collapsed by default. The
// summary line + ? icon make it visible that there's an intro, without
// imposing it. Doesn't depend on localStorage — admins who want it can
// click open every time.
export function PageIntro({ children }: { children: ReactNode }) {
  return (
    <details className="text-sm text-slate-500">
      <summary
        className="cursor-pointer rounded-md text-slate-500 hover:text-slate-700"
        aria-label="הסבר על המסך"
      >
        <span aria-hidden="true" className="me-1 inline-block rounded-full bg-slate-100 px-1.5 text-xs font-semibold text-slate-600">?</span>
        מה זה הדף הזה?
      </summary>
      <div className="mt-2 leading-6">{children}</div>
    </details>
  );
}
