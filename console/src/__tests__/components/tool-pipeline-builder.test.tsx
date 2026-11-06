import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/utils';
import { within } from '@testing-library/react';
import type { Tool } from '@/services/apis/gen/queries';
import { ToolPipelineBuilder, type PipelineToolEntry } from '@/pages/asset-group/components/tool-pipeline-builder';

vi.mock('@/services/apis/gen/queries', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@/services/apis/gen/queries')
  >();
  return {
    ...actual,
    useToolConfigProfilesControllerList: () => ({
      data: [],
      isLoading: false,
    }),
  };
});

const tool = {
  id: 'tool-1',
  name: 'Nuclei',
  type: 'provider',
  logoUrl: '',
} as unknown as Tool;

/**
 * Radix only positions the popper once the `PopoverAnchor asChild` child
 * registers a DOM node via ref. If the child is a component that does not
 * forward its ref, the anchor stays null, floating-ui never runs, and the
 * content keeps its off-screen sentinel transform — the panel is in the DOM
 * but invisible, i.e. "clicking does nothing". jsdom text queries cannot see
 * that; the wrapper transform can.
 */
async function expectPopoverAnchored() {
  const wrapper = document.querySelector(
    '[data-radix-popper-content-wrapper]',
  );
  expect(wrapper).not.toBeNull();
  await waitFor(() =>
    expect((wrapper as HTMLElement).style.transform).not.toBe(
      'translate(0, -200%)',
    ),
  );
}

describe('ToolPipelineBuilder — tool click opens its panel', () => {
  it('opens the pending panel for a tool not yet added', async () => {
    const { user } = renderWithProviders(
      <ToolPipelineBuilder tools={[tool]} value={[]} onChange={vi.fn()} />,
    );

    await user.click(
      await screen.findByRole('button', { name: 'Add Nuclei to pipeline' }),
    );

    expect(await screen.findByText('Add to pipeline')).toBeInTheDocument();
    await expectPopoverAnchored();
  });

  it('opens the selected panel for a tool already added', async () => {
    const { user } = renderWithProviders(
      <ToolPipelineBuilder
        tools={[tool]}
        value={[{ toolId: 'tool-1' }]}
        onChange={vi.fn()}
      />,
    );

    await user.click(
      await screen.findByRole('button', { name: 'Configure Nuclei' }),
    );

    // Ordering uses explicit stages, with configuration in the same panel.
    expect(await screen.findByText('Inline config')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Close Nuclei panel' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^Move Nuclei/ }),
    ).not.toBeInTheDocument();
    await expectPopoverAnchored();
  });
});

describe('ToolPipelineBuilder stages', () => {
  it('shows the default stage on a selected logo and its labelled control', async () => {
    const { user } = renderWithProviders(<ToolPipelineBuilder tools={[tool]} value={[{ toolId: tool.id }]} onChange={vi.fn()} />);
    const button = await screen.findByRole('button', { name: 'Configure Nuclei' });
    expect(within(button).getByText('Stage 1')).toBeVisible();
    await user.click(button);
    expect(await screen.findByRole('combobox', { name: 'Pipeline stage' })).toHaveTextContent('Stage 1');
  });

  it('changes stage while preserving ordered input, profile, inline configuration and job identity', async () => {
    const entry: PipelineToolEntry = { toolId: tool.id, jobId: 'scan-web', stage: 1, input: ['web', 'host'], config: { severity: 'high' }, configProfileId: 'profile' };
    const onChange = vi.fn();
    const { user } = renderWithProviders(<ToolPipelineBuilder tools={[tool]} value={[entry]} onChange={onChange} />);
    await user.click(await screen.findByRole('button', { name: 'Configure Nuclei' }));
    await user.click(await screen.findByRole('combobox', { name: 'Pipeline stage' }));
    await user.click(await screen.findByRole('option', { name: 'Stage 20', exact: true }));
    expect(onChange).toHaveBeenCalledWith([{ ...entry, stage: 20 }]);
  });

  it('does not label unselected tools with a stage', async () => {
    renderWithProviders(<ToolPipelineBuilder tools={[tool]} value={[]} onChange={vi.fn()} />);
    const button = await screen.findByRole('button', { name: 'Add Nuclei to pipeline' });
    expect(within(button).queryByText(/Stage/)).toBeNull();
  });
});

describe('ToolPipelineBuilder — category picker', () => {
  const nmap = {
    id: 'tool-nmap',
    name: 'nmap',
    type: 'connector',
    logoUrl: '',
    categories: [
      { name: 'ports_scanner', targetTypes: [] },
      { name: 'vulnerabilities', targetTypes: [] },
    ],
  } as unknown as Tool;

  it('lets an entry of a multi-category tool pick its category', async () => {
    const onChange = vi.fn();
    const { user } = renderWithProviders(
      <ToolPipelineBuilder
        tools={[nmap]}
        value={[{ toolId: 'tool-nmap' }]}
        onChange={onChange}
      />,
    );

    await user.click(
      await screen.findByRole('button', { name: 'Configure nmap' }),
    );
    await user.click(await screen.findByRole('combobox', { name: 'Category' }));
    await user.click(
      await screen.findByRole('option', { name: 'Vulnerabilities' }),
    );

    expect(onChange).toHaveBeenCalledWith([
      { toolId: 'tool-nmap', category: 'vulnerabilities' },
    ]);
  });

  it('shows no category picker for a single-category tool', async () => {
    const naabu = {
      ...nmap,
      id: 'tool-naabu',
      name: 'naabu',
      categories: [{ name: 'ports_scanner', targetTypes: [] }],
    } as unknown as Tool;
    const { user } = renderWithProviders(
      <ToolPipelineBuilder
        tools={[naabu]}
        value={[{ toolId: 'tool-naabu' }]}
        onChange={vi.fn()}
      />,
    );

    await user.click(
      await screen.findByRole('button', { name: 'Configure naabu' }),
    );

    expect(await screen.findByText('Inline config')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Category' })).toBeNull();
  });
});
