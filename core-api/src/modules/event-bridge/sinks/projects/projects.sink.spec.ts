import { AuditActorType, AuditOutcome } from '@/common/enums/enum';
import { EVENT_CATALOG } from '../../contracts/event-catalog';
import type { ConsumedEvent } from '../../contracts/event-envelope';
import { ProjectsSink } from './projects.sink';

describe('ProjectsSink discovery', () => {
  const project = '11111111-1111-4111-8111-111111111111';
  const asset = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const run = '22222222-2222-4222-8222-222222222222';
  const event = (payload: unknown): ConsumedEvent => ({
    workspaceId: 'workspace',
    eventId: 'event',
    payload,
  });
  const setup = () => {
    const scope = {
      addDiscoveredAssets: jest
        .fn()
        .mockResolvedValue(new Map([[project, [asset]]])),
    };
    const bridge = { publishSafely: jest.fn().mockResolvedValue('1-0') };
    return {
      scope,
      bridge,
      sink: new ProjectsSink(scope as never, bridge as never),
    };
  };
  it('accepts only discovered asset batches, keeping its output out of its input', () => {
    const { sink } = setup();
    expect(sink.group).toBe('projects');
    expect(sink.domains).toEqual(['asset']);
    expect(sink.accepts('asset.discovered')).toBe(true);
    expect(sink.accepts('project.updated')).toBe(false);
    expect(sink.accepts('asset.deleted')).toBe(false);
  });
  it('normalizes and deduplicates UUIDs before matching in the event workspace', async () => {
    const { sink, scope } = setup();
    await sink.handle(
      'asset.discovered',
      event({
        assetIds: [asset.toUpperCase(), asset, 'bad-id', null],
        jobHistoryId: run,
      }),
    );
    expect(scope.addDiscoveredAssets).toHaveBeenCalledWith('workspace', [
      asset,
    ]);
  });
  it('reports new memberships and system activity only after attachment resolves', async () => {
    const { sink, scope, bridge } = setup();
    scope.addDiscoveredAssets.mockImplementation(() => {
      expect(bridge.publishSafely).not.toHaveBeenCalled();
      return Promise.resolve(new Map([[project, [asset]]]));
    });
    await sink.handle(
      'asset.discovered',
      event({ assetIds: [asset], jobHistoryId: run }),
    );
    const subject = { subject: `workspace:workspace/project:${project}` };
    expect(bridge.publishSafely).toHaveBeenCalledTimes(2);
    expect(bridge.publishSafely.mock.calls).toEqual([
      [
        EVENT_CATALOG.project.assets.added,
        {
          workspaceId: 'workspace',
          outcome: AuditOutcome.Success,
          resourceType: 'project',
          resourceId: project,
          payload: { projectId: project, assetIds: [asset], jobHistoryId: run },
        },
        subject,
      ],
      [
        EVENT_CATALOG.project.updated,
        {
          workspaceId: 'workspace',
          outcome: AuditOutcome.Success,
          actor: { type: AuditActorType.System },
          resourceType: 'project',
          resourceId: project,
          metadata: { change: 'assets.discovered', added: 1 },
        },
        subject,
      ],
    ]);
  });
  it.each([undefined, 'not-a-run'])(
    'omits absent or malformed run provenance (%s)',
    async (jobHistoryId) => {
      const { sink, bridge } = setup();
      await sink.handle(
        'asset.discovered',
        event({ assetIds: [asset], jobHistoryId }),
      );
      expect(bridge.publishSafely).toHaveBeenCalledTimes(2);
      expect(bridge.publishSafely.mock.calls[0][1].payload).not.toHaveProperty(
        'jobHistoryId',
      );
    },
  );
  it.each([
    undefined,
    null,
    { assetIds: 'wrong' },
    { assetIds: [null, 4, 'invalid'] },
  ])('skips malformed or empty discoveries (%p)', async (payload) => {
    const { sink, scope, bridge } = setup();
    await sink.handle('asset.discovered', event(payload));
    expect(scope.addDiscoveredAssets).not.toHaveBeenCalled();
    expect(bridge.publishSafely).not.toHaveBeenCalled();
  });
  it('does not report replayed memberships or empty project entries', async () => {
    const { sink, scope, bridge } = setup();
    scope.addDiscoveredAssets
      .mockResolvedValueOnce(new Map())
      .mockResolvedValueOnce(new Map([[project, []]]));
    await sink.handle('asset.discovered', event({ assetIds: [asset] }));
    await sink.handle('asset.discovered', event({ assetIds: [asset] }));
    expect(bridge.publishSafely).not.toHaveBeenCalled();
  });
  it('propagates attachment failures for consumer retry without emitting partial reports', async () => {
    const { sink, scope, bridge } = setup(),
      failure = new Error('database failure');
    scope.addDiscoveredAssets.mockRejectedValue(failure);
    await expect(
      sink.handle('asset.discovered', event({ assetIds: [asset] })),
    ).rejects.toBe(failure);
    expect(bridge.publishSafely).not.toHaveBeenCalled();
  });
  it('ignores other events even when directly handed one', async () => {
    const { sink, scope } = setup();
    await sink.handle('asset.deleted', event({ assetIds: [asset] }));
    expect(scope.addDiscoveredAssets).not.toHaveBeenCalled();
  });
});
