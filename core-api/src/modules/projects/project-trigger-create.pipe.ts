import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { CreateProjectTriggerDto } from './dto/project-trigger-create.dto';

export class ProjectTriggerCreatePipe extends ValidationPipe {
  constructor() {
    super({
      expectedType: CreateProjectTriggerDto,
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    });
  }
  // Reject unsupported own keys before Nest can silently discard them.
  protected stripProtoKeys(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key))
        throw new BadRequestException('Unsupported trigger field');
      this.stripProtoKeys(child);
    }
  }
}
