import { WorkspaceMembers } from '@/modules/workspaces/entities/workspace-members.entity';
import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import type { AddArtifactSharesResultDto } from './dto/artifact-share.dto';
import { ArtifactShare } from './entities/artifact-share.entity';
import { WorkspaceArtifact } from './entities/workspace-artifact.entity';

@Injectable()
export class ArtifactShareService {
  constructor(private readonly dataSource: DataSource) {}

  addShares(workspaceId: string, userId: string, id: string, emails: string[]): Promise<AddArtifactSharesResultDto> {
    const distinctEmails = [...new Set(emails)];
    return this.dataSource.transaction(async manager => {
      const artifact = await this.lockOwnedFile(manager, workspaceId, userId, id);
      if (!distinctEmails.length) return { shared: 0, skipped: 0 };

      const recipients = await manager.getRepository(WorkspaceMembers)
        .createQueryBuilder('member')
        .innerJoin('member.user', 'recipient')
        .select('recipient.id', 'id')
        .distinct(true)
        .where('member.workspaceId = :workspaceId', { workspaceId })
        .andWhere('recipient.id <> :userId', { userId })
        .andWhere('recipient.email IN (:...distinctEmails)', { distinctEmails })
        .getRawMany<{ id: string }>();

      if (recipients.length) {
        await manager.createQueryBuilder()
          .insert()
          .into(ArtifactShare)
          .values(recipients.map(recipient => ({ artifactId: artifact.id, userId: recipient.id })))
          .orIgnore()
          .execute();
      }
      return { shared: recipients.length, skipped: distinctEmails.length - recipients.length };
    });
  }

  removeShare(workspaceId: string, userId: string, id: string, recipientId: string): Promise<{ message: string }> {
    return this.dataSource.transaction(async manager => {
      const artifact = await this.lockOwnedFile(manager, workspaceId, userId, id);
      await manager.delete(ArtifactShare, { artifactId: artifact.id, userId: recipientId });
      return { message: 'Share removed' };
    });
  }

  private async lockOwnedFile(manager: EntityManager, workspaceId: string, userId: string, id: string) {
    // Serialize share changes with deletion and each other.
    const artifact = await manager.findOne(WorkspaceArtifact, {
      where: { id, workspaceId, createdByUserId: userId, status: 'ready' },
      select: { id: true },
      lock: { mode: 'pessimistic_write' },
    });
    if (!artifact) throw new NotFoundException('File not found');
    return artifact;
  }
}
