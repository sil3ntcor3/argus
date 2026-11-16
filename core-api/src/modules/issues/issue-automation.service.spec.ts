import type { IssueEventsPublisher } from './issue-activity';
import { EVENT_CATALOG } from '../event-bridge/contracts/event-catalog';
import { randomUUID } from 'node:crypto';
import { IssueAutomationService } from './issue-automation.service';
import { IssueRuleEngine } from './rules/issue-rule-engine.service';
import { VulnerabilityRemediationHandler } from './handlers/vulnerability-remediation.handler';
import { loadIssueFindingProofs, lockIssueFindingProofs } from './issue-finding-proof';
import { issueFactOf, IssuesSink } from '../event-bridge/sinks/issues/issues.sink';
jest.mock('./issue-finding-proof', () => ({ loadIssueFindingProofs: jest.fn(), lockIssueFindingProofs: jest.fn() }));

describe('Durable issue automation coordinator', () => {
  const workspaceId=randomUUID(), vulnerabilityId=randomUUID(), proofId=randomUUID();
  const fact={ event: 'vulnerability.detected' as const, workspaceId, vulnerabilityIds:[vulnerabilityId], proofIds:[proofId] };
  const setup=() => {
    const manager={ query: jest.fn().mockResolvedValue([]) };
    const db={ transaction: jest.fn((work: (manager: unknown) => unknown) => Promise.resolve(work(manager))) };
    return { manager, db, service: new IssueAutomationService(db as never, { publish: jest.fn() } as never) };
  };
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(IssueRuleEngine.prototype,'onFindings').mockResolvedValue();
    jest.spyOn(VulnerabilityRemediationHandler.prototype,'onLinkedResourceEvent').mockResolvedValue();
  });
  afterEach(() => jest.restoreAllMocks());
  it('requires proof and workspace authority before any transaction', async () => {
    const { service,db }=setup(); await service.onVulnerabilityEvent({ ...fact,proofIds:[] });
    await service.onVulnerabilityEvent({ ...fact,workspaceId:'invalid' });
    expect(db.transaction).not.toHaveBeenCalled();
  });
  it('ignores removed or unadmitted evidence and permanently receipts ineligible admitted facts', async () => {
    const { service,manager }=setup();
    jest.mocked(loadIssueFindingProofs).mockResolvedValue([]);
    await service.onVulnerabilityEvent(fact);
    jest.mocked(loadIssueFindingProofs).mockResolvedValue([{ id:proofId,vulnerabilityId,admitted:false,eligible:true }]);
    await service.onVulnerabilityEvent(fact);
    expect(IssueRuleEngine.prototype.onFindings).not.toHaveBeenCalled();
    jest.mocked(loadIssueFindingProofs).mockResolvedValue([{ id:proofId,vulnerabilityId,admitted:true,eligible:false }]);
    await service.onVulnerabilityEvent(fact);
    expect(manager.query).toHaveBeenCalledWith(expect.stringContaining("'issue_automation'"),expect.arrayContaining([expect.objectContaining({ proofId,eligible:false })]));
  });
  it('processes all 1001 proofs and forwards the full batch through the sink', async () => {
    const proofIds=Array.from({ length:1001 },()=>randomUUID());
    const event={ eventId:randomUUID(),workspaceId,outcome:'success', metadata:{ findingEventIds:proofIds },payload:{ vulnerabilities:[{ id:vulnerabilityId }] } };
    const parsed=issueFactOf('vulnerability.detected',event as never)!;
    expect(parsed.proofIds).toHaveLength(1001);
    const { service }=setup();
    jest.mocked(loadIssueFindingProofs).mockResolvedValue(proofIds.map(id=>({ id,vulnerabilityId,admitted:true,eligible:true })));
    await service.onVulnerabilityEvent(parsed);
    expect(lockIssueFindingProofs).toHaveBeenCalledWith(expect.anything(),parsed,proofIds);
    expect(IssueRuleEngine.prototype.onFindings).toHaveBeenCalledTimes(1001);
  });
  it('handles resurfacing before rule application and fixed facts without creating new issues', async () => {
    const { service }=setup();
    jest.mocked(loadIssueFindingProofs).mockResolvedValue([{ id:proofId,vulnerabilityId,admitted:true,eligible:true }]);
    await service.onVulnerabilityEvent({ ...fact,event:'vulnerability.resurfaced' });
    expect(VulnerabilityRemediationHandler.prototype.onLinkedResourceEvent).toHaveBeenCalledWith(expect.objectContaining({ name:'vulnerability.resurfaced',proofId }));
    expect(jest.mocked(VulnerabilityRemediationHandler.prototype.onLinkedResourceEvent).mock.invocationCallOrder[0]).toBeLessThan(jest.mocked(IssueRuleEngine.prototype.onFindings).mock.invocationCallOrder[0]);
    jest.mocked(IssueRuleEngine.prototype.onFindings).mockClear();
    await service.onVulnerabilityEvent({ ...fact,event:'vulnerability.fixed' });
    expect(IssueRuleEngine.prototype.onFindings).not.toHaveBeenCalled();
  });
  it('marks transport delivery only after success and retries failed work', async () => {
    const issues={ onVulnerabilityEvent:jest.fn().mockRejectedValueOnce(new Error('retry')).mockResolvedValue(undefined) };
    const redis={ get:jest.fn().mockResolvedValue(null),setex:jest.fn() };
    const sink=new IssuesSink(issues,redis as never);
    const event={ eventId:randomUUID(),workspaceId,outcome:'success',metadata:{ findingEventIds:[proofId] },payload:{ vulnerabilities:[{ id:vulnerabilityId }] } };
    await expect(sink.handle('vulnerability.detected',event as never)).rejects.toThrow('retry');
    expect(redis.setex).not.toHaveBeenCalled();
    await sink.handle('vulnerability.detected',event as never); expect(redis.setex).toHaveBeenCalledTimes(1);
  });
  it('commits link activity and private receipts before publishing buffered issue events',async()=>{
    let committed=false;
    const query=jest.fn((sql:string)=>Promise.resolve(sql.includes('SELECT link.')?[{ issueId:randomUUID() }]:[]));
    const manager={ query };
    const db={ transaction:jest.fn(async(work:(manager:unknown)=>Promise<void>)=>{await work(manager);committed=true;}) };
    const events={ publish:jest.fn(()=>{expect(committed).toBe(true);return Promise.resolve();}) };
    jest.mocked(loadIssueFindingProofs).mockResolvedValue([{ id:proofId,vulnerabilityId,admitted:true,eligible:true }]);
    jest.mocked(IssueRuleEngine.prototype.onFindings).mockImplementation(async function(this:IssueRuleEngine){
      const publisher=Reflect.get(this,'events') as IssueEventsPublisher;
      await publisher.publish(EVENT_CATALOG.issue.created,{ id:randomUUID(),workspaceId },'system');
    });
    await new IssueAutomationService(db as never,events as never).onVulnerabilityEvent(fact);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("'issue_linked'"),expect.any(Array));
    expect(events.publish).toHaveBeenCalledTimes(1);
  });

});
