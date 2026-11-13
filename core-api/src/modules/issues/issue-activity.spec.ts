import { IssueEventsPublisher } from './issue-activity';
import { EVENT_CATALOG } from '../event-bridge/contracts/event-catalog';

describe('Issue audit data minimization', () => {
  it('keeps approved scalar decisions but excludes arbitrary content and signed URLs', async () => {
    const bridge = { publishSafely: jest.fn() };
    await new IssueEventsPublisher(bridge as never).publish(EVENT_CATALOG.issue.updated, { id: 'issue', workspaceId: 'workspace' }, { userId: 'actor' }, { fields: ['title', 'description', 'priority'] }, {
      description: { before: 'private', after: 'https://storage.invalid/?X-Amz-Signature=secret' },
      title: { before: 'private', after: 'secret' }, tags: { before: [], after: ['secret'] },
      priority: { before: 'p3', after: 'p1' },
    });
    const envelope = bridge.publishSafely.mock.calls[0][1];
    expect(envelope.changes).toEqual({ priority: { before: 'p3', after: 'p1' } });
    expect(JSON.stringify(envelope)).not.toContain('secret');
  });
});
