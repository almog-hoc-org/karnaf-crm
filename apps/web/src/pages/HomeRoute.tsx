import { Navigate } from 'react-router-dom';
import { useAuth } from '@/auth/auth-context';
import { DashboardPage } from '@/pages/DashboardPage';

export function HomeRoute() {
  const auth = useAuth();
  const isManager = auth.role === 'owner' || auth.role === 'admin' || auth.role === 'mia';

  if (!isManager) return <Navigate to="/inbox" replace />;
  return <DashboardPage />;
}
