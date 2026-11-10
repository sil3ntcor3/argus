import { Doc } from '@/common/doc/doc.decorator';
import { AuthGuard } from '@/common/guards/auth.guard';
import type { MessageEvent } from '@nestjs/common';
import { Controller, Req, Sse, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Observable } from 'rxjs';
import {
  EventsWorkspaceGuard,
  type EventsStreamRequest,
} from './events-workspace.guard';
import { EventsService } from './events.service';

@ApiTags('Events')
@Controller('events')
@UseGuards(AuthGuard, EventsWorkspaceGuard)
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  @Sse('stream')
  @Doc({
    summary: 'Subscribe to live events',
    description:
      'Server-Sent Events stream of the current user\'s notification pushes ' +
      'plus, when the X-Workspace-Id header is sent, the allowlisted events ' +
      'of that workspace. Each message is a JSON ClientEvent ' +
      '`{ id, type, time, resourceType, resourceId, joinKeyId? }` ' +
      '(`joinKeyId` only on `worker.joined` from a one-time join key); a `ping` event is ' +
      'sent periodically as a heartbeat.',
    request: { getWorkspaceId: true },
  })
  stream(@Req() request: EventsStreamRequest): Observable<MessageEvent> {
    return this.eventsService.stream(
      request.eventsWorkspaceId,
      request.user.id,
    );
  }
}
