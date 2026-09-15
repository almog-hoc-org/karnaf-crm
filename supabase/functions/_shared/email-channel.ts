// crm_config.email_channel — who sends the CRM's marketing email.
//
// The key has carried a `provider` field since migration 106, but nothing
// read it: broadcast-dispatch was hard-coded to Rav Messer, so flipping the
// setting to 'resend' changed nothing and the 311-recipient campaign still
// failed with "ravmesser not configured". This module is the single reader,
// plus the preflight both the scheduler and the dispatcher run so a campaign
// fails at the click — not at 19:30 with the recipients waiting.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { isRavmesserConfigured } from './ravmesser.ts';
import { emailDomain, isPublicMailDomain, isResendConfigured, listResendDomains } from './resend.ts';

export type EmailProvider = 'ravmesser' | 'resend';

export interface EmailChannelConfig {
  provider: EmailProvider;
  fromName: string;
  fromEmail: string;
  /** Where replies land. Resend sends FROM a verified domain, but the owner
   *  still reads answers in the mailbox they always used. */
  replyTo: string;
  requireConsent: boolean;
}

export const DEFAULT_EMAIL_CHANNEL: EmailChannelConfig = {
  provider: 'ravmesser',
  fromName: 'קרנף נדל"ן',
  fromEmail: '',
  replyTo: '',
  requireConsent: true,
};

export function resolveEmailChannel(raw: unknown): EmailChannelConfig {
  const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const str = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim() ? v.trim() : fallback);
  const provider = obj.provider === 'resend' ? 'resend' : 'ravmesser';
  return {
    provider,
    fromName: str(obj.fromName, DEFAULT_EMAIL_CHANNEL.fromName),
    fromEmail: str(obj.fromEmail, ''),
    replyTo: str(obj.replyTo, ''),
    requireConsent: obj.requireConsent !== false,
  };
}

export async function loadEmailChannel(supabase: SupabaseClient): Promise<EmailChannelConfig> {
  const { data } = await supabase
    .from('crm_config').select('config_value').eq('config_key', 'email_channel').maybeSingle();
  return resolveEmailChannel(data?.config_value);
}

/** RFC 5322 "Display Name <addr>" for the provider's `from` field. */
export function formatFromAddress(cfg: EmailChannelConfig): string {
  if (!cfg.fromEmail) return '';
  if (!cfg.fromName) return cfg.fromEmail;
  // A quoted display name survives commas and Hebrew alike.
  return `${cfg.fromName.replace(/"/g, '')} <${cfg.fromEmail}>`;
}

export interface PreflightResult {
  ok: boolean;
  code?: 'ravmesser_not_configured' | 'resend_not_configured' | 'email_from_missing'
    | 'resend_domain_not_verified' | 'resend_domains_unreachable';
  error?: string;
}

const RESEND_DOMAINS_URL = 'https://resend.com/domains';

export interface PreflightOptions {
  /** Skip the Resend domains lookup. The dispatcher passes this on the
   *  ticks AFTER a campaign started: the domain was verified when it was
   *  scheduled, and a hiccup on that endpoint must not fail a send that is
   *  already half-way through. */
  skipDomainCheck?: boolean;
}

/**
 * Everything that must be true before an email campaign may be scheduled.
 * Network call (Resend domains) only on the resend path.
 */
export async function preflightEmailChannel(
  cfg: EmailChannelConfig,
  opts: PreflightOptions = {},
): Promise<PreflightResult> {
  if (cfg.provider === 'ravmesser') {
    if (!isRavmesserConfigured()) {
      return {
        ok: false,
        code: 'ravmesser_not_configured',
        error: 'רב מסר לא מוגדר — חסרים RAVMESSER_C_KEY / RAVMESSER_C_SECRET / RAVMESSER_U_KEY / RAVMESSER_U_SECRET ב-Supabase Edge Function secrets. ראו docs/runbooks/ravmesser-integration.md',
      };
    }
    if (!cfg.fromEmail) {
      return { ok: false, code: 'email_from_missing', error: 'חסרה כתובת שולח בהגדרות ערוץ המייל' };
    }
    return { ok: true };
  }

  if (!isResendConfigured()) {
    return {
      ok: false,
      code: 'resend_not_configured',
      error: 'Resend לא מוגדר — חסר RESEND_API_KEY ב-Supabase Edge Function secrets',
    };
  }
  if (!cfg.fromEmail) {
    return {
      ok: false,
      code: 'email_from_missing',
      error: 'חסרה כתובת שולח בהגדרות ערוץ המייל (הגדרות → ערוץ מייל)',
    };
  }
  const domain = emailDomain(cfg.fromEmail);
  if (!domain) {
    return { ok: false, code: 'email_from_missing', error: `כתובת השולח "${cfg.fromEmail}" אינה כתובת מייל תקינה` };
  }
  if (isPublicMailDomain(domain)) {
    return {
      ok: false,
      code: 'resend_domain_not_verified',
      error: `Resend לא שולח מכתובת ${domain} (תיבת דואר ציבורית). צריך דומיין משלכם שמאומת ב-${RESEND_DOMAINS_URL}, ואז לעדכן את כתובת השולח בהגדרות → ערוץ מייל`,
    };
  }
  if (opts.skipDomainCheck) return { ok: true };
  const domains = await listResendDomains();
  if (!domains.ok) {
    return {
      ok: false,
      code: 'resend_domains_unreachable',
      error: `לא הצלחנו לאמת את הדומיין מול Resend (${domains.error ?? 'unknown'}) — נסו שוב בעוד רגע`,
    };
  }
  const match = domains.domains.find((d) => d.name === domain);
  if (!match) {
    return {
      ok: false,
      code: 'resend_domain_not_verified',
      error: `הדומיין ${domain} לא רשום ב-Resend. הוסיפו אותו ב-${RESEND_DOMAINS_URL} והשלימו את רשומות ה-DNS`,
    };
  }
  if (match.status !== 'verified') {
    return {
      ok: false,
      code: 'resend_domain_not_verified',
      error: `הדומיין ${domain} רשום ב-Resend אך הסטטוס שלו הוא "${match.status}" ולא verified. השלימו את רשומות ה-DNS ב-${RESEND_DOMAINS_URL}`,
    };
  }
  return { ok: true };
}
