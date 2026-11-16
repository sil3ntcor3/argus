import { ARTIFACT_MAX_FILE_BYTES } from '@/common/constants/artifact-storage';
import { AgentApprovalMode } from '@/common/enums/enum';
import { EventEmitter } from 'node:events';
import type { z } from 'zod';
import { withoutDisabledTools } from './agents.config';
import type { AgentConfig } from './entities/agent-config.entity';
import { AgentTool } from './agents.tools';
import type { ToolCallOptions } from './tools/types';

type FileTool = { inputSchema: z.ZodTypeAny; execute: (input: unknown, options: ToolCallOptions) => Promise<unknown> };

describe('Conversation save_file tool', () => {
  const createAgentFile = jest.fn();
  const getMembershipWithPermissions = jest.fn();
  const authorize = jest.fn();
  const emitter = new EventEmitter();
  const approval = { userId: 'actor', mode: AgentApprovalMode.MANUAL };
  const agentTool = Object.assign(Object.create(AgentTool.prototype), {
    artifactBufferService: { createAgentFile }, workspacesService: { getMembershipWithPermissions }, approvals: { authorize },
  }) as AgentTool;
  const tools = () => agentTool.getArtifactTools('workspace', 'actor', 'conversation', approval, emitter);
  const fileTool = () => tools().save_file as FileTool;
  const params = { fileName: 'report.txt', content: 'Résumé 🔒' };
  const execute = (signal?: AbortSignal) => {
    const tool = fileTool();
    return tool.execute(tool.inputSchema.parse(params), { toolCallId: 'call', abortSignal: signal });
  };

  beforeEach(() => {
    jest.resetAllMocks();
    authorize.mockResolvedValue({ allowed: true });
    getMembershipWithPermissions.mockResolvedValue({ permissionKeys: ['artifact.write'] });
    createAgentFile.mockResolvedValue({ id: 'file', name: params.fileName, sizeBytes: String(Buffer.byteLength(params.content)) });
  });

  it('offers the approved conversation tool', () => {
    expect(agentTool.getArtifactTools).toEqual(expect.any(Function));
    expect(Object.keys(tools())).toEqual(['save_file']);
  });

  it.each([['artifact.write'], ['*']])('saves UTF-8 bytes under effective %s with a safe result', async key => {
    getMembershipWithPermissions.mockResolvedValue({ permissionKeys: [key] });
    await expect(execute()).resolves.toEqual({ success: true, id: 'file', name: 'report.txt',
      sizeBytes: Buffer.byteLength(params.content), message: 'File saved to workspace Files.' });
    expect(createAgentFile).toHaveBeenCalledWith({ workspaceId: 'workspace', userId: 'actor', name: 'report.txt',
      contentType: 'text/plain', buffer: Buffer.from(params.content), abortSignal: undefined });
    expect(getMembershipWithPermissions).toHaveBeenCalledWith('workspace', 'actor');
  });

  it('uses the write approval gate and forwards Stop', async () => {
    const signal = new AbortController().signal;
    await execute(signal);
    expect(authorize).toHaveBeenCalledWith(expect.stringContaining('save_file '), 'call',
      { ...approval, workspaceId: 'workspace', conversationId: 'conversation' }, emitter,
      expect.objectContaining({ tool: 'save_file', readOnly: false }), signal);
    expect(createAgentFile.mock.calls[0][0].abortSignal).toBe(signal);
  });

  it.each([{ allowed: false }, { allowed: false, planRequired: true }, { allowed: false, todoRequired: true }])(
    'never writes when the approval/plan/todo gate rejects (%j)', async decision => {
      authorize.mockResolvedValue(decision);
      await expect(execute()).resolves.toEqual({ error: expect.any(String) });
      expect(createAgentFile).not.toHaveBeenCalled();
      expect(getMembershipWithPermissions).not.toHaveBeenCalled();
    },
  );

  it.each([{ permissions: [] }, { permissions: ['artifact.read'] }, { permissions: ['artifact.manage'] }])('requires write permission at execution (%j)', async ({ permissions }) => {
    getMembershipWithPermissions.mockResolvedValue({ permissionKeys: permissions });
    await expect(execute()).resolves.toMatchObject({ success: false, message: expect.stringContaining('artifact.write') });
    expect(createAgentFile).not.toHaveBeenCalled();
  });

  it('rechecks membership after the user approves', async () => {
    authorize.mockImplementationOnce(() => {
      getMembershipWithPermissions.mockRejectedValueOnce(new Error('Workspace member not found'));
      return { allowed: true };
    });
    await expect(execute()).resolves.toMatchObject({ success: false });
    expect(createAgentFile).not.toHaveBeenCalled();
  });

  it('stops before checking membership when already cancelled', async () => {
    await expect(execute(AbortSignal.abort(new Error('Stopped')))).resolves.toMatchObject({ success: false });
    expect(getMembershipWithPermissions).not.toHaveBeenCalled();
    expect(createAgentFile).not.toHaveBeenCalled();
  });

  it('rejects actual UTF-8 size above 50 MiB before writing', async () => {
    const tool = fileTool();
    await expect(tool.execute({ ...params, content: 'é'.repeat(ARTIFACT_MAX_FILE_BYTES / 2 + 1) }, { toolCallId: 'call' }))
      .resolves.toMatchObject({ success: false, message: expect.stringContaining('50 MiB') });
    expect(createAgentFile).not.toHaveBeenCalled();
  });

  it('accepts MIME override, strips model-supplied identity and remains disableable', async () => {
    const tool = fileTool();
    await tool.execute(tool.inputSchema.parse({ ...params, mimeType: 'text/markdown', workspaceId: 'foreign', userId: 'foreign', shareType: 'public' }), { toolCallId: 'call' });
    expect(createAgentFile.mock.calls[0][0]).toMatchObject({ workspaceId: 'workspace', userId: 'actor', contentType: 'text/markdown' });
    expect(withoutDisabledTools(tools(), { disabledTools: ['save_file'], memoryEnabled: true } as AgentConfig)).toEqual({});
    expect(agentTool.getMcpTools('workspace')).not.toHaveProperty('save_file');
  });
});
