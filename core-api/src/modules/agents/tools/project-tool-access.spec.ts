import { withProjectAccess } from './project-tool-access';
import type { AgentToolDeps, ToolScope } from './types';
import type { Tool } from 'ai';

describe('project tool execution authorization', () => {
  const original = jest.fn().mockResolvedValue('result');
  const execute = (name: string, keys: string[], scope: ToolScope = { projectId: 'project', userId: 'user' }, params = {}, signal?: AbortSignal) => {
    const deps = { workspacesService: { getMembershipWithPermissions: jest.fn().mockResolvedValue({ permissionKeys: keys }) }, projectsService: { assertToolScope: jest.fn().mockResolvedValue(undefined) } };
    const tool = withProjectAccess(name, { execute: original } as Tool, deps as unknown as AgentToolDeps, 'workspace', scope);
    return (tool.execute as NonNullable<Tool['execute']>)(params, { toolCallId: 'call', messages: [], abortSignal: signal }) as Promise<unknown>;
  };
  beforeEach(() => original.mockClear());
  it('requires project access even when the model already has agent access', async () => {
    await expect(execute('list_projects', ['agent.read'])).rejects.toThrow('project.read');
    expect(original).not.toHaveBeenCalled();
  });
  it('honors write-implies-read and requires the underlying data permission', async () => {
    await expect(execute('enumerate_assets', ['project.write'])).rejects.toThrow('asset.read');
    await expect(execute('enumerate_assets', ['project.write', 'asset.write'])).resolves.toBe('result');
  });
  it('does not let a project writer launch a workflow without launch permission', async () => {
    await expect(execute('run_project_workflow', ['project.write'])).rejects.toThrow('workflow.write');
    expect(original).not.toHaveBeenCalled();
  });
  it('rejects a missing caller and an already-stopped run before reading data', async () => {
    await expect(execute('read_project_file', ['*'], { projectId: 'project' })).rejects.toThrow();
    await expect(execute('inspect_project', ['*'], undefined, {}, AbortSignal.abort())).rejects.toThrow();
    expect(original).not.toHaveBeenCalled();
  });
});
