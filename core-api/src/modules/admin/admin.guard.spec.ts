import { requestClientIp } from '@/common/config/trusted-proxies';
import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';
import type { SystemConfigsService } from './system-configs/system-configs.service';

jest.mock('@/common/config/trusted-proxies', () => ({
  requestClientIp: jest.fn(),
}));

describe('AdminGuard', () => {
  const policy = { isAdminIpAllowed: jest.fn() };
  const guard = new AdminGuard(
    policy as unknown as SystemConfigsService,
    new Reflector(),
  );
  const context = (
    handler: (...args: never[]) => unknown = AdminController.prototype
      .createTool,
  ) =>
    ({
      getHandler: () => handler,
      switchToHttp: () => ({ getRequest: () => ({ headers: {}, socket: {} }) }),
    }) as unknown as ExecutionContext;
  beforeEach(() => jest.clearAllMocks());

  it('uses the trusted-proxy resolver and reads the live policy on every request', async () => {
    jest.mocked(requestClientIp).mockReturnValue('203.0.113.7');
    policy.isAdminIpAllowed
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    await expect(guard.canActivate(context())).resolves.toBe(true);
    await expect(guard.canActivate(context())).rejects.toThrow(
      ForbiddenException,
    );
    expect(policy.isAdminIpAllowed).toHaveBeenNthCalledWith(2, '203.0.113.7');
  });

  it('leaves public first-admin protection to its existing controller/service', async () => {
    await expect(
      guard.canActivate(context(AdminController.prototype.createFirstAdmin)),
    ).resolves.toBe(true);
    expect(policy.isAdminIpAllowed).not.toHaveBeenCalled();
  });

  it('propagates a failed policy read without granting access', async () => {
    policy.isAdminIpAllowed.mockRejectedValueOnce(
      new Error('database unavailable'),
    );
    await expect(guard.canActivate(context())).rejects.toThrow(
      'database unavailable',
    );
  });
});
