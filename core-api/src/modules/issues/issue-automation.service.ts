import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { isUUID } from 'class-validator';
import type { IssueVulnerabilityEvents, ProvenIssueFact } from '../event-bridge/sinks/issues/issues.sink';
import { IssueEventsPublisher, lockIssueWrites } from './issue-activity';
import { IssueRuleEngine } from './rules/issue-rule-engine.service';
import { VulnerabilityRemediationHandler } from './handlers/vulnerability-remediation.handler';
import { lockIssueFindingProofs, loadIssueFindingProofs } from './issue-finding-proof';

/** Commit issue actions and durable proof receipts together, then publish their events. */
@Injectable()
export class IssueAutomationService implements IssueVulnerabilityEvents {
  constructor(private readonly db: DataSource, private readonly events: IssueEventsPublisher) {}

  async onVulnerabilityEvent(fact: ProvenIssueFact): Promise<void> {
    const proofIds = [...new Set((fact.proofIds ?? []).filter(id => isUUID(id)))];
    if (!proofIds.length || !isUUID(fact.workspaceId)) return;
    const pending: Parameters<IssueEventsPublisher['publish']>[] = [];
    await this.db.transaction(async manager => {
      await lockIssueWrites(manager, fact.workspaceId);
      await lockIssueFindingProofs(manager, fact, proofIds);
      const proofs = await loadIssueFindingProofs(manager, fact, proofIds);
      const publisher = { publish: (...args: Parameters<IssueEventsPublisher['publish']>) => { pending.push(args); return Promise.resolve(); } } as IssueEventsPublisher;
      // EntityManager keeps every query and nested savepoint on this connection.
      const rules = new IssueRuleEngine(manager, publisher);
      const handler = new VulnerabilityRemediationHandler(manager, publisher);
      for (const proof of proofs) {
        if (!proof.admitted) continue;
        const handled = await manager.query<unknown[]>(`SELECT 1 FROM vulnerability_events
          WHERE "workspaceId"=$1 AND "vulnerabilityId"=$2 AND type='issue_automation'
            AND data->>'proofId'=$3 AND data->'version'='1'::jsonb LIMIT 1`, [fact.workspaceId, proof.vulnerabilityId, proof.id]);
        if (handled.length) continue;
        const before = await manager.query<{ issueId: string }[]>(`SELECT "issueId" FROM issue_links
          WHERE "resourceType"='vulnerability' AND "resourceId"=$1`, [proof.vulnerabilityId]);
        if (proof.eligible) {
          const vulnerabilityIds = [proof.vulnerabilityId];
          if (fact.event !== 'vulnerability.detected') await handler.onLinkedResourceEvent({
            name: fact.event, workspaceId: fact.workspaceId, vulnerabilityIds, proofId: proof.id,
          });
          if (fact.event !== 'vulnerability.fixed') await rules.onFindings(fact.event, fact.workspaceId, vulnerabilityIds);
        }
        const after = await manager.query<{ issueId: string }[]>(`SELECT link."issueId" FROM issue_links link
          JOIN issues issue ON issue.id=link."issueId" AND issue."workspaceId"=$2
          WHERE link."resourceType"='vulnerability' AND link."resourceId"=$1`, [proof.vulnerabilityId, fact.workspaceId]);
        for (const link of after) if (!before.some(row => row.issueId===link.issueId)) await manager.query(`INSERT INTO vulnerability_events
          ("workspaceId","vulnerabilityId",type,data,"occurredAt") VALUES($1,$2,'issue_linked',$3,statement_timestamp())`,
        [fact.workspaceId, proof.vulnerabilityId, { issueId: link.issueId }]);
        // This private receipt survives issue deletion and transport/Redis resets.
        await manager.query(`INSERT INTO vulnerability_events ("workspaceId","vulnerabilityId",type,data,"occurredAt")
          VALUES($1,$2,'issue_automation',$3,statement_timestamp())`, [fact.workspaceId, proof.vulnerabilityId,
          { proofId: proof.id, version: 1, eligible: proof.eligible, event: fact.event, issueIds: after.map(row => row.issueId) }]);
      }
    });
    for (const args of pending) await this.events.publish(...args);
  }
}
