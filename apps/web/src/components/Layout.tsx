import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import clsx from 'clsx';
import { isAdminRole, isManagerRole, roleLabel, useAuth } from '@/auth/auth-context';
import { t, type TranslationKey } from '@/lib/i18n';
import { RoleHelp } from '@/components/RoleHelp';
import { useAttentionCount, useAttentionTitle } from '@/lib/useAttentionCount';
import { usePresence } from '@/lib/usePresence';

interface NavItem {
  to: string;
  labelKey: TranslationKey;
  end?: boolean;
  adminOnly?: boolean;
  managerOnly?: boolean;
  icon: ReactNode;
}

// Four items, built for a business run by one owner (2026-09 audit):
//   * היום     — what needs me right now (attention inbox). Everyone's home.
//   * לקוחות   — find, filter, segment, import/export.
//   * דיוור    — campaigns and message templates. Manager+.
//   * עוד      — reports, automations, settings, team, system status,
//                grouped in the hub. Manager+ (admin-only cards are
//                filtered inside it).
// The business-status dashboard moved from "/" to /dashboard and is
// reached from the hub and from the היום header.
const NAV: NavItem[] = [
  { to: '/inbox', labelKey: 'nav_inbox', icon: <IconInbox /> },
  { to: '/leads', labelKey: 'nav_leads', icon: <IconUsers /> },
  { to: '/broadcasts', labelKey: 'nav_broadcasts', managerOnly: true, icon: <IconSend /> },
  { to: '/admin', labelKey: 'nav_more', managerOnly: true, icon: <IconGrid /> },
];

export function Layout() {
  const auth = useAuth();
  const isAdmin = isAdminRole(auth.role);
  const isManager = isManagerRole(auth.role);
  const visible = NAV.filter((item) => (!item.adminOnly || isAdmin) && (!item.managerOnly || isManager));
  const [mobileOpen, setMobileOpen] = useState(false);
  const drawer = usePresence(mobileOpen);
  const location = useLocation();
  // Live "someone is waiting" counter — red badge on the inbox link and
  // a "(n)" title prefix so an open-but-backgrounded tab still signals.
  const attentionCount = useAttentionCount();
  useAttentionTitle(attentionCount);

  useEffect(() => { setMobileOpen(false); }, [location.pathname]);

  const initials = getInitials(auth.user?.email);

  return (
    <div className="min-h-screen">
      <a
        href="#kf-main"
        className="sr-only focus:not-sr-only focus:absolute focus:start-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-brand-700 focus:px-3 focus:py-2 focus:text-sm focus:text-white"
      >
        {t('skip_to_main')}
      </a>
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/85 backdrop-blur supports-[backdrop-filter]:bg-white/70">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 sm:gap-6">
          <Link to="/inbox" className="group flex items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-600 text-white shadow-sm transition group-hover:bg-brand-700" aria-hidden="true">
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 7l8 5 8-5M4 7v10l8 5 8-5V7M4 7l8-5 8 5" />
              </svg>
            </span>
            <span className="text-base font-semibold text-slate-900 sm:text-lg">קרנף <span className="text-brand-700">CRM</span></span>
          </Link>

          <nav className="hidden items-center gap-1 md:flex" role="navigation" aria-label={t('app_name')}>
            {visible.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  clsx(
                    'kf-pressable flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition',
                    isActive
                      ? 'bg-brand-50 text-brand-700'
                      : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <span aria-hidden="true" className="text-current opacity-80">{item.icon}</span>
                    <span aria-current={isActive ? 'page' : undefined}>{t(item.labelKey)}</span>
                    {item.to === '/inbox' && attentionCount > 0 ? (
                      <span key={attentionCount} className="kf-badge-pop ms-0.5 grid min-w-5 place-items-center rounded-full bg-rose-600 px-1 text-[11px] font-bold leading-5 text-white" aria-label={`${attentionCount} ממתינים למענה`}>
                        {attentionCount > 99 ? '99+' : attentionCount}
                      </span>
                    ) : null}
                  </>
                )}
              </NavLink>
            ))}
          </nav>

          <div className="ms-auto flex items-center gap-2 sm:gap-3">
            <div className="hidden items-center gap-3 sm:flex">
              <div className="text-end">
                <div className="text-sm font-medium text-slate-700 leading-tight">{auth.user?.email}</div>
                <div className="flex items-center justify-end gap-1.5 text-xs text-slate-500 leading-tight">
                  <span>{roleLabel(auth.role)}</span>
                  {auth.role ? <RoleHelp role={auth.role} /> : null}
                </div>
              </div>
              <span
                aria-hidden="true"
                title={auth.user?.email ?? ''}
                className="grid h-9 w-9 place-items-center rounded-full bg-brand-100 text-sm font-semibold text-brand-700 ring-1 ring-brand-500/20"
              >{initials}</span>
            </div>
            <button type="button" onClick={() => auth.signOut()} className="kf-btn kf-btn-ghost hidden sm:inline-flex">
              {t('sign_out')}
            </button>
            <button
              type="button"
              aria-label={mobileOpen ? 'סגירת תפריט' : 'פתיחת תפריט'}
              aria-expanded={mobileOpen}
              aria-controls="kf-mobile-nav"
              className="kf-btn kf-btn-ghost md:hidden"
              onClick={() => setMobileOpen((v) => !v)}
            >
              <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
                {mobileOpen ? (
                  <path strokeLinecap="round" d="M5 5l10 10M15 5L5 15" />
                ) : (
                  <path strokeLinecap="round" d="M3 6h14M3 10h14M3 14h14" />
                )}
              </svg>
            </button>
          </div>
        </div>

        {drawer.mounted ? (
          <div
            id="kf-mobile-nav"
            data-state={drawer.state}
            className="kf-layer kf-layer-drawer border-t border-slate-200 bg-white md:hidden"
          >
            <nav
              className="mx-auto flex max-w-7xl flex-col gap-1 px-2 py-2"
              role="navigation"
              aria-label={t('app_name')}
            >
              {visible.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    clsx(
                      'kf-pressable flex items-center gap-2 rounded-md px-3 py-3 text-sm font-medium transition',
                      isActive ? 'bg-brand-50 text-brand-700' : 'text-slate-700 hover:bg-slate-100',
                    )
                  }
                >
                  {({ isActive }) => (
                    <>
                      <span aria-hidden="true">{item.icon}</span>
                      <span aria-current={isActive ? 'page' : undefined}>{t(item.labelKey)}</span>
                      {item.to === '/inbox' && attentionCount > 0 ? (
                        <span key={attentionCount} className="kf-badge-pop ms-auto grid min-w-5 place-items-center rounded-full bg-rose-600 px-1 text-[11px] font-bold leading-5 text-white" aria-label={`${attentionCount} ממתינים למענה`}>
                          {attentionCount > 99 ? '99+' : attentionCount}
                        </span>
                      ) : null}
                    </>
                  )}
                </NavLink>
              ))}
              <div className="mt-2 flex items-center justify-between gap-3 border-t border-slate-100 px-3 pt-2">
                <div className="min-w-0 text-sm">
                  <div className="truncate text-slate-700">{auth.user?.email}</div>
                  <div className="text-xs text-slate-500">{roleLabel(auth.role)}</div>
                </div>
                <button type="button" className="kf-btn shrink-0" onClick={() => auth.signOut()}>{t('sign_out')}</button>
              </div>
            </nav>
          </div>
        ) : null}
      </header>
      {drawer.mounted ? (
        <button
          type="button"
          aria-label="סגירת תפריט"
          data-state={drawer.state}
          className="kf-layer kf-layer-fade fixed inset-0 z-[25] bg-slate-900/20 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      ) : null}

      <main id="kf-main" tabIndex={-1} className="mx-auto max-w-7xl p-4 sm:p-6">
        <Outlet />
      </main>
    </div>
  );
}

