import { WorkspacePermissions } from '@/common/decorators/workspace-permissions.decorator';
import { Reflector } from '@nestjs/core';
import { PUBLISH_EVENT_KEY, type PublishEventConfig } from '../event-bridge/publishing/publish-event.decorator';
import { isPersisted } from '../event-bridge/routing/event-policy';
import { AUDIT_EVENTS } from '../audit/constants/audit-events';
import { ArtifactsController } from './artifacts.controller';
import { PublicArtifactsController } from './public-artifacts.controller';

describe('Workspace file audit wiring', () => {
  const reflector = new Reflector();
  const config = (method: keyof ArtifactsController) =>
    reflector.get<PublishEventConfig & { event: { name: string } }>(PUBLISH_EVENT_KEY, ArtifactsController.prototype[method]);

  it.each([
    ['updateAccess', 'artifact.updated'],
    ['addShares', 'artifact.shared'],
    ['removeShare', 'artifact.unshared'],
  ] as const)('%s publishes the persisted %s event under file write access', (method, name) => {
    expect(config(method)?.event.name).toBe(name);
    expect(AUDIT_EVENTS).toContain(name);
    expect(isPersisted(name)).toBe(true);
    expect(reflector.get(WorkspacePermissions, ArtifactsController.prototype[method])).toEqual(['artifact.write']);
  });

  it('uses the returned file identity and mode without copying the request body', () => {
    const event = config('updateAccess');
    const result = { id: 'file', shareType: 'shared', name: 'Private display name' };
    const body = { shareType: 'public', emails: ['private@example.test'] };
    expect(event?.resourceId?.(result)).toBe('file');
    expect(event?.changes?.(body, result)).toEqual({ shareType: { after: 'shared' } });
    expect(event?.changes?.(body, undefined)).toEqual({});
    expect(event?.payload).toBeUndefined();
  });

  it('records recipient counts and the route file ID without recipient emails', () => {
    const event = config('addShares');
    expect(event?.resourceIdFromRoute).toBe(true);
    expect(event?.metadata?.({ emails: ['private@example.test'] }, { shared: 1, skipped: 2 })).toEqual({ shared: 1, skipped: 2 });
    expect(event?.metadata?.({ emails: ['private@example.test'] }, undefined)).toEqual({});
    expect(event?.payload).toBeUndefined();
  });

  it('keeps removal scoped to the route file without serializing its request', () => {
    const event = config('removeShare');
    expect(event?.resourceIdFromRoute).toBe(true);
    expect(event?.changes).toBeUndefined();
    expect(event?.metadata).toBeUndefined();
    expect(event?.payload).toBeUndefined();
  });

  it.each(['getMany', 'getUsage', 'getById', 'getShares'] as const)(
    'keeps %s reads outside sharing audit writes',
    method => expect(config(method)).toBeUndefined(),
  );

  it.each([
    ['download', 'artifact.downloaded'],
    ['remove', 'artifact.deleted'],
  ] as const)('%s records the route file and outcome without response data', (method, name) => {
    const event = config(method);
    expect(event?.event.name).toBe(name);
    expect(event?.resourceIdFromRoute).toBe(true);
    expect(event?.changes).toBeUndefined();
    expect(event?.metadata).toBeUndefined();
    expect(event?.payload).toBeUndefined();
    expect(AUDIT_EVENTS).toContain(name);
    expect(isPersisted(name)).toBe(true);
    expect(reflector.get(WorkspacePermissions, ArtifactsController.prototype[method])).toEqual(['artifact.read']);
  });

  it('keeps anonymous public downloads outside actor-based sharing audit writes', () => {
    expect(reflector.get(PUBLISH_EVENT_KEY, PublicArtifactsController.prototype.download)).toBeUndefined();
  });
});
