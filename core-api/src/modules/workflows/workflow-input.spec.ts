import { DataKind, TargetType, ToolCategory } from '@/common/enums/enum';
import type { Repository } from 'typeorm';
import type { Tool } from '../tools/entities/tools.entity';
import type { Workflow } from './entities/workflow.entity';
import type { CreateWorkflowDto } from './dto/create-workflow.dto';
import {
  buildWorkflowGraph,
  normalizeInput,
  normalizeWorkflowContent,
  type WorkflowJobsInput,
} from './workflow-graph';
import { WorkflowsService } from './workflows.service';

describe('workflow input declarations', () => {
  it.each([
    [' Web ', [DataKind.WEB]],
    [
      [' WEB ', 'host', 'web'],
      [DataKind.WEB, DataKind.HOST],
    ],
    [undefined, []],
    [[], []],
  ])('normalizes %j without changing preference order', (value, expected) => {
    expect(normalizeInput(value)).toEqual(
      expected,
    );
  });

  it('retains normalized input kinds in the graph and canonical stored content', () => {
    const content = {
      jobs: { scan: { run: 'nuclei', input: [' WEB ', 'host', 'web'] } },
    };
    expect(buildWorkflowGraph(content).byId.get('scan')?.input).toEqual([
      DataKind.WEB,
      DataKind.HOST,
    ]);
    expect(normalizeWorkflowContent(content).jobs.scan.input).toEqual([
      DataKind.WEB,
      DataKind.HOST,
    ]);
  });

  it.each(['ssh', 'vulnerability'])(
    'rejects unknown or output-only kind %s',
    (input) => {
      expect(() =>
        buildWorkflowGraph({ jobs: { scan: { run: 'nuclei', input } } }),
      ).toThrow(/Unknown input/);
    },
  );

  it.each([0, false, {}, [['web']], ['web', 0]])(
    'rejects malformed declaration %j',
    (input) => {
      expect(() =>
        buildWorkflowGraph({
          jobs: {
            scan: { run: 'nuclei', input },
          } as unknown as WorkflowJobsInput,
        }),
      ).toThrow(/input/i);
    },
  );

  const save = jest.fn((workflow: Workflow) => Promise.resolve(workflow));
  const findOne = jest.fn();
  const tools = { find: jest.fn() };
  const service = new WorkflowsService(
    { save, findOne } as unknown as Repository<Workflow>,
    tools as unknown as Repository<Tool>,
  );
  const workspace = { id: 'workspace' },
    user = { id: 'user' };
  const dto = (input: DataKind[]): CreateWorkflowDto => ({
    name: 'Input preference',
    content: {
      name: 'Input preference',
      jobs: { scan: { run: 'nuclei', input } },
    },
  });

  beforeEach(() => {
    save.mockClear();
    tools.find.mockResolvedValue([
      {
        name: 'nuclei',
        categories: [
          {
            name: ToolCategory.VULNERABILITIES,
            targetTypes: [TargetType.DOMAIN],
            inputs: [DataKind.HOST, DataKind.WEB],
          },
        ],
      },
    ]);
    findOne.mockResolvedValue({
      id: 'workflow',
      content: dto([DataKind.HOST]).content,
      workspace,
    });
  });

  it.each(['create', 'update'])(
    'rejects an unsupported step input on %s before saving',
    async (operation) => {
      const content = dto([DataKind.SERVICE]);
      const saving =
        operation === 'create'
          ? service.createWorkflow(content, user, workspace)
          : service.updateWorkflow('workflow', content, workspace);
      await expect(saving).rejects.toThrow(/cannot take service/);
      expect(save).not.toHaveBeenCalled();
    },
  );

  it.each(['create', 'update'])(
    'preserves an accepted reordered subset on %s',
    async (operation) => {
      const content = dto([DataKind.WEB, DataKind.HOST]);
      const result =
        operation === 'create'
          ? await service.createWorkflow(content, user, workspace)
          : await service.updateWorkflow('workflow', content, workspace);
      expect(result.content.jobs.scan.input).toEqual([
        DataKind.WEB,
        DataKind.HOST,
      ]);
    },
  );
});
