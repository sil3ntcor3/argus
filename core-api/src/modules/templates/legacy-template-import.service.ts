import { WorkspaceArtifact } from '@/modules/artifacts/entities/workspace-artifact.entity';
import { StorageService } from '@/modules/storage/storage.service';
import { WorkspaceMembers } from '@/modules/workspaces/entities/workspace-members.entity';
import { BadRequestException, Injectable, PayloadTooLargeException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Template } from './entities/templates.entity';
import { readTemplateContent } from './read-template-content';
import { TemplateArtifactService } from './template-artifact.service';
import { validateTemplate } from './template-validation';

export type LegacyImportResult = { id: string; workspaceId: string; status: string };

/** Explicit maintenance import, never a startup/read side effect. Originals stay intact. */
@Injectable()
export class LegacyTemplateImportService {
  constructor(private readonly dataSource: DataSource, private readonly storage: StorageService, private readonly writer: TemplateArtifactService) {}

  async run({ workspaceId, apply = false }: { workspaceId?: string; apply?: boolean }): Promise<LegacyImportResult[]> {
    const results: LegacyImportResult[] = [];
    // Bound memory and keep IDs in stable order across restarts.
    let after: string | undefined;
    for (;;) {
      const query = this.dataSource.getRepository(Template).createQueryBuilder('legacy')
        .leftJoinAndSelect('legacy.workspace', 'workspace').leftJoinAndSelect('workspace.owner', 'owner')
        .orderBy('legacy.id', 'ASC').take(100);
      if (workspaceId) query.andWhere('workspace.id = :workspaceId', { workspaceId });
      if (after) query.andWhere('legacy.id > :after', { after });
      const rows = await query.getMany();
      if (!rows.length) return results;
      for (const row of rows) {
        const result = { id: row.id, workspaceId: row.workspace?.id ?? '', status: 'unavailable' };
        await this.dataSource.transaction(async manager => {
          // Two importers can run concurrently; this is independent of the
          // workspace/file/meter locks taken by the writer's own transaction.
          const [lock] = await manager.query<{ locked: boolean }[]>('SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked', [`argus-template-import:${row.id}`]);
          if (!lock?.locked) { result.status = 'busy'; return; }
          const ownerId = row.workspace?.owner?.id;
          if (!ownerId || !await manager.getRepository(WorkspaceMembers).existsBy({ workspace: { id: row.workspace.id }, user: { id: ownerId } })) { result.status = 'owner_unavailable'; return; }
          if (row.path !== `nuclei-templates/${row.id}.yaml`) { result.status = 'unsupported_path'; return; }
          let content: string;
          try {
            if (row.fileName !== row.fileName.trim()) throw new BadRequestException('Legacy name needs review');
            validateTemplate(row.fileName);
            content = await readTemplateContent(this.storage, 'nuclei-templates', `${row.id}.yaml`);
          } catch (error) {
            result.status = error instanceof BadRequestException || error instanceof PayloadTooLargeException ? 'invalid' : 'unavailable';
            return;
          }
          const digest = createHash('sha256').update(content).digest('hex');
          const existing = await manager.getRepository(WorkspaceArtifact).findOneBy({ id: row.id });
          if (existing) {
            const imported = existing.metadata.argusLegacyTemplate as { id?: unknown; digest?: unknown; name?: unknown } | undefined;
            result.status = imported?.id !== row.id || existing.workspaceId !== row.workspace.id || existing.source !== 'template'
              ? 'identity_conflict' : imported.digest !== digest || imported.name !== row.fileName ? 'source_changed' : existing.status === 'ready' ? 'already_imported' : 'pending_recovery';
            return;
          }
          if (await this.storage.hasLegacyTemplateImport(row.workspace.id, row.id)) { result.status = 'previous_import_attempt'; return; }
          if (!apply) { result.status = 'eligible'; return; }
          try {
            // Claim before publishing a ready artifact. The marker survives
            // user deletion, so later maintenance cannot resurrect that ID.
            // Failed attempts require operator review, never a blind retry.
            if (!await this.storage.claimLegacyTemplateImport(row.workspace.id, row.id, digest)) {
              result.status = 'previous_import_attempt'; return;
            }
            await this.writer.create({ workspaceId: row.workspace.id, userId: ownerId, name: row.fileName, content, legacyImport: { id: row.id, digest } });
            result.status = 'imported';
          } catch { result.status = 'write_failed'; }
        });
        results.push(result);
      }
      after = rows.at(-1)!.id;
    }
  }
}
