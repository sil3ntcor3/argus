import { ARTIFACT_MAX_FILE_BYTES } from '@/common/constants/artifact-storage';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Tool } from 'ai';
import { z } from 'zod';
import { defineTool, failSoft } from './helpers';
import type { Deps } from './types';

/** Conversation identity comes from the authenticated caller. */
export function artifactTools(
  deps: Deps<'artifactBufferService' | 'workspacesService'>,
  workspaceId: string,
  userId: string,
): Record<string, Tool> {
  return {
    save_file: defineTool({
      description: 'Save a private UTF-8 text file to your workspace Files. Use for reports, notes, scripts or exports up to 50 MiB.',
      inputSchema: z.object({
        fileName: z.string().min(1).max(255),
        content: z.string().max(ARTIFACT_MAX_FILE_BYTES),
        mimeType: z.string().max(255).optional().default('text/plain'),
      }),
      execute: (params: { fileName: string; content: string; mimeType?: string }, { abortSignal }) =>
        failSoft('save file', async () => {
          abortSignal?.throwIfAborted();
          const { permissionKeys } = await deps.workspacesService.getMembershipWithPermissions(workspaceId, userId);
          if (!permissionKeys.includes('*') && !permissionKeys.includes('artifact.write')) {
            throw new ForbiddenException('Requires artifact.write');
          }
          abortSignal?.throwIfAborted();
          if (Buffer.byteLength(params.content, 'utf8') > ARTIFACT_MAX_FILE_BYTES) {
            throw new BadRequestException('File exceeds the 50 MiB limit');
          }
          const file = await deps.artifactBufferService.createAgentFile({
            workspaceId, userId, name: params.fileName, buffer: Buffer.from(params.content, 'utf8'),
            contentType: params.mimeType ?? 'text/plain', abortSignal,
          });
          return { success: true, id: file.id, name: file.name, sizeBytes: Number(file.sizeBytes), message: 'File saved to workspace Files.' };
        }),
    }),
  };
}
