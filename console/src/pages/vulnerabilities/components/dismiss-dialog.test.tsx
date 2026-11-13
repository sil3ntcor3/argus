import { fireEvent, render, screen, within } from '@testing-library/react';
import { addDays, format, startOfDay } from 'date-fns';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DismissAlertDialog } from './dismiss-dialog';

const mutate = vi.hoisted(() => vi.fn());
let maxDays = 180;
let policyReady = true;
vi.mock('@/services/apis/gen/queries', () => ({
  useVulnerabilitiesControllerGetSettings: () => ({ data: { riskAcceptMaxDays: maxDays }, isFetchedAfterMount: policyReady }),
  useVulnerabilitiesControllerBulkDismissVulnerabilities: () => ({
    mutate,
    isPending: false,
  }),
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));

const finding = 'finding-1';
const day = (offset: number) =>
  format(addDays(new Date(), offset), 'yyyy-MM-dd');

function open() {
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss alert' }));
  return within(screen.getByRole('dialog', { name: 'Dismiss alert' }));
}

describe('DismissAlertDialog timed risk acceptance', () => {
  let rerender: ReturnType<typeof render>['rerender'];

  beforeEach(() => {
    maxDays = 180; policyReady = true;
    mutate.mockReset();
    ({ rerender } = render(
      <DismissAlertDialog
        vulnerabilityIds={[finding]}
        trigger={<button>Dismiss alert</button>}
      />,
    ));
  });

  it('uses the workspace maximum and waits for fresh policy before accepting a risk', () => {
    maxDays = 365; policyReady = false;
    const dialog = open();
    fireEvent.click(dialog.getByRole('radio', { name: 'Risk accepted' }));
    fireEvent.change(dialog.getByLabelText('Accepted until'), { target: { value: day(364) } });
    expect(dialog.getByRole('button', { name: 'Dismiss' })).toBeDisabled();
    policyReady = true;
    fireEvent.change(dialog.getByLabelText('Accepted until'), { target: { value: day(363) } });
    expect(dialog.getByRole('button', { name: 'Dismiss' })).toBeEnabled();
  });

  it('requires a valid future date and submits the local date with a timezone', () => {
    const dialog = open();
    fireEvent.click(dialog.getByRole('radio', { name: 'Risk accepted' }));
    const expiry = dialog.getByLabelText('Accepted until');
    expect(expiry).toBeRequired();
    const submit = dialog.getByRole('button', { name: 'Dismiss' });
    expect(submit).toBeDisabled();
    fireEvent.change(expiry, { target: { value: day(0) } });
    expect(submit).toBeDisabled();
    expect(dialog.getByRole('alert')).toBeVisible();
    fireEvent.change(expiry, { target: { value: day(182) } });
    expect(submit).toBeDisabled();
    fireEvent.change(expiry, { target: { value: day(14) } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    expect(mutate).toHaveBeenCalledWith(
      {
        data: {
          ids: [finding],
          reason: 'risk_accepted',
          comment: '',
          expiresAt: startOfDay(addDays(new Date(), 14)).toISOString(),
        },
      },
      expect.anything(),
    );
  });

  it('resets a cancelled acceptance and omits expiry for ordinary dismissals', () => {
    let dialog = open();
    fireEvent.click(dialog.getByRole('radio', { name: 'Risk accepted' }));
    fireEvent.change(dialog.getByLabelText('Accepted until'), {
      target: { value: day(14) },
    });
    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
    dialog = open();
    expect(dialog.queryByLabelText('Accepted until')).not.toBeInTheDocument();
    fireEvent.click(dialog.getByRole('radio', { name: "Won't fix" }));
    fireEvent.click(dialog.getByRole('button', { name: 'Dismiss' }));
    expect(mutate).toHaveBeenCalledWith(
      {
        data: {
          ids: [finding],
          reason: 'wont_fix',
          comment: '',
        },
      },
      expect.anything(),
    );
  });

  it('submits the original findings when the selection changes while open', () => {
    const dialog = open();
    fireEvent.click(dialog.getByRole('radio', { name: 'Risk accepted' }));
    fireEvent.change(dialog.getByLabelText('Accepted until'), {
      target: { value: day(14) },
    });
    rerender(
      <DismissAlertDialog
        vulnerabilityIds={['finding-2']}
        trigger={<button>Dismiss alert</button>}
      />,
    );
    fireEvent.click(dialog.getByRole('button', { name: 'Dismiss' }));
    expect(mutate).toHaveBeenCalledWith(
      { data: expect.objectContaining({ ids: [finding] }) },
      expect.anything(),
    );
  });
});
