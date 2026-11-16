import { AgentsCompletionsService } from './agents.completions';

describe('project context permissions', () => {
  afterEach(() => jest.useRealTimers());
  function setup(keys: string[]) {
    const builder = { addSelect: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), getOne: jest.fn().mockResolvedValue({ id: 'project', name: 'Private scope', instruction: 'Private instructions' }) };
    const files = { contextFiles: jest.fn().mockResolvedValue([{ id: 'file', name: 'scope.md', content: 'Private file', totalChars: 12 }]) };
    const service = Object.assign(Object.create(AgentsCompletionsService.prototype), { projectRepository: { createQueryBuilder: () => builder }, projectFiles: files, workspacesService: { getMembershipWithPermissions: jest.fn().mockResolvedValue({ permissionKeys: keys }) } });
    return { context: () => service.projectContext({ projectId: 'project', createdBy: 'user' }, 'workspace') as Promise<string>, files };
  }
  it('does not read project files with agent access alone, including after a role downgrade', async () => {
    const { context, files } = setup(['agent.read', 'agent.write']);
    await expect(context()).rejects.toThrow('project.read');
    expect(files.contextFiles).not.toHaveBeenCalled();
  });
  it('allows effective project write and bounds the workspace-scoped prompt files', async () => {
    const { context, files } = setup(['project.write']);
    expect(await context()).toContain('Private instructions');
    expect(files.contextFiles).toHaveBeenCalledWith('project', { perFile: 8000, total: 30000 }, 'workspace');
  });

  it('stops a stream when another replica has deleted its conversation and clears the heartbeat', async () => {
    jest.useFakeTimers();
    const stopRun = jest.fn().mockResolvedValue(true);
    const service = Object.assign(Object.create(AgentsCompletionsService.prototype), { conversationRepository: { findOne: jest.fn().mockResolvedValue(null) }, stopRun, logger: { warn: jest.fn() } });
    const dispose = service.watchProjectConversation('conversation', 'project', 'workspace', 'user') as () => void;
    await jest.advanceTimersByTimeAsync(2000);
    expect(stopRun).toHaveBeenCalledWith('conversation');
    dispose(); await jest.advanceTimersByTimeAsync(5000);
    expect(stopRun).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });
  it('stops every linked local stream before project deletion', async () => {
    const stopRun = jest.fn().mockResolvedValue(true);
    const find = jest.fn().mockResolvedValue([{ id: 'one' }, { id: 'two' }]);
    const service = Object.assign(Object.create(AgentsCompletionsService.prototype), { conversationRepository: { find }, stopRun });
    await service.stopProjectConversations({ projectId: 'project', workspaceId: 'workspace' });
    expect(find).toHaveBeenCalledWith({ where: { projectId: 'project', workspaceId: 'workspace' }, select: { id: true } });
    expect(stopRun.mock.calls).toEqual([['one'],['two']]);
  });
});
