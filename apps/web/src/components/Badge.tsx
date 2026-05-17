import clsx from 'clsx';
import { HEAT_LABELS, OWNERSHIP_LABELS, STATUS_LABELS } from '@/lib/format';
import type { LeadHeat, LeadStatus, OwnershipMode } from '@/lib/types';

export function HeatBadge({ heat }: { heat: LeadHeat | null | undefined }) {
  if (!heat) return <span className="kf-badge kf-badge-mute">—</span>;
  return (
    <span
      className={clsx(
        'kf-badge',
        heat === 'hot' && 'kf-badge-hot',
        heat === 'warm' && 'kf-badge-warm',
        heat === 'cool' && 'kf-badge-cool',
        heat === 'cold' && 'kf-badge-cold',
      )}
    >
      {HEAT_LABELS[heat] ?? heat}
    </span>
  );
}

export function StatusBadge({ status }: { status: LeadStatus | null | undefined }) {
  if (!status) return <span className="kf-badge kf-badge-mute">—</span>;
  const tone =
    status === 'won' ? 'kf-badge-success' :
    status === 'lost' || status === 'do_not_contact' || status === 'removed_by_request' ? 'kf-badge-mute' :
    status === 'human_handoff' || status === 'manual_review_required' ? 'kf-badge-warm' :
    status === 'payment_pending' ? 'kf-badge-warm' :
    'kf-badge-cool';
  return <span className={clsx('kf-badge', tone)}>{STATUS_LABELS[status] ?? status}</span>;
}

export function OwnershipBadge({ ownership }: { ownership: OwnershipMode | null | undefined }) {
  if (!ownership) return <span className="kf-badge kf-badge-mute">—</span>;
  const tone =
    ownership === 'ai_active' ? 'kf-badge-ai' :
    ownership === 'mia_active' ? 'kf-badge-mia' :
    ownership === 'phone_sales_pending' ? 'kf-badge-phone' :
    ownership === 'shared_watch' ? 'kf-badge-watch' :
    ownership === 'suppressed' ? 'kf-badge-mute' :
    'kf-badge-watch';
  return <span className={clsx('kf-badge', tone)}>{OWNERSHIP_LABELS[ownership] ?? ownership}</span>;
}
