import {
  AuditActorType,
  AuditOutcome,
  DismissReason,
  ProjectChange,
} from '@/common/enums/enum';
import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

export const PROJECT_ACTIVITY_LIMIT = 15;
const lifecycleActions = [
  'project.created',
  'project.archived',
  'project.unarchived',
];
const workflowChanges = [
  ProjectChange.WORKFLOW_ADDED,
  ProjectChange.WORKFLOW_UPDATED,
  ProjectChange.WORKFLOW_REMOVED,
];
const assetChanges = [
  ProjectChange.ASSETS_ADDED,
  ProjectChange.ASSETS_DISCOVERED,
  ProjectChange.ASSETS_REMOVED,
  ProjectChange.SCOPE,
];

interface ActivityBase {
  at: Date;
  actorName?: string;
}

export type ProjectNonRunActivity = ActivityBase &
  (
    | {
        kind: 'audit';
        ref: string;
        change?: ProjectChange;
        added?: number;
        removed?: number;
        workflowName?: string;
      }
    | {
        kind: 'dismissed';
        ref: 'dismissed';
        count: number;
        reason: DismissReason;
      }
  );

type ActivityRow =
  | ({ at: Date; actorName: string | null } & (
      | {
          kind: 'audit';
          ref: string;
          change: ProjectChange | null;
          added: number | null;
          removed: number | null;
          workflowName: string | null;
        }
      | { kind: 'dismissed'; count: number; reason: DismissReason }
    ))
  | { kind: null };

// Decode only numeric, non-negative integers. Legacy audit rows can contain
// arbitrary JSON, which must not reach an unchecked integer cast.
const countFromMetadata = (key: 'added' | 'removed') => {
  const field = `a.metadata->'${key}'`;
  const value = `(${field})::numeric`;
  return `CASE WHEN jsonb_typeof(${field}) = 'number' THEN
    CASE WHEN ${value} BETWEEN 0 AND 2147483647 AND ${value} = trunc(${value})
         THEN ${value}::int END END`;
};

@Injectable()
export class ProjectOverviewActivityService {
  constructor(private readonly dataSource: DataSource) {}

  async read(
    projectId: string,
    workspaceId: string,
    executor: Pick<DataSource, 'query'> = this.dataSource,
  ): Promise<ProjectNonRunActivity[]> {
    const rows = await executor.query<ActivityRow[]>(
      `WITH owned AS (
        SELECT id FROM projects WHERE id = $1 AND "workspaceId" = $2
      ), audit_source AS (
        SELECT a.id::text AS tie, a."occurredAt" AS at, a.action AS ref,
               -- Older API-key events can contain credentials in the actor name.
               CASE WHEN a."actorType" = $8 THEN 'API key' ELSE a."actorName" END AS "actorName",
               CASE WHEN a.action = 'project.updated' THEN a.metadata->>'change' END AS change,
               CASE WHEN a.action = 'project.updated' AND a.metadata->>'change' = ANY($5::text[])
                    THEN ${countFromMetadata('added')} END AS added,
               CASE WHEN a.action = 'project.updated' AND a.metadata->>'change' = ANY($5::text[])
                    THEN ${countFromMetadata('removed')} END AS removed,
               CASE WHEN a.action = 'project.updated' AND a.metadata->>'change' = ANY($4::text[])
                         AND jsonb_typeof(a.metadata->'workflow') = 'string'
                    THEN NULLIF(a.metadata->>'workflow', '') END AS "workflowName"
        FROM owned p JOIN audit_events a ON a."resourceId" = p.id
        WHERE a."workspaceId" = $2 AND a."resourceType" = 'project' AND a.outcome = $7
          AND (a.action = ANY($3::text[])
               OR (a.action = 'project.updated' AND (a.metadata->>'change' = ANY($4::text[])
                                                    OR a.metadata->>'change' = ANY($5::text[]))))
      ), audits AS (
        SELECT 'audit' AS kind, tie, at, ref, "actorName", change, added, removed, "workflowName",
               NULL::text AS reason, NULL::int AS count
        FROM audit_source
        WHERE change IS NULL OR change = ANY($4::text[]) OR added > 0 OR removed > 0
        ORDER BY at DESC, tie DESC LIMIT ${PROJECT_ACTIVITY_LIMIT}
      ), dismissals AS (
        SELECT 'dismissed' AS kind, MIN(d.id::text) AS tie, MAX(d."createdAt")::timestamptz AS at,
               'dismissed' AS ref, u.name AS "actorName", NULL::text AS change,
               NULL::int AS added, NULL::int AS removed, NULL::text AS "workflowName",
               d.reason, COUNT(*)::int AS count
        FROM owned p JOIN project_vulnerabilities pv ON pv."projectId" = p.id
        JOIN LATERAL (
          SELECT v.id FROM vulnerabilities v JOIN assets a ON a.id = v."assetId"
          JOIN targets t ON t.id = a."targetId" AND t."workspaceId" = $2
          WHERE v.id = pv."vulnerabilityId" AND v."reviewStatus"='approved' LIMIT 1
        ) v ON true
        JOIN vulnerability_dismissals d ON d."vulnerabilityId" = v.id
        LEFT JOIN users u ON u.id = d."userId"
        WHERE d.reason = ANY($6::text[])
        GROUP BY date_trunc('minute', d."createdAt"), d.reason, d."userId", u.name
        ORDER BY at DESC, tie DESC LIMIT ${PROJECT_ACTIVITY_LIMIT}
      ), recent AS (
        SELECT * FROM audits UNION ALL SELECT * FROM dismissals
        ORDER BY at DESC, kind, tie DESC LIMIT ${PROJECT_ACTIVITY_LIMIT}
      )
      SELECT kind, at, ref, "actorName", change, added, removed, "workflowName", reason, count
      FROM owned LEFT JOIN recent ON true ORDER BY at DESC, kind, tie DESC`,
      [
        projectId,
        workspaceId,
        lifecycleActions,
        workflowChanges,
        assetChanges,
        Object.values(DismissReason),
        AuditOutcome.Success,
        AuditActorType.ApiKey,
      ],
    );
    if (rows.length === 0) throw new NotFoundException('Project not found');
    const activity: ProjectNonRunActivity[] = [];
    for (const row of rows) {
      if (row.kind === null) continue;
      const base = {
        at: row.at,
        ...(row.actorName === null ? {} : { actorName: row.actorName }),
      };
      if (row.kind === 'dismissed') {
        activity.push({
          ...base,
          kind: row.kind,
          ref: 'dismissed',
          count: row.count,
          reason: row.reason,
        });
      } else {
        activity.push({
          ...base,
          kind: row.kind,
          ref: row.ref,
          ...(row.change === null ? {} : { change: row.change }),
          ...(row.added === null ? {} : { added: row.added }),
          ...(row.removed === null ? {} : { removed: row.removed }),
          ...(row.workflowName === null
            ? {}
            : { workflowName: row.workflowName }),
        });
      }
    }
    return activity;
  }
}
