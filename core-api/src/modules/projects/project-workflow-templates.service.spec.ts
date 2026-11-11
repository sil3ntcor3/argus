import type { DataSource } from 'typeorm';
import { Workflow } from '../workflows/entities/workflow.entity';
import { ProjectWorkflowTemplatesService } from './project-workflow-templates.service';

describe('ProjectWorkflowTemplatesService', () => {
  const repository = { find: jest.fn() };
  const dataSource = { getRepository: jest.fn(() => repository) };
  const service = new ProjectWorkflowTemplatesService(
    dataSource as unknown as DataSource,
  );
  beforeEach(() => jest.clearAllMocks());

  it('selects only immutable workflows from the requested workspace in stable order', async () => {
    repository.find.mockResolvedValue([]);
    expect(await service.list('workspace')).toEqual([]);
    expect(dataSource.getRepository).toHaveBeenCalledWith(Workflow);
    expect(repository.find).toHaveBeenCalledWith({
      where: { workspace: { id: 'workspace' }, isCanEdit: false },
      select: { filePath: true, name: true, content: true },
      order: { name: 'ASC', filePath: 'ASC', id: 'ASC' },
    });
  });
  it('projects only template names and dependency outlines without mutating stored configs', async () => {
    const workflows = [
      {
        filePath: 'default.yaml',
        name: 'Default',
        content: {
          on: { target: { created: true } },
          jobs: {
            probe: {
              run: 'httpx',
              config: { password: 'secret' },
              configProfileId: 'private',
            },
            scan: { run: 'nuclei', needs: 'probe' },
          },
        },
        workspace: { id: 'private' },
      },
    ];
    const before = JSON.stringify(workflows);
    repository.find.mockResolvedValue(workflows);
    expect(await service.list('workspace')).toEqual([
      {
        filePath: 'default.yaml',
        name: 'Default',
        jobs: [
          { id: 'probe', run: 'httpx', needs: [] },
          { id: 'scan', run: 'nuclei', needs: ['probe'] },
        ],
      },
    ]);
    expect(JSON.stringify(workflows)).toBe(before);
  });
  it('supports legacy array job IDs and normalizes scalar and array dependencies', async () => {
    repository.find.mockResolvedValue([
      {
        filePath: 'legacy.yaml',
        name: 'Legacy',
        content: {
          jobs: [
            { name: ' Ports ', run: 'naabu' },
            { name: 'Probe', run: 'httpx', needs: [' Ports ', ''] },
            { run: 'nuclei', needs: ' Probe ' },
          ],
        },
      },
    ]);
    expect((await service.list('workspace'))[0].jobs).toEqual([
      { id: 'Ports', run: 'naabu', needs: [] },
      { id: 'Probe', run: 'httpx', needs: ['Ports'] },
      { id: 'nuclei', run: 'nuclei', needs: ['Probe'] },
    ]);
  });
  it('returns an empty job outline for absent content or jobs', async () => {
    repository.find.mockResolvedValue([
      { filePath: 'a', name: 'A', content: null },
      { filePath: 'b', name: 'B', content: {} },
    ]);
    expect((await service.list('workspace')).map((w) => w.jobs)).toEqual([
      [],
      [],
    ]);
  });
  it('propagates persistence errors instead of returning a fabricated empty catalog', async () => {
    const error = new Error('database unavailable');
    repository.find.mockRejectedValue(error);
    await expect(service.list('workspace')).rejects.toBe(error);
  });
});
