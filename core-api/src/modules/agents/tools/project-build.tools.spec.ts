/* eslint-disable @typescript-eslint/require-await */
import {
  ProjectChange,
  ProjectScopeRuleMode,
  ProjectScopeRuleType,
  TargetType,
} from '@/common/enums/enum';

import {
  addProjectWorkflowTool,
  addTargetsTool,
  createProjectTool,
  updateProjectScopeTool,
} from './project-build.tools';
import type { ToolCallOptions, ToolScope } from './types';

const call = { toolCallId: 't1' } as ToolCallOptions;
const P1 = 'p1';

function setup(permissionKeys: string[] = ['*']) {
  const deps = {
    workspacesService: {
      getMembershipWithPermissions: jest.fn().mockResolvedValue({ permissionKeys }),
    },
    targetsService: {
      createMultipleTargets: jest.fn().mockResolvedValue({
        created: [{ id: 't-new', value: 'new.example.com' }],
        skipped: ['old.example.com'],
        totalRequested: 2,
      }),
    },
    conversationRepository: {
      manager: { query: jest.fn().mockResolvedValue([{ id: 't-old', value: 'old.example.com' }]), transaction: jest.fn() },
      update: jest.fn(),
    },
    toolsService: {
      getInstalledTools: jest.fn().mockResolvedValue({ data: [{ id: 'tool-a' }] }),
      installTool: jest.fn().mockResolvedValue({ tool: { name: 'nuclei' } }),
    },
    projectsService: {
      create: jest.fn().mockResolvedValue({ id: P1, name: 'Perimeter', totalAssets: 0 }),
      update: jest.fn().mockResolvedValue({ instruction: 'x' }),
      replaceScope: jest.fn().mockResolvedValue({ added: 1, removed: 0 }),
      patchScope: jest.fn().mockResolvedValue({ added: 1, removed: 0 }),
      addWorkflow: jest.fn().mockResolvedValue({ id: 'b1' }),
    },
    projectScopeService: {
      getScope: jest.fn().mockResolvedValue({
        rules: [
          { id: 'r1', mode: 'include', type: 'hostname', value: '*.a.com' },
          { id: 'r2', mode: 'exclude', type: 'hostname', value: 'b.a.com' },
        ],
      }),
    },
    projectTriggersService: { create: jest.fn() },
    eventBridge: { publishSafely: jest.fn() },
  };
  let linkedProject: string | null = null;
  const project = { id: P1, name: 'Perimeter', totalAssets: 0 };
  Object.assign(deps.projectsService, {
    createLinked: jest.fn(async () => { if (linkedProject) return null; linkedProject = P1; return project; }),
    configure: jest.fn().mockResolvedValue(project),
  });
  type Run = { execute: (p: unknown, o: ToolCallOptions) => Promise<unknown> };
  const run = (
    build: (d: never, w: string, s: ToolScope) => unknown,
    scope: ToolScope = { userId: 'u1', conversationId: 'c1' },
  ) => build(deps as never, 'w1', scope) as Run;
  return { deps: deps as typeof deps & { projectsService: typeof deps.projectsService & { createLinked: jest.Mock; configure: jest.Mock } }, run };
}

const targets = [
  { value: 'new.example.com', type: TargetType.DOMAIN },
  { value: 'old.example.com', type: TargetType.DOMAIN },
];

