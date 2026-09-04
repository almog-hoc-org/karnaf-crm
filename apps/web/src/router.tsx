import { lazy, Suspense, type ReactNode } from 'react';
import { createBrowserRouter, Link, Navigate, RouterProvider, useParams } from 'react-router-dom';
import { AuthProvider } from '@/auth/AuthProvider';
import { ProtectedRoute } from '@/auth/ProtectedRoute';
import { useAuth, type Role } from '@/auth/auth-context';
import { LoginPage } from '@/auth/LoginPage';
import { Layout } from '@/components/Layout';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ToastProvider } from '@/components/Toast';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '@/lib/queryClient';
import { Spinner } from '@/components/Spinner';

const HomeRoute = lazy(() => import('@/pages/HomeRoute').then((m) => ({ default: m.HomeRoute })));
const LeadsPage = lazy(() => import('@/pages/LeadsPage').then((m) => ({ default: m.LeadsPage })));
const LeadDetailPage = lazy(() => import('@/pages/LeadDetailPage').then((m) => ({ default: m.LeadDetailPage })));
// Remounts LeadDetailPage whenever the route's :leadId changes. See the
// route entry below for why that matters.
function KeyedLeadDetailPage() {
  const { leadId } = useParams();
  return <LeadDetailPage key={leadId} />;
}

const QueuePage = lazy(() => import('@/pages/QueuePage').then((m) => ({ default: m.QueuePage })));
const InboxPage = lazy(() => import('@/pages/InboxPage').then((m) => ({ default: m.InboxPage })));
const AnalyticsPage = lazy(() => import('@/pages/AnalyticsPage').then((m) => ({ default: m.AnalyticsPage })));
const UsersPage = lazy(() => import('@/pages/UsersPage').then((m) => ({ default: m.UsersPage })));
const TeamPage = lazy(() => import('@/pages/TeamPage').then((m) => ({ default: m.TeamPage })));
const SourcesPage = lazy(() => import('@/pages/SourcesPage').then((m) => ({ default: m.SourcesPage })));
const LandingPagesPage = lazy(() => import('@/pages/LandingPagesPage').then((m) => ({ default: m.LandingPagesPage })));
const PartnersPage = lazy(() => import('@/pages/PartnersPage').then((m) => ({ default: m.PartnersPage })));
const ProjectsPage = lazy(() => import('@/pages/ProjectsPage').then((m) => ({ default: m.ProjectsPage })));
const CommissionsPage = lazy(() => import('@/pages/CommissionsPage').then((m) => ({ default: m.CommissionsPage })));
const TemplatesPage = lazy(() => import('@/pages/TemplatesPage').then((m) => ({ default: m.TemplatesPage })));
const AutomationsPage = lazy(() => import('@/pages/AutomationsPage').then((m) => ({ default: m.AutomationsPage })));
const ReportsPage = lazy(() => import('@/pages/ReportsPage').then((m) => ({ default: m.ReportsPage })));
const JourneysPage = lazy(() => import('@/pages/JourneysPage').then((m) => ({ default: m.JourneysPage })));
const BroadcastsPage = lazy(() => import('@/pages/BroadcastsPage').then((m) => ({ default: m.BroadcastsPage })));
const AdminHubPage = lazy(() => import('@/pages/AdminHubPage').then((m) => ({ default: m.AdminHubPage })));
const WhatsAppRouterOptionsPage = lazy(() => import('@/pages/WhatsAppRouterOptionsPage').then((m) => ({ default: m.WhatsAppRouterOptionsPage })));
const SettingsPage = lazy(() => import('@/pages/SettingsPage').then((m) => ({ default: m.SettingsPage })));
const OpsStatusPage = lazy(() => import('@/pages/OpsStatusPage').then((m) => ({ default: m.OpsStatusPage })));
const PromptVariantsPage = lazy(() => import('@/pages/PromptVariantsPage').then((m) => ({ default: m.PromptVariantsPage })));
const PermissionsHelpPage = lazy(() => import('@/pages/PermissionsHelpPage').then((m) => ({ default: m.PermissionsHelpPage })));

function PageFallback() {
  return (
    <div className="grid min-h-[40vh] place-items-center gap-2 text-slate-500">
      <Spinner className="h-6 w-6 text-brand-600" />
      <span className="text-sm">טוען...</span>
    </div>
  );
}

