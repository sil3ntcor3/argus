import { ForbiddenException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type { IssueLinkResourceType } from '@/common/enums/enum';

const domains: Record<IssueLinkResourceType, string> = {
  vulnerability: 'vulnerability', asset: 'asset', target: 'target', project: 'project', job_history: 'job',
};

/** Public callers pass the actor; omitted actors are internal service reads. */
export async function issueReadPermissions(db: Pick<DataSource, 'query'>, workspaceId: string, userId?: string): Promise<string[]> {
  if (!userId) return ['*'];
  const rows = await db.query<{ permissions: string[] }[]>(`SELECT permission.permissions FROM workspace_members member
    JOIN workspace_member_permissions assignment ON assignment."memberId"=member.id
    JOIN workspace_permissions permission ON permission.id=assignment."permissionId" AND permission."workspaceId"=member."workspaceId"
    WHERE member."workspaceId"=$1 AND member."userId"=$2`, [workspaceId, userId]);
  const keys = [...new Set(rows.flatMap(row => row.permissions ?? []))];
  if (!keys.some(key => ['*', 'workspace.read', 'workspace.write'].includes(key))) throw new ForbiddenException('Requires workspace.read');
  return keys;
}

/** Domain writes imply reads, matching the selected-workspace guard. */
export function canReadIssueResource(keys: string[], type: IssueLinkResourceType): boolean {
  return keys.some(key => key === '*' || key === domains[type] + '.read' || key === domains[type] + '.write');
}

export function assertIssueResourceRead(keys: string[], types: IssueLinkResourceType[]): void {
  if (types.some(type => !canReadIssueResource(keys, type))) throw new ForbiddenException('Reading linked resources requires their domain read permission');
}