describe('create_project', () => {
  it('stops after a blocked target call resolves without starting later writes', async () => {
    const { deps, run } = setup();
    const stop = new AbortController();
    let release!: () => void;
    deps.targetsService.createMultipleTargets.mockImplementation(() => new Promise(resolve => { release = () => resolve({ created: [], skipped: [] }); }));
    const pending = run(createProjectTool).execute({ name: 'Perimeter', targets, runNow: true }, { toolCallId: 'stop', abortSignal: stop.signal });
    await new Promise(resolve => setImmediate(resolve));
    stop.abort(); release();
    await expect(pending).rejects.toThrow();
    expect(deps.projectsService.create).not.toHaveBeenCalled();
    expect(deps.toolsService.installTool).not.toHaveBeenCalled();
    expect(deps.conversationRepository.update).not.toHaveBeenCalled();
  });
  it('builds the project from targets, tools and instruction, then links the chat', async () => {
    const { deps, run } = setup();

    const result = await run(createProjectTool).execute(
      {
        name: 'Perimeter',
        instruction: 'Staging only',
        targets,
        toolIds: ['tool-a', 'tool-b'],
        schedule: '0 2 * * *',
      },
      call,
    );

    // Only the tool the workspace lacks is installed
    expect(deps.toolsService.installTool).toHaveBeenCalledTimes(1);
    expect(deps.toolsService.installTool).toHaveBeenCalledWith({ toolId: 'tool-b' }, 'w1');
    expect(deps.projectsService.configure).toHaveBeenCalledWith(
      P1,
      expect.objectContaining({
        name: 'Perimeter',
        scopeRules: [
          { mode: ProjectScopeRuleMode.INCLUDE, type: ProjectScopeRuleType.TARGET, value: 't-new' },
          { mode: ProjectScopeRuleMode.INCLUDE, type: ProjectScopeRuleType.TARGET, value: 't-old' },
        ],
        tools: [{ toolId: 'tool-a' }, { toolId: 'tool-b' }],
        schedule: '0 2 * * *',
      }),
      'w1',
      undefined,
    );
    expect(deps.projectsService.update).toHaveBeenCalledWith(
      P1,
      { instruction: 'Staging only' },
      'w1',
    );
    expect(deps.projectsService.createLinked).toHaveBeenCalledWith({ name: 'Perimeter', description: undefined }, 'w1', 'u1', 'c1', undefined);
    expect(deps.eventBridge.publishSafely).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'project.created' }),
      expect.objectContaining({ resourceId: P1, actor: expect.objectContaining({ id: 'u1' }) }),
      expect.anything(),
    );
    expect(result).toMatchObject({
      projectId: P1,
      targetsCreated: ['new.example.com'],
      targetsExisting: ['old.example.com'],
      toolsInstalled: ['nuclei'],
      conversationLinked: true,
    });
  });

  it('refuses a second call in the same turn using the recorded project, before creating targets or another project', async () => {
    const { deps, run } = setup(); const tool = run(createProjectTool);
    await tool.execute({ name: 'First' }, call);
    expect(await tool.execute({ name: 'Second', targets }, call)).toContain('already belongs');
    expect(deps.projectsService.configure).toHaveBeenCalledTimes(1);
    expect(deps.targetsService.createMultipleTargets).not.toHaveBeenCalled();
  });

  it('needs target.write to add targets', async () => {
    const { deps, run } = setup(['project.write']);

    const result = await run(createProjectTool).execute({ name: 'P', targets }, call);

    expect(result).toContain('target.write');
    expect(deps.targetsService.createMultipleTargets).not.toHaveBeenCalled();
    expect(deps.projectsService.create).not.toHaveBeenCalled();
  });

  it('is refused in a chat that already belongs to a project', async () => {
    const { deps, run } = setup();

    const result = await run(createProjectTool, { userId: 'u1', projectId: 'p0' }).execute(
      { name: 'P' },
      call,
    );

    expect(result).toContain('already belongs to a project');
    expect(deps.projectsService.create).not.toHaveBeenCalled();
  });

  it('does nothing without a user to check', async () => {
    const { deps, run } = setup();

    expect(await run(createProjectTool, {}).execute({ name: 'P' }, call)).toContain(
      'no user',
    );
    expect(deps.projectsService.create).not.toHaveBeenCalled();
  });
});

describe('project edits', () => {
  it("adds targets to the locked project's scope", async () => {
    const { deps, run } = setup();

    await run(addTargetsTool, { userId: 'u1', projectId: P1 }).execute({ targets }, call);

    const change = deps.projectsService.patchScope.mock.calls[0][2] as { add: unknown[] };
    expect(deps.projectsService.patchScope.mock.calls[0][0]).toBe(P1);
    expect(change.add).toEqual([
      { mode: 'include', type: 'target', value: 't-new' },
      { mode: 'include', type: 'target', value: 't-old' },
    ]);
  });

  it('delegates rule removal and addition together to the atomic scope writer', async () => {
    const { deps, run } = setup();

    await run(updateProjectScopeTool, { userId: 'u1', projectId: P1 }).execute(
      { removeRuleIds: ['r2'], add: [{ mode: 'include', type: 'cidr', value: '10.0.0.0/24' }] },
      call,
    );

    expect(deps.projectsService.patchScope).toHaveBeenCalledWith(
      P1,
      'w1',
      { removeRuleIds: ['r2'], add: [{ mode: 'include', type: 'cidr', value: '10.0.0.0/24' }] },
      undefined,
    );
    expect(deps.eventBridge.publishSafely).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ metadata: { change: ProjectChange.SCOPE } }),
      expect.anything(),
    );
  });

  it('adds a scheduled workflow from a template', async () => {
    const { deps, run } = setup();

    await run(addProjectWorkflowTool, { userId: 'u1', projectId: P1 }).execute(
      { template: 'discovery.yaml', schedule: '0 3 * * *' },
      call,
    );

    expect(deps.projectsService.addWorkflow).toHaveBeenCalledWith(P1, 'w1', {
      name: undefined,
      template: 'discovery.yaml',
    }, undefined);
    expect(deps.projectTriggersService.create).toHaveBeenCalledWith(P1, 'w1', {
      projectWorkflowId: 'b1',
      type: 'cron',
      cron: '0 3 * * *',
    });
  });
});