// Route-level role gate.
//
// The top nav hides manager- and admin-only links from a viewer, but the
// routes themselves were open: typing /broadcasts or /journeys loaded the
// whole screen, whose endpoints then answered 403 to every read and write.
// The operator got a page full of empty tables and failing buttons with no
// explanation. Say why instead — and link to the permissions page that
// already exists to explain it.
function RequireRole({ allow, children }: { allow: Role[]; children: ReactNode }) {
  const auth = useAuth();
  if (auth.loading) return <PageFallback />;
  if (!auth.role || !allow.includes(auth.role)) {
    return (
      <div className="kf-card mx-auto max-w-lg p-6 text-center" role="alert">
        <p className="text-3xl" aria-hidden="true">🔒</p>
        <h1 className="mt-2 text-lg font-semibold">אין לך הרשאה למסך הזה</h1>
        <p className="mt-1 text-sm text-slate-600">
          התפקיד שלך ({auth.role ?? 'לא ידוע'}) לא כולל גישה לעמוד הזה. פנה למנהל המערכת אם אתה צריך אותה.
        </p>
        <div className="mt-4 flex justify-center gap-2">
          <Link to="/inbox" className="kf-btn">חזרה להיום שלי</Link>
          <Link to="/help/permissions" className="kf-btn kf-btn-ghost">מה מותר לכל תפקיד</Link>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}

const MANAGER: Role[] = ['owner', 'admin', 'mia'];
const ADMIN: Role[] = ['owner', 'admin'];

// Wraps a lazy page in its Suspense boundary and, when given, its role gate.
function page(element: ReactNode, allow?: Role[]) {
  const inner = <Suspense fallback={<PageFallback />}>{element}</Suspense>;
  return allow ? <RequireRole allow={allow}>{inner}</RequireRole> : inner;
}

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    element: <ProtectedRoute />,
    children: [
      {
        element: <Layout />,
        children: [
          { path: '/', element: page(<HomeRoute />) },
          { path: '/leads', element: page(<LeadsPage />) },
          // `key` on the element is load-bearing. React Router reuses the same
          // component instance when only the :leadId param changes, so every
          // local piece of state survived the navigation — including the reply
          // draft and the conversationId it was about to be sent with. Typing a
          // reply to lead A, jumping to lead B and hitting Enter sent A's text
          // to B's conversation. Keying on the id forces a fresh mount.
          { path: '/leads/:leadId', element: page(<KeyedLeadDetailPage />) },
          { path: '/inbox', element: page(<InboxPage />) },
          { path: '/queue', element: page(<QueuePage />) },
          { path: '/analytics', element: page(<AnalyticsPage />, MANAGER) },
          { path: '/users', element: page(<UsersPage />, ADMIN) },
          { path: '/team', element: page(<TeamPage />, MANAGER) },
          { path: '/admin/sources', element: page(<SourcesPage />, ADMIN) },
          { path: '/admin/landing-pages', element: page(<LandingPagesPage />, ADMIN) },
          { path: '/partners', element: page(<PartnersPage />, MANAGER) },
          { path: '/projects', element: page(<ProjectsPage />, MANAGER) },
          { path: '/commissions', element: page(<CommissionsPage />, MANAGER) },
          { path: '/templates', element: page(<TemplatesPage />, MANAGER) },
          { path: '/automations', element: page(<AutomationsPage />, MANAGER) },
          { path: '/reports', element: page(<ReportsPage />, MANAGER) },
          { path: '/journeys', element: page(<JourneysPage />, MANAGER) },
          { path: '/broadcasts', element: page(<BroadcastsPage />, MANAGER) },
          { path: '/admin', element: page(<AdminHubPage />, ADMIN) },
          { path: '/admin/whatsapp-router', element: page(<WhatsAppRouterOptionsPage />, ADMIN) },
          { path: '/admin/settings', element: page(<SettingsPage />, ADMIN) },
          { path: '/admin/status', element: page(<OpsStatusPage />, ADMIN) },
          { path: '/prompts', element: page(<PromptVariantsPage />, ADMIN) },
          { path: '/help/permissions', element: page(<PermissionsHelpPage />) },
          { path: '*', element: <Navigate to="/" replace /> },
        ],
      },
    ],
  },
]);

export function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <AuthProvider>
            <RouterProvider router={router} />
          </AuthProvider>
        </ToastProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
