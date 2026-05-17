import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HeatBadge, OwnershipBadge, StatusBadge } from './Badge';

describe('HeatBadge', () => {
  it('renders the Hebrew label for each heat tier', () => {
    const { rerender } = render(<HeatBadge heat="hot" />);
    expect(screen.getByText('חם')).toBeInTheDocument();

    rerender(<HeatBadge heat="warm" />);
    expect(screen.getByText('פושר')).toBeInTheDocument();

    rerender(<HeatBadge heat="cool" />);
    expect(screen.getByText('צונן')).toBeInTheDocument();

    rerender(<HeatBadge heat="cold" />);
    expect(screen.getByText('קר')).toBeInTheDocument();
  });

  it('applies the matching tone class for each tier', () => {
    const { container, rerender } = render(<HeatBadge heat="hot" />);
    expect(container.firstChild).toHaveClass('kf-badge', 'kf-badge-hot');

    rerender(<HeatBadge heat="cold" />);
    expect(container.firstChild).toHaveClass('kf-badge', 'kf-badge-cold');
  });

  it('falls back to a muted dash when heat is missing', () => {
    const { container } = render(<HeatBadge heat={null} />);
    expect(container.firstChild).toHaveClass('kf-badge', 'kf-badge-mute');
    expect(container.textContent).toBe('—');
  });
});

describe('StatusBadge', () => {
  it('uses the success tone for won', () => {
    const { container } = render(<StatusBadge status="won" />);
    expect(container.firstChild).toHaveClass('kf-badge-success');
    expect(screen.getByText('נסגר ברכישה')).toBeInTheDocument();
  });

  it('uses the warm tone for human handoff and payment_pending', () => {
    const { container, rerender } = render(<StatusBadge status="human_handoff" />);
    expect(container.firstChild).toHaveClass('kf-badge-warm');

    rerender(<StatusBadge status="payment_pending" />);
    expect(container.firstChild).toHaveClass('kf-badge-warm');
  });

  it('uses the muted tone for terminal opt-out states', () => {
    const { container, rerender } = render(<StatusBadge status="lost" />);
    expect(container.firstChild).toHaveClass('kf-badge-mute');

    rerender(<StatusBadge status="do_not_contact" />);
    expect(container.firstChild).toHaveClass('kf-badge-mute');

    rerender(<StatusBadge status="removed_by_request" />);
    expect(container.firstChild).toHaveClass('kf-badge-mute');
  });

  it('defaults to the cool tone for in-flight statuses', () => {
    const { container } = render(<StatusBadge status="qualified" />);
    expect(container.firstChild).toHaveClass('kf-badge-cool');
    expect(screen.getByText('הוסמך')).toBeInTheDocument();
  });

  it('falls back to a muted dash when status is null', () => {
    const { container } = render(<StatusBadge status={null} />);
    expect(container.firstChild).toHaveClass('kf-badge-mute');
    expect(container.textContent).toBe('—');
  });
});

describe('OwnershipBadge', () => {
  it('uses dedicated ownership tones for Mia and phone-sales', () => {
    const { container, rerender } = render(<OwnershipBadge ownership="mia_active" />);
    expect(container.firstChild).toHaveClass('kf-badge-mia');
    expect(screen.getByText('מיה')).toBeInTheDocument();

    rerender(<OwnershipBadge ownership="phone_sales_pending" />);
    expect(container.firstChild).toHaveClass('kf-badge-phone');
  });

  it('uses the AI tone for ai_active and the muted tone for suppressed', () => {
    const { container, rerender } = render(<OwnershipBadge ownership="ai_active" />);
    expect(container.firstChild).toHaveClass('kf-badge-ai');

    rerender(<OwnershipBadge ownership="suppressed" />);
    expect(container.firstChild).toHaveClass('kf-badge-mute');
  });

  it('falls back to a muted dash when ownership is missing', () => {
    const { container } = render(<OwnershipBadge ownership={undefined} />);
    expect(container.firstChild).toHaveClass('kf-badge-mute');
    expect(container.textContent).toBe('—');
  });
});
