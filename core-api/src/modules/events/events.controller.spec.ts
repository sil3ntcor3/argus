import type { WorkspacesService } from '@/modules/workspaces/workspaces.service';
import type { ExecutionContext } from '@nestjs/common';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { EMPTY } from 'rxjs';
import {
  EventsWorkspaceGuard,
  type EventsStreamRequest,
} from './events-workspace.guard';
import { EventsController } from './events.controller';
import type { EventsService } from './events.service';

jest.mock('better-auth/node', () => ({
  fromNodeHeaders: jest.fn(),
}));

const WORKSPACE_ID = '0b9a5e4e-6a1f-4f7e-9d4c-2f2b8d1c3a10';

function request(
  headers: Record<string, string> = {},
  cookies: Record<string, string> = {},
): EventsStreamRequest {
  return { headers, cookies, user: { id: 'user-1' } } as EventsStreamRequest;
}

function context(req: EventsStreamRequest) {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as ExecutionContext;
}

describe('EventsController', () => {
  let eventsService: { stream: jest.Mock };
  let workspacesService: { getMembershipWithPermissions: jest.Mock };
  let controller: EventsController;
  let guard: EventsWorkspaceGuard;

  beforeEach(() => {
    eventsService = { stream: jest.fn().mockReturnValue(EMPTY) };
    workspacesService = {
      getMembershipWithPermissions: jest.fn().mockResolvedValue({}),
    };
    controller = new EventsController(
      eventsService as unknown as EventsService,
    );
    guard = new EventsWorkspaceGuard(
      workspacesService as unknown as WorkspacesService,
    );
  });

  it('streams the workspace from the header after checking membership', async () => {
    const req = request({ 'x-workspace-id': WORKSPACE_ID });
    await expect(guard.canActivate(context(req))).resolves.toBe(true);
    controller.stream(req);

    expect(workspacesService.getMembershipWithPermissions).toHaveBeenCalledWith(
      WORKSPACE_ID,
      'user-1',
    );
    expect(eventsService.stream).toHaveBeenCalledWith(WORKSPACE_ID, 'user-1');
  });

  it('ignores the shared wid cookie and streams notifications only', async () => {
    const req = request({}, { wid: WORKSPACE_ID });
    await expect(guard.canActivate(context(req))).resolves.toBe(true);
    controller.stream(req);

    expect(workspacesService.getMembershipWithPermissions).not.toHaveBeenCalled();
    expect(eventsService.stream).toHaveBeenCalledWith(undefined, 'user-1');
  });

  it('rejects non-members with 403', async () => {
    workspacesService.getMembershipWithPermissions.mockRejectedValue(
      new NotFoundException(),
    );

    await expect(
      guard.canActivate(context(request({ 'x-workspace-id': WORKSPACE_ID }))),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(eventsService.stream).not.toHaveBeenCalled();
  });

  it('rejects a malformed workspace id with 400', async () => {
    await expect(
      guard.canActivate(context(request({ 'x-workspace-id': 'nope' }))),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('requires an authenticated user even for notification-only streams', async () => {
    const req = { headers: {} } as EventsStreamRequest;
    await expect(guard.canActivate(context(req))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(workspacesService.getMembershipWithPermissions).not.toHaveBeenCalled();
  });
});
