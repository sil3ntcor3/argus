import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/utils';
import { WorkflowFileSheet } from '@/components/common/workflow-file-sheet';

describe('WorkflowFileSheet', () => {
  it('opens the definition, explains empty content and reports close state', async () => {
    const onOpenChange = vi.fn();
    const { user } = renderWithProviders(
      <WorkflowFileSheet
        yaml=""
        description="Current group workflow."
        emptyMessage="No definition yet."
        onOpenChange={onOpenChange}
      />,
    );
    await user.click(
      await screen.findByRole('button', { name: 'View workflow' }),
    );
    expect(
      await screen.findByRole('dialog', { name: 'Workflow definition' }),
    ).toBeVisible();
    expect(screen.getByText('Current group workflow.')).toBeVisible();
    expect(screen.getByText('No definition yet.')).toBeVisible();
    expect(onOpenChange).toHaveBeenCalledWith(true);
    await user.click(
      screen.getByRole('button', { name: 'Close', exact: true }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });
});
