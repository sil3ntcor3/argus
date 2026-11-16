import { ARTIFACT_MAX_FILE_BYTES } from '@/common/constants/artifact-storage';
import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { WorkspaceStorageUsage } from './entities/workspace-storage-usage.entity';

export const ARTIFACT_WORKSPACE_QUOTA_BYTES = 1024 * 1024 * 1024;

type BalanceChange = Partial<Record<'usedBytes' | 'reservedBytes', () => string>>;

/**
 * Private byte accounting. Callers must guard the individual artifact's
 * state transition in the same transaction; a workspace balance alone
 * cannot identify which artifact owns a reservation. Lock the workspace
 * FOR KEY SHARE before touching artifact or meter rows, matching the
 * lock order of a workspace deletion and its cascading deletes.
 */
@Injectable()
export class ArtifactQuotaService {
  /** Change an override without replacing the existing byte balances. */
  async setQuota(manager: EntityManager, workspaceId: string, quotaBytes: number | null): Promise<void> {
    this.validate(manager, quotaBytes === null ? 0 : quotaBytes);
    await manager.createQueryBuilder()
      .insert()
      .into(WorkspaceStorageUsage)
      .values({ workspaceId, quotaBytes: quotaBytes === null ? null : String(quotaBytes) })
      .orUpdate(['quotaBytes', 'updatedAt'], ['workspaceId'])
      .execute();
  }

  /** Reserve bytes if used, reserved, and requested bytes fit the quota. */
  async reserve(manager: EntityManager, workspaceId: string, bytes: number): Promise<boolean> {
    this.validate(manager, bytes, ARTIFACT_MAX_FILE_BYTES);
    await manager.createQueryBuilder()
      .insert()
      .into(WorkspaceStorageUsage)
      .values({ workspaceId })
      .orIgnore()
      .execute();

    return this.tryChange(
      manager, workspaceId, bytes,
      { reservedBytes: () => '"reservedBytes" + :bytes' },
      '"usedBytes" + "reservedBytes" + :bytes <= COALESCE("quotaBytes", :defaultQuota)',
    );
  }

  /** Settle an existing reservation even if the quota was since lowered. */
  async commit(manager: EntityManager, workspaceId: string, bytes: number): Promise<boolean> {
    this.validate(manager, bytes);
    return this.tryChange(
      manager, workspaceId, bytes,
      {
        reservedBytes: () => '"reservedBytes" - :bytes',
        usedBytes: () => '"usedBytes" + :bytes',
      },
      '"reservedBytes" >= :bytes AND "usedBytes" <= :maximum - :bytes',
    );
  }

  /** Release bytes held for an abandoned upload. */
  async releaseReserved(manager: EntityManager, workspaceId: string, bytes: number): Promise<boolean> {
    this.validate(manager, bytes);
    return this.tryChange(
      manager, workspaceId, bytes,
      { reservedBytes: () => '"reservedBytes" - :bytes' },
      '"reservedBytes" >= :bytes',
    );
  }

  /** Release used bytes after deleting a stored artifact. */
  async releaseUsed(manager: EntityManager, workspaceId: string, bytes: number): Promise<boolean> {
    this.validate(manager, bytes);
    return this.tryChange(
      manager, workspaceId, bytes,
      { usedBytes: () => '"usedBytes" - :bytes' },
      '"usedBytes" >= :bytes',
    );
  }

  private validate(manager: EntityManager, bytes: number, maximum = Number.MAX_SAFE_INTEGER): void {
    if (!manager.queryRunner?.isTransactionActive) {
      throw new Error('Artifact quota updates require an active transaction');
    }
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maximum) {
      throw new RangeError('Invalid artifact byte count');
    }
  }

  /** PostgreSQL checks the condition under the same row lock as the update. */
  private async tryChange(
    manager: EntityManager,
    workspaceId: string,
    bytes: number,
    change: BalanceChange,
    condition: string,
  ): Promise<boolean> {
    const result = await manager.createQueryBuilder()
      .update(WorkspaceStorageUsage)
      .set(change)
      .where('"workspaceId" = :workspaceId', { workspaceId })
      .andWhere(condition, {
        bytes,
        defaultQuota: ARTIFACT_WORKSPACE_QUOTA_BYTES,
        maximum: Number.MAX_SAFE_INTEGER,
      })
      .execute();
    return result.affected === 1;
  }
}
