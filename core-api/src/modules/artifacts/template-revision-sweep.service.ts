import { workspaceArtifactKey, workspaceArtifactRevisionKey } from '@/common/constants/artifact-storage';
import { StorageService } from '@/modules/storage/storage.service';
import { Workspace } from '@/modules/workspaces/entities/workspace.entity';
import { Lock } from '@/services/redis/lock.decorator';
import { RedisService } from '@/services/redis/redis.service';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { isUUID } from 'class-validator';
import { DataSource, In, type EntityManager } from 'typeorm';
import { WorkspaceArtifact } from './entities/workspace-artifact.entity';
import { readTemplateRetirements, TEMPLATE_RETIREMENTS_KEY, type TemplateRetirements } from './template-retirements';

export const TEMPLATE_REVISION_GRACE_MS = 15 * 60_000;
export const TEMPLATE_REVISION_CURSOR = 'artifacts:template-revisions:cursor:v1';
type Candidate = { key: string; workspaceId: string; artifactId: string; revision: boolean; modified: Date };

@Injectable()
export class TemplateRevisionSweepService {
  private readonly logger = new Logger(TemplateRevisionSweepService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    private readonly redis: RedisService,
  ) {}

  @Cron('45 */2 * * * *', { name: 'template-revision-sweep', waitForCompletion: true })
  @Lock('cron:template-revision-sweep', { ttl: 60_000 })
  async run(): Promise<void> {
    const [clock] = await this.dataSource.query<{ cutoff: Date }[]>(
      "SELECT clock_timestamp() - ($1::bigint * interval '1 millisecond') AS cutoff", [TEMPLATE_REVISION_GRACE_MS],
    );
    await this.sweepPage(clock.cutoff);
  }

  async sweepPage(cutoff: Date): Promise<void> {
    const cursor = await this.redis.get(TEMPLATE_REVISION_CURSOR);
    const { objects, nextKey } = await this.storage.listArtifactSweepPage(cursor ?? undefined);
    const candidates = objects.flatMap(({ Key: key, LastModified: modified }) => {
      if (!key || !modified) return [];
      const [prefix, workspaceId, artifactId, kind, revisionId] = key.split('/');
      if (prefix !== 'workspaces' || !isUUID(workspaceId) || !isUUID(artifactId)) return [];
      const canonical = kind === 'file' && key === workspaceArtifactKey(workspaceId, artifactId);
      const revision = kind === 'revisions' && isUUID(revisionId) && key === workspaceArtifactRevisionKey(workspaceId, artifactId, revisionId);
      return canonical || revision ? [{ key, workspaceId, artifactId, revision, modified }] : [];
    });

    const deadline = performance.now() + 30_000;
    let resumeKey = nextKey;
    let visitedKey: string | undefined;
    for (const workspaceId of [...new Set(candidates.map(row => row.workspaceId))].sort()) {
      if (visitedKey && performance.now() >= deadline) {
        resumeKey = visitedKey;
        break;
      }
      const group = candidates.filter(row => row.workspaceId === workspaceId).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
      try {
        await this.dataSource.transaction(manager => this.cleanWorkspace(manager, workspaceId, group, cutoff));
      } catch (error: unknown) {
        this.logger.warn(`Template cleanup will retry workspace ${workspaceId}`, error);
      }
      visitedKey = group.at(-1)?.key;
    }
    if (resumeKey) await this.redis.set(TEMPLATE_REVISION_CURSOR, resumeKey);
    else await this.redis.del(TEMPLATE_REVISION_CURSOR);
  }

  private async cleanWorkspace(manager: EntityManager, workspaceId: string, group: Candidate[], cutoff: Date): Promise<void> {
    // Writers hold KEY SHARE before object writes. Skip active publishers,
    // including a paused request with an uncommitted new revision.
    const workspace = await manager.findOne(Workspace, {
      where: { id: workspaceId }, select: { id: true },
      lock: { mode: 'pessimistic_write', onLocked: 'skip_locked' },
    });
    if (!workspace) return; // Existing audited workspace cleanup owns cascades.
    const [clock] = await manager.query<{ now: Date }[]>('SELECT clock_timestamp() AS now');
    const observedAt = clock.now.toISOString();
    const rows = await manager.find(WorkspaceArtifact, {
      where: { workspaceId, id: In(group.map(row => row.artifactId)) },
      select: { id: true, source: true, objectKey: true, metadata: true, status: true },
    });
    const byId = new Map(rows.map(row => [row.id, row]));
    type State = { row: WorkspaceArtifact; retired: TemplateRetirements; dirty: boolean };
    const states = new Map<string, State>();
    for (const row of rows) {
      const retired = readTemplateRetirements(row.metadata);
      if (row.source === 'template' && row.status === 'ready' && retired) states.set(row.id, { row, retired, dirty: false });
    }
    for (const candidate of group) {
      const state = states.get(candidate.artifactId);
      if (!state || state.row.objectKey === candidate.key) continue;
      const suffix = candidate.key.split('/').at(-1)!;
      if (!(suffix in state.retired)) state.retired[suffix] = null;
    }
    const removable = new Map<string, { state: State; suffix: string } | null>();
    for (const state of states.values()) {
      for (const [suffix, time] of Object.entries(state.retired)) {
        const key = suffix === 'file' ? workspaceArtifactKey(workspaceId, state.row.id)
          : workspaceArtifactRevisionKey(workspaceId, state.row.id, suffix);
        if (key === state.row.objectKey) continue;
        // Start grace only after observing the committed pointer change. New
        // edits preserve earlier retirement times instead of postponing them.
        if (time === null) {
          state.retired[suffix] = observedAt;
          state.dirty = true;
        } else if (new Date(time) < cutoff && removable.size < 500) {
          removable.set(key, { state, suffix });
        }
      }
    }
    const missing = group.filter(row => row.revision && row.modified < cutoff && !byId.has(row.artifactId));
    const deleted = missing.length ? await manager.query<{ resourceId: string }[]>(
      `SELECT DISTINCT "resourceId" FROM audit_events
       WHERE "workspaceId" = $1 AND "resourceId"::text = ANY($2::text[])
         AND "resourceType" = 'artifact' AND action = 'artifact.deleted' AND outcome = 'success'`,
      [workspaceId, missing.map(row => row.artifactId)],
    ) : [];
    const deletedIds = new Set(deleted.map(row => row.resourceId));
    for (const candidate of missing) {
      if (deletedIds.has(candidate.artifactId) && removable.size < 500) removable.set(candidate.key, null);
    }
    if (removable.size) {
      const failed = new Set(await this.storage.deleteArtifactSweepFailures([...removable.keys()]));
      for (const [key, record] of removable) {
        if (record && !failed.has(key)) {
          delete record.state.retired[record.suffix];
          record.state.dirty = true;
        }
      }
      if (failed.size) this.logger.warn(`${failed.size} retired template object(s) await cleanup retry`);
    }
    for (const { row, retired, dirty } of states.values()) {
      if (dirty) await manager.update(WorkspaceArtifact, { id: row.id, workspaceId }, {
        metadata: { ...row.metadata, [TEMPLATE_RETIREMENTS_KEY]: retired }, updatedAt: () => '"updatedAt"',
      });
    }
  }
}
