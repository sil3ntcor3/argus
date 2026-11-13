import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DetectionStatusBadge, SlaDue } from './lifecycle-badges';
import { isOpenFinding } from './lifecycle';

describe('Finding lifecycle display', () => {
  it('treats only undismissed unarchived detected findings as open', () => {
    expect(isOpenFinding({ detectionStatus: 'active' })).toBe(true);
    expect(isOpenFinding({ detectionStatus: 'fixed' })).toBe(false);
    expect(isOpenFinding({ detectionStatus: 'new', vulnerabilityDismissal: {} })).toBe(false);
    expect(isOpenFinding({ detectionStatus: 'resurfaced', isArchived: true })).toBe(false);
  });
  it('distinguishes scanner state from paused, fixed and unknown SLA deadlines', () => {
    render(<><DetectionStatusBadge status="resurfaced" /><SlaDue dueAt="2000-01-01T00:00:00Z" />
      <SlaDue dueAt="2000-01-01T00:00:00Z" paused /><SlaDue status="fixed" /><SlaDue dueAt="invalid" /></>);
    expect(screen.getByText('Resurfaced')).toBeInTheDocument();
    expect(screen.getByText(/days overdue/)).toBeInTheDocument();
    expect(screen.getByText('Paused')).toBeInTheDocument();
    expect(screen.getByText('No SLA')).toBeInTheDocument();
  });
});
