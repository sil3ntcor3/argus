import type { ProjectTriggerRuntimeService } from './project-trigger-runtime.service';
import { randomUUID } from 'node:crypto';
import type { CreateProjectTriggerDto } from './dto/project-trigger-create.dto';
import type { ProjectTriggerDefinitionService } from './project-trigger-definition.service';
import { ProjectTriggerCreateService } from './project-trigger-create.service';

describe('ProjectTriggerCreateService', () => {
  const project = randomUUID(),
    workspace = randomUUID(),
    binding = randomUUID();
  const row = {
    id: randomUUID(),
    projectWorkflowId: binding,
    type: 'event',
    event: 'project.assets.added',
    cron: null,
    config: {},
    enabled: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastFiredAt: null,
    schedulerId: 'private',
  };
  const createDisabled = jest.fn();
  const service = new ProjectTriggerCreateService({
    createDisabled,
  } as unknown as ProjectTriggerDefinitionService, { reconcile: () => Promise.resolve() } as unknown as ProjectTriggerRuntimeService);
  beforeEach(() => createDisabled.mockReset().mockResolvedValue(row));
  it.each([
    [{ type: 'cron', cron: '0 8 * * *' }, { schedule: '0 8 * * *' }],
    [
      { type: 'event', event: 'project.assets.added' },
      { 'project.assets.added': {} },
    ],
  ])(
    'delegates one definition to the scoped transaction and exposes only safe metadata',
    async (input, definition) => {
      const result = await service.create(project, workspace, {
        projectWorkflowId: binding,
        ...input,
      } as CreateProjectTriggerDto);
      expect(createDisabled).toHaveBeenCalledWith(
        project,
        workspace,
        binding,
        definition,
      );
      const safe: Partial<typeof row> = { ...row };
      delete safe.schedulerId;
      expect(result).toEqual(safe);
    },
  );
  it('rejects conflicting type-specific fields before persistence', async () => {
    await expect(
      service.create(project, workspace, {
        projectWorkflowId: binding,
        type: 'cron',
        cron: '0 8 * * *',
        config: {},
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(createDisabled).not.toHaveBeenCalled();
  });
});
