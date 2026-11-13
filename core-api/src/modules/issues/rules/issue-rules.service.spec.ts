import {
  IssueLinkResourceType,
  IssueRuleGroupBy,
  IssueType,
  Severity,
} from '@/common/enums/enum';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DEFAULT_ISSUE_RULE, IssueRulesService } from './issue-rules.service';

const WS = 'ws-1';

function setup() {
  const rulesRepo = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn(),
    create: jest.fn((x: unknown) => x),
    save: jest.fn((x: object) => Promise.resolve({ id: 'r-1', ...x })),
    delete: jest.fn(),
  };
  const manager = {
    query: jest.fn().mockResolvedValue([{ one: 1 }]),
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((_: unknown, x: unknown) => x),
    save: jest.fn((x: object) => Promise.resolve({ id: 'r-1', ...x })),
    update: jest.fn(),
    delete: jest.fn(),
  };
  const dataSource = {
    query: jest.fn().mockResolvedValue([{ one: 1 }]),
    transaction: jest.fn((work: (m: typeof manager) => unknown) => work(manager)),
  };
  const links = { assertInWorkspace: jest.fn() };
  const service = new IssueRulesService(
    rulesRepo as never,
    dataSource as never,
    links as never,
  );
  return { service, rulesRepo, manager, dataSource, links };
}

const input = {
  name: 'Crit',
  event: 'vulnerability.detected' as const,
  issueType: IssueType.VULNERABILITY_REMEDIATION,
};

describe('IssueRulesService', () => {
  it('creates a rule with defaults', async () => {
    const { service, manager } = setup();
    await service.create(input, WS, 'u-1');
    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS,
        enabled: true,
        conditions: {},
        groupBy: IssueRuleGroupBy.VULNERABILITY_NAME,
        priority: null,
        createdById: 'u-1',
      }),
    );
  });

  it('checks targets and the default assignee against the workspace', async () => {
    const { service, links, manager } = setup();
    await service.create(
      { ...input, conditions: { targetIds: ['t-1'] } },
      WS,
      'u-1',
    );
    expect(links.assertInWorkspace).toHaveBeenCalledWith(
      [{ resourceType: IssueLinkResourceType.TARGET, resourceId: 't-1' }],
      WS,
      manager,
    );
    manager.query.mockResolvedValue([]);
    await expect(
      service.create({ ...input, defaultAssigneeId: 'stranger' }, WS, 'u-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(manager.save).toHaveBeenCalledTimes(1);
  });

  it('updates and deletes only rules of the workspace', async () => {
    const { service, manager } = setup();
    manager.findOne.mockResolvedValue(null);
    await expect(service.update('r-x', { enabled: false }, WS)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.delete('r-x', WS)).rejects.toBeInstanceOf(NotFoundException);
    expect(manager.findOne).toHaveBeenCalledWith(expect.anything(), {
      where: { id: 'r-x', workspaceId: WS }, lock: { mode: 'pessimistic_write' },
    });

    manager.findOne.mockResolvedValue({ id: 'r-1', enabled: true, conditions: {} });
    await service.update('r-1', { enabled: false }, WS);
    expect(manager.update).toHaveBeenCalledWith(expect.anything(), { id: 'r-1', workspaceId: WS }, expect.objectContaining({ enabled: false }));
  });

  it('installs the default rule once, under a workspace lock', async () => {
    const { service, manager } = setup();
    await service.createDefaults(WS, 'u-1');
    expect(manager.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      ['issues:' + WS],
    );
    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Critical & High',
        event: 'vulnerability.detected',
        conditions: { minSeverity: Severity.HIGH },
        issueType: IssueType.VULNERABILITY_REMEDIATION,
        groupBy: IssueRuleGroupBy.VULNERABILITY_NAME,
        priority: null,
        workspaceId: WS,
      }),
    );

    manager.save.mockClear();
    manager.findOne.mockResolvedValue({ id: 'r-1', name: DEFAULT_ISSUE_RULE.name });
    await service.createDefaults(WS, 'u-1');
    expect(manager.save).not.toHaveBeenCalled();
  });
});
