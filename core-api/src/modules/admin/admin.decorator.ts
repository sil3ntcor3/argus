import { Roles } from '@/common/decorators/app.decorator';
import { Role } from '@/common/enums/enum';
import { applyDecorators, UseGuards } from '@nestjs/common';
import { AdminGuard } from './admin.guard';

/** Require a platform administrator and the current administration IP policy. */
export const Admin = () =>
  applyDecorators(Roles(Role.ADMIN), UseGuards(AdminGuard));