function getInitials(email?: string | null): string {
  if (!email) return '?';
  const local = email.split('@')[0] ?? '';
  const cleaned = local.replace(/[^A-Za-z֐-׿]+/g, ' ').trim();
  if (!cleaned) return email.slice(0, 1).toUpperCase();
  const parts = cleaned.split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]).join('').toUpperCase();
}

function IconUsers() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.7">
      <circle cx="7" cy="8" r="3" /><path d="M2 17c.7-2.7 3-4.3 5-4.3S11.3 14.3 12 17" />
      <circle cx="14" cy="7" r="2.3" /><path d="M13 13c1.6 0 4.6.7 5 4" />
    </svg>
  );
}
function IconInbox() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M3 12l2.4-7H14.6L17 12v3.5A1.5 1.5 0 0 1 15.5 17h-11A1.5 1.5 0 0 1 3 15.5V12Z" />
      <path d="M3 12h4l1.4 2h3.2L13 12h4" />
    </svg>
  );
}
function IconSend() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path strokeLinejoin="round" d="M17.5 2.5 2.5 8.6l6 2.3 2.3 6 6.7-14.4Z" />
      <path strokeLinecap="round" d="m8.5 10.9 3.6-3.6" />
    </svg>
  );
}
function IconGrid() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.7">
      <rect x="3" y="3" width="5.5" height="5.5" rx="1.3" /><rect x="11.5" y="3" width="5.5" height="5.5" rx="1.3" />
      <rect x="3" y="11.5" width="5.5" height="5.5" rx="1.3" /><rect x="11.5" y="11.5" width="5.5" height="5.5" rx="1.3" />
    </svg>
  );
}
