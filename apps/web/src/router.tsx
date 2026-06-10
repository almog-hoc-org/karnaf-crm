import { lazy, Suspense } from 'react';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom';
import { AuthProvider } from '@/auth/AuthProvider';
import { ProtectedRoute } from '@/auth/ProtectedRoute';
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
const QueuePage = lazy(() => import('@/pages/QueuePage').then((m) => ({ default: m.QueuePage })));
const InboxPage = lazy(() => import('@/pages/InboxPage').then((m) => ({ default: m.InboxPage })));
const AnalyticsPage = lazy(() => import('@/pages/AnalyticsPage').then((m) => ({ default: m.AnalyticsPage })));
const UsersPage = lazy(() => import('@/pages/UsersPage').then((m) => ({ default: m.UsersPage })));
const TeamPage = lazy(() => import('@/pages/TeamPage').then((m) => ({ default: m.TeamPage })));
const SourcesPage = lazy(() => import('@/pages/SourcesPage').then((m) => ({ default: m.SourcesPage })));
const PartnersPage = lazy(() => import('@/pages/PartnersPage').then((m) => ({ default: m.PartnersPage })));
const ProjectsPage = lazy(() => import('@/pages/ProjectsPage').then((m) => ({ default: m.ProjectsPage })));
const CommissionsPage = lazy(() => import('@/pages/CommissionsPage').then((m) => ({ default: m.CommissionsPage })));
const TemplatesPage = lazy(() => import('@/pages/TemplatesPage').then((m) => ({ default: m.TemplatesPage })));
const AutomationsPage = lazy(() => import('@/pages/AutomationsPage').then((m) => ({ default: m.AutomationsPage })));
const ReportsPage = lazy(() => import('@/pages/ReportsPage').then((m) => ({ default: m.ReportsPage })));
const JourneysPage = lazy(() => import('@/pages/JourneysPage').then((m) => ({ default: m.JourneysPage })));
const AdminHubPage = lazy(() => import('@/pages/AdminHubPage').then((m) => ({ default: m.AdminHubPage })));
const WhatsAppRouterOptionsPage = lazy(() => import('@/pages/WhatsAppRouterOptionsPage').then((m) => ({ default: m.WhatsAppRouterOptionsPage })));
const SettingsPage = lazy(() => import('@/pages/SettingsPage').then((m) => ({ default: m.SettingsPage })));
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

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    element: <ProtectedRoute />,
    children: [
      {
        element: <Layout />,
        children: [
          { path: '/', element: <Suspense fallback={<PageFallback />}><HomeRoute /></Suspense> },
          { path: '/leads', element: <Suspense fallback={<PageFallback />}><LeadsPage /></Suspense> },
          { path: '/leads/:leadId', element: <Suspense fallback={<PageFallback />}><LeadDetailPage /></Suspense> },
          { path: '/inbox', element: <Suspense fallback={<PageFallback />}><InboxPage /></Suspense> },
          { path: '/queue', element: <Suspense fallback={<PageFallback />}><QueuePage /></Suspense> },
          { path: '/analytics', element: <Suspense fallback={<PageFallback />}><AnalyticsPage /></Suspense> },
          { path: '/users', element: <Suspense fallback={<PageFallback />}><UsersPage /></Suspense> },
          { path: '/team', element: <Suspense fallback={<PageFallback />}><TeamPage /></Suspense> },
          { path: '/admin/sources', element: <Suspense fallback={<PageFallback />}><SourcesPage /></Suspense> },
          { path: '/partners', element: <Suspense fallback={<PageFallback />}><PartnersPage /></Suspense> },
          { path: '/projects', element: <Suspense fallback={<PageFallback />}><ProjectsPage /></Suspense> },
          { path: '/commissions', element: <Suspense fallback={<PageFallback />}><CommissionsPage /></Suspense> },
          { path: '/templates', element: <Suspense fallback={<PageFallback />}><TemplatesPage /></Suspense> },
          { path: '/automations', element: <Suspense fallback={<PageFallback />}><AutomationsPage /></Suspense> },
          { path: '/reports', element: <Suspense fallback={<PageFallback />}><ReportsPage /></Suspense> },
          { path: '/journeys', element: <Suspense fallback={<PageFallback />}><JourneysPage /></Suspense> },
          { path: '/admin', element: <Suspense fallback={<PageFallback />}><AdminHubPage /></Suspense> },
          { path: '/admin/whatsapp-router', element: <Suspense fallback={<PageFallback />}><WhatsAppRouterOptionsPage /></Suspense> },
          { path: '/admin/settings', element: <Suspense fallback={<PageFallback />}><SettingsPage /></Suspense> },
          { path: '/prompts', element: <Suspense fallback={<PageFallback />}><PromptVariantsPage /></Suspense> },
          { path: '/help/permissions', element: <Suspense fallback={<PageFallback />}><PermissionsHelpPage /></Suspense> },
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
