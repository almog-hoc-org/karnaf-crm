import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ActivityFeed } from './ActivityFeed';
import type { ActivityRow } from '@/lib/types';

function makeActivity(overrides: Partial<ActivityRow>): ActivityRow {
  return {
    id: Math.random().toString(36).slice(2),
    contact_id: 'lead-1',
    occurred_at: '2026-07-01T10:00:00Z',
    activity_type: 'event',
    actor_type: 'system',
    conversation_id: null,
    deal_id: null,
    meeting_id: null,
    actor_user_id: null,
    title: null,
    body: null,
    status: null,
    priority_level: null,
    due_at: null,
    completed_at: null,
    direction: null,
    source_table: 'lead_events',
    source_id: 'x',
    payload: {},
    created_at: '2026-07-01T10:00:00Z',
    ...overrides,
  } as ActivityRow;
}

describe('ActivityFeed', () => {
  it('labels known slugs in Hebrew and excludes messages', () => {
    render(
      <ActivityFeed
        activities={[
          makeActivity({ title: 'member_expert_requested' }),
          makeActivity({ activity_type: 'message', body: 'הודעת צאט', direction: 'inbound', actor_type: 'lead' }),
        ]}
      />,
    );
    expect(screen.getByText('חבר תוכנית ביקש מומחה')).toBeInTheDocument();
    expect(screen.queryByText('הודעת צאט')).not.toBeInTheDocument();
  });

  it('wraps unknown slugs instead of showing bare English', () => {
    render(<ActivityFeed activities={[makeActivity({ title: 'some_future_slug' })]} />);
    expect(screen.getByText('אירוע מערכת · some_future_slug')).toBeInTheDocument();
  });

  it('collapses consecutive identical events with an ×N badge', () => {
    render(
      <ActivityFeed
        activities={[
          makeActivity({ title: 'sla_breach', occurred_at: '2026-07-01T10:00:00Z' }),
          makeActivity({ title: 'sla_breach', occurred_at: '2026-07-01T10:01:00Z' }),
          makeActivity({ title: 'sla_breach', occurred_at: '2026-07-01T10:02:00Z' }),
        ]}
      />,
    );
    expect(screen.getAllByText('חריגת זמן מענה')).toHaveLength(1);
    expect(screen.getByText('×3')).toBeInTheDocument();
  });

  it('hides delivery-status spam entirely', () => {
    render(<ActivityFeed activities={[makeActivity({ title: 'provider_message_status_updated' })]} />);
    expect(screen.getByText('עוד אין פעילות מערכת')).toBeInTheDocument();
  });
});
