import { randomUUID } from 'node:crypto';
import { listIssuesTool, detailIssueTool } from './workspace.tools';
import { listIssuesSchema } from '@/mcp/mcp.schema';

describe('Authenticated generic issue read tools', () => {
  const workspaceId = randomUUID(), userId = randomUUID(), issueId = randomUUID();
  const execute = async (tool: ReturnType<typeof listIssuesTool>, args: object): Promise<unknown> => { const result: unknown = await tool.execute!(args, { toolCallId: 'issues-fixture', messages: [] }); return result; };

  it('passes current actor and typed filters to workspace issue reads', async () => {
    const service = { getMany: jest.fn().mockResolvedValue({ data: [], total: 0 }), getById: jest.fn() };
    const tool = listIssuesTool({ issuesService: service as never }, workspaceId, { userId });
    await execute(tool, { page: 1, limit: 10, status: ['in_progress'], type: ['task'], priority: ['p1'], mine: true });
    expect(service.getMany).toHaveBeenCalledWith(expect.objectContaining({ status: ['in_progress'], type: ['task'], priority: ['p1'], mine: true }), workspaceId, userId);
    expect(listIssuesSchema.safeParse({ status: ['OPEN'] }).success).toBe(false);
  });

  it('does not fall back to privileged service reads when actor context is missing', async () => {
    const service = { getMany: jest.fn(), getById: jest.fn() };
    const result = await execute(detailIssueTool({ issuesService: service as never }, workspaceId), { issueId });
    expect(result).toEqual(expect.objectContaining({ success: false, message: expect.any(String) }));
    expect(service.getById).not.toHaveBeenCalled();
  });
  it('retains workspace-key MCP reads without inventing a member identity', async () => {
    const service = { getMany: jest.fn().mockResolvedValue({ data: [], total: 0 }), getById: jest.fn() };
    await execute(listIssuesTool({ issuesService: service as never }, workspaceId, { workspaceApiKey: true }), { page: 1, limit: 10 });
    expect(service.getMany).toHaveBeenCalledWith(expect.any(Object), workspaceId, undefined);
  });

});
