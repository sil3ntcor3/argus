import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { projectFindingSavedScanCondition } from './project-finding-provenance';
import { ProjectFindingReadService } from './project-finding-read.service';

export enum ProjectTimelineSighting {
  SEEN = 'seen',
  MISSED = 'missed',
  UNKNOWN = 'unknown',
}

interface ProjectTimelineRun {
  id: string;
  createdAt: Date;
  workflowName: string;
  sighting: ProjectTimelineSighting;
}

@Injectable()
export class ProjectFindingTimelineService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly findings: ProjectFindingReadService,
  ) {}

  async read(projectId: string, workspaceId: string, findingId: string) {
    // The run window and sightings must describe the same saved finding.
    return this.dataSource.transaction('REPEATABLE READ', async (manager) => {
      const vulnerability = await this.findings.get(
        projectId,
        workspaceId,
        findingId,
        manager,
      );
      const { firstSeen, lastSeen } = vulnerability;
      const pointers = [firstSeen.runId, lastSeen.runId].filter(
        (id) => id !== null,
      );
      // Exact observations and valid legacy pointers are evidence even if the
      // reporting job is gone. Other runs need a completed vulnerability scan.
      const runs = await manager.query<ProjectTimelineRun[]>(
        `WITH linked AS MATERIALIZED (
          SELECT pv.id, v."assetId", v."toolId",
                 COALESCE(first_run."createdAt", pv."firstSeenAt" AT TIME ZONE 'UTC') AS first_at,
                 COALESCE(last_run."createdAt", pv."lastSeenAt" AT TIME ZONE 'UTC') AS last_at
          FROM project_vulnerabilities pv
          JOIN projects p ON p.id = pv."projectId" AND p."workspaceId" = $2
          JOIN vulnerabilities v ON v.id = pv."vulnerabilityId" AND v."reviewStatus"='approved'
          JOIN assets a ON a.id = v."assetId"
          JOIN targets t ON t.id = a."targetId" AND t."workspaceId" = $2
          LEFT JOIN job_histories first_run ON first_run.id = $4 AND first_run."projectId" = p.id
          LEFT JOIN job_histories last_run ON last_run.id = $5 AND last_run."projectId" = p.id
          WHERE pv."projectId" = $1 AND pv."vulnerabilityId" = $3
        ), confirmed AS MATERIALIZED (
          SELECT h.id, h."createdAt"
          FROM linked
          CROSS JOIN LATERAL (
            SELECT o."jobHistoryId" AS id FROM project_vulnerability_observations o
            WHERE o."projectVulnerabilityId" = linked.id
            UNION SELECT unnest($6::uuid[])
          ) evidence
          JOIN job_histories h ON h.id = evidence.id AND h."projectId" = $1
          JOIN workflows w ON w.id = h."workflowId" AND w."workspaceId" = $2
        ), bounds AS (
          SELECT linked.*, LEAST(linked.first_at, starts.first_at) AS first_scan,
                 GREATEST(linked.last_at, starts.last_at) AS last_scan
          FROM linked CROSS JOIN (
            SELECT MIN("createdAt") AS first_at, MAX("createdAt") AS last_at FROM confirmed
          ) starts
        )
        SELECT h.id, h."createdAt", w.name AS "workflowName",
               CASE WHEN seen.id IS NOT NULL THEN '${ProjectTimelineSighting.SEEN}'
                    WHEN h."createdAt" > bounds.last_scan THEN '${ProjectTimelineSighting.MISSED}'
                    ELSE '${ProjectTimelineSighting.UNKNOWN}' END AS sighting
        FROM bounds
        JOIN job_histories h ON h."projectId" = $1
        JOIN workflows w ON w.id = h."workflowId" AND w."workspaceId" = $2
        LEFT JOIN confirmed seen ON seen.id = h.id
        WHERE seen.id IS NOT NULL OR (
          h."createdAt" >= bounds.first_scan AND EXISTS (
            SELECT 1 FROM jobs j
            WHERE j."jobHistoryId" = h.id
              AND j."assetId" = bounds."assetId" AND j."toolId" = bounds."toolId"
              AND ${projectFindingSavedScanCondition('j')}
          )
        )
        ORDER BY h."createdAt", h.id`,
        [
          projectId,
          workspaceId,
          findingId,
          firstSeen.runId,
          lastSeen.runId,
          pointers,
        ],
      );
      return { vulnerability, runs };
    });
  }
}
