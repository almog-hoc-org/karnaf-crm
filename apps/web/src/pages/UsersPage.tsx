import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchUsersList, postCreateUser, postUpdateUser, type ProfileRow,
} from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useAuth } from '@/auth/auth-context';
import { Navigate } from 'react-router-dom';
import { useToast } from '@/components/Toast';
import { useDocumentTitle } from '@/lib/useDocumentTitle';

const ROLES: Array<ProfileRow['role']> = ['owner', 'admin', 'mia', 'sales_rep', 'viewer'];

const ROLE_LABELS: Record<ProfileRow['role'], string> = {
  owner: 'בעלים',
  admin: 'מנהל',
  mia: 'מיה',
  sales_rep: 'איש מכירות',
  viewer: 'צופה',
};

export function UsersPage() {
  const auth = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  useDocumentTitle('ניהול משתמשים');
  const list = useQuery({ queryKey: ['users'], queryFn: fetchUsersList });

  const create = useMutation({
    mutationFn: postCreateUser,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      toast.success('משתמש נוצר');
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const update = useMutation({
    mutationFn: postUpdateUser,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      toast.success('משתמש עודכן');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  if (auth.role !== 'owner' && auth.role !== 'admin') {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="space-y-4">
      <header><h1 className="text-2xl font-semibold tracking-tight">ניהול משתמשים</h1></header>

      <CreateUserForm
        onSubmit={(payload) => create.mutate(payload)}
        submitting={create.isPending}
        errorMessage={create.error ? (create.error as Error).message : null}
      />

      <div className="kf-card overflow-hidden">
        <div className="-mx-px overflow-x-auto">
        <table className="kf-table min-w-[40rem]">
          <thead>
            <tr>
              <th>אימייל</th>
              <th>שם</th>
              <th>תפקיד</th>
              <th>פעיל</th>
              <th>נוצר</th>
              <th>פעולות</th>
            </tr>
          </thead>
          <tbody>
            {list.isLoading ? (
              <tr><td colSpan={6} className="p-6 text-center text-slate-500">טוען...</td></tr>
            ) : list.data && list.data.length > 0 ? (
              list.data.map((u) => (
                <tr key={u.id}>
                  <td>{u.email}</td>
                  <td>{u.full_name || '—'}</td>
                  <td>
                    <select
                      className="kf-input"
                      value={u.role}
                      disabled={update.isPending || u.id === auth.user?.id}
                      onChange={(e) => update.mutate({ userId: u.id, role: e.target.value as ProfileRow['role'] })}
                    >
                      {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                    </select>
                  </td>
                  <td>
                    <label className="inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                        checked={u.is_active}
                        disabled={update.isPending || u.id === auth.user?.id}
                        onChange={(e) => update.mutate({ userId: u.id, isActive: e.target.checked })}
                      />
                      <span className={`text-xs ${u.is_active ? 'text-emerald-700' : 'text-slate-400'}`}>
                        {u.is_active ? 'פעיל' : 'מושבת'}
                      </span>
                    </label>
                  </td>
                  <td className="text-slate-500">{formatDateTime(u.created_at)}</td>
                  <td>
                    {u.id === auth.user?.id ? <span className="text-xs text-slate-500">(אתה)</span> : null}
                  </td>
                </tr>
              ))
            ) : (
              <tr><td colSpan={6} className="p-6 text-center text-slate-500">אין משתמשים.</td></tr>
            )}
          </tbody>
        </table>
        </div>
      </div>
      {update.error ? <p className="text-sm text-rose-600">{(update.error as Error).message}</p> : null}
    </div>
  );
}

function CreateUserForm({
  onSubmit, submitting, errorMessage,
}: {
  onSubmit: (payload: { email: string; password: string; role: ProfileRow['role']; fullName: string | null }) => void;
  submitting: boolean;
  errorMessage: string | null;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState<ProfileRow['role']>('mia');

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    onSubmit({ email, password, role, fullName: fullName.trim() || null });
    setEmail(''); setPassword(''); setFullName('');
  }

  return (
    <form onSubmit={submit} className="kf-card grid grid-cols-1 items-end gap-3 p-4 sm:grid-cols-2 md:grid-cols-5">
      <label className="block text-sm sm:col-span-2 md:col-span-2">
        <span className="text-slate-700">אימייל</span>
        <input type="email" required className="kf-input mt-1" value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label className="block text-sm">
        <span className="text-slate-700">סיסמה (12+)</span>
        <input type="password" required minLength={12} className="kf-input mt-1" value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      <label className="block text-sm">
        <span className="text-slate-700">שם מלא</span>
        <input className="kf-input mt-1" value={fullName} onChange={(e) => setFullName(e.target.value)} />
      </label>
      <label className="block text-sm">
        <span className="text-slate-700">תפקיד</span>
        <select className="kf-input mt-1" value={role} onChange={(e) => setRole(e.target.value as ProfileRow['role'])}>
          {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
        </select>
      </label>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2 md:col-span-5">
        <button type="submit" className="kf-btn kf-btn-primary w-full sm:w-auto" disabled={submitting}>
          {submitting ? 'מוסיף...' : 'הוספת משתמש'}
        </button>
        {errorMessage ? <span className="text-sm text-rose-600">{errorMessage}</span> : null}
      </div>
    </form>
  );
}
