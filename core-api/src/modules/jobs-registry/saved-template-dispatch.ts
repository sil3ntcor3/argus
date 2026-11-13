import { ARTIFACT_BUCKET } from '@/common/constants/artifact-storage';
import { ArtifactFolder } from '@/modules/artifacts/entities/artifact-folder.entity';
import { WorkspaceArtifact } from '@/modules/artifacts/entities/workspace-artifact.entity';
import type { StorageService } from '@/modules/storage/storage.service';
import type { WorkspacesService } from '@/modules/workspaces/workspaces.service';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { createHash } from 'node:crypto';
import type { DataSource } from 'typeorm';
import type { GetNextJobResult } from './dto/jobs-registry.dto';

/** Private input snapshot, stripped before constructing connector inputs. */
export const SAVED_TEMPLATE_SELECTION = '__argus_saved_template_selection_v1';
export const TEMPLATE_DOWNLOAD_TTL_SECONDS = 3600;

export async function prepareSavedTemplates(
  dataSource: DataSource,
  workspaces: WorkspacesService,
  storage: StorageService,
  job: GetNextJobResult,
  config: Record<string, unknown> | undefined,
): Promise<{ config: Record<string, unknown> | undefined; scopeConfig: Record<string, unknown> | undefined }> {
  const raw = job.inputs?.[SAVED_TEMPLATE_SELECTION];
  if (raw === undefined) {
    if (config && ('customTemplateIds' in config || 'customTemplates' in config)) throw new BadRequestException('Choose saved templates through Templates');
    return { config, scopeConfig: config };
  }
  let selection: { actorId: string; ids: string[] };
  try {
    const value = JSON.parse(raw) as { actorId?: unknown; ids?: unknown };
    if (!isUUID(value.actorId) || !Array.isArray(value.ids) || !value.ids.length || value.ids.length > 100 || value.ids.some(id => !isUUID(id))) throw new Error();
    selection = { actorId: value.actorId as string, ids: [...new Set(value.ids as string[])] };
  } catch { throw new BadRequestException('Invalid saved template selection'); }
  if (job.tool?.name !== 'nuclei' || !job.workspaceId) throw new BadRequestException('Saved templates require Nuclei');
  const { permissionKeys } = await workspaces.getMembershipWithPermissions(job.workspaceId, selection.actorId);
  const allowed = permissionKeys.includes('*') || (permissionKeys.includes('vulnerability.write') && (permissionKeys.includes('artifact.read') || permissionKeys.includes('artifact.write')));
  if (!allowed) throw new ForbiddenException('Template run permission was revoked');
  const rows = await dataSource.getRepository(WorkspaceArtifact).createQueryBuilder('artifact')
    .innerJoin(ArtifactFolder, 'folder', 'folder.id = artifact.parentFolderId AND folder.workspaceId = artifact.workspaceId')
    .where('artifact.workspaceId = :workspaceId AND artifact.id IN (:...ids)', { workspaceId: job.workspaceId, ids: selection.ids })
    .andWhere("artifact.source = 'template' AND artifact.status = 'ready'")
    .andWhere("folder.name = 'custom-templates' AND folder.parentFolderId IS NULL AND folder.createdByUserId IS NULL")
    .andWhere(`(artifact."createdByUserId" = :actorId OR artifact."shareType" = 'public' OR (artifact."shareType" = 'shared' AND EXISTS (SELECT 1 FROM artifact_shares share WHERE share."artifactId" = artifact.id AND share."userId" = :actorId)))`, { actorId: selection.actorId })
    .getMany();
  const byId = new Map(rows.map(row => [row.id, row]));
  const files = selection.ids.map(id => {
    const file = byId.get(id);
    if (!file) throw new NotFoundException('A selected template is no longer available');
    return file;
  });
  // Scan identity uses immutable content, never expiring signature parameters
  // or metadata timestamps. Renaming a template keeps its content identity.
  const identities = files.map(file => ({ cacheKey: `${file.id}-${createHash('sha256').update(file.objectKey).digest('hex')}` }));
  const customTemplates = await Promise.all(files.map(async (file, index) => ({
    ...identities[index],
    url: (await storage.getTemplateWorkerDownloadUrl({ bucket: ARTIFACT_BUCKET, key: file.objectKey, expiresIn: TEMPLATE_DOWNLOAD_TTL_SECONDS })).url,
  })));
  const base = { ...config };
  delete base.customTemplateIds;
  delete base.customTemplates;
  return { config: { ...base, customTemplates }, scopeConfig: { ...base, customTemplates: identities } };
}
