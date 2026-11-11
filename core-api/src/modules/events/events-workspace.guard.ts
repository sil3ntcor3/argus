import { WORKSPACE_HEADER_NAME } from '@/common/constants/app.constants';
import type { RequestWithMetadata } from '@/common/interfaces/app.interface';
import { WorkspacesService } from '@/modules/workspaces/workspaces.service';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';

export type EventsStreamRequest = RequestWithMetadata & {
  eventsWorkspaceId?: string;
};

@Injectable()
export class EventsWorkspaceGuard implements CanActivate {
  constructor(private readonly workspaces: WorkspacesService) {}

  /** Finish membership checks before Nest can commit the SSE response headers. */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<EventsStreamRequest>();
    if (!request.user?.id) throw new UnauthorizedException();

    // The wid cookie is shared across tabs. A missing header means this stream
    // receives only user notifications, regardless of the cookie.
    const header = request.headers[WORKSPACE_HEADER_NAME.toLowerCase()];
    const workspaceId = Array.isArray(header) ? header[0] : header;
    if (!workspaceId) return true;
    if (!isUUID(workspaceId)) {
      throw new BadRequestException('Workspace id null or invalid');
    }

    try {
      await this.workspaces.getMembershipWithPermissions(
        workspaceId,
        request.user.id,
      );
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw new ForbiddenException(
          'You do not have permission to perform this action',
        );
      }
      throw error;
    }
    request.eventsWorkspaceId = workspaceId;
    return true;
  }
}
