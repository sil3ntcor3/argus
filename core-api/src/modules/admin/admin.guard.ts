import { requestClientIp } from '@/common/config/trusted-proxies';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { IncomingMessage } from 'node:http';
import { SystemConfigsService } from './system-configs/system-configs.service';

/** Additional IP restriction, after the global authentication and role guard. */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly configs: SystemConfigsService,
    private readonly reflector: Reflector,
  ) {}

  /** Keep public bootstrap protection in its existing first-admin service. */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.get<boolean>('PUBLIC', context.getHandler()))
      return true;
    const request = context.switchToHttp().getRequest<IncomingMessage>();
    if (await this.configs.isAdminIpAllowed(requestClientIp(request)))
      return true;
    throw new ForbiddenException(
      'Admin access is not allowed from this IP address',
    );
  }
}
