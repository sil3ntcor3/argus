import { BadRequestException, ValidationPipe, type Type } from '@nestjs/common';
import { CreateProjectTriggerDto } from './dto/project-trigger-create.dto';

export class ProjectTriggerCreatePipe extends ValidationPipe {
  constructor(expectedType: Type<unknown> = CreateProjectTriggerDto) {
    super({
      expectedType,
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

/** Preserve legacy workflow-body whitelisting, but validate new on keys raw. */
export class ProjectWorkflowTriggerInputPipe extends ValidationPipe {
  constructor(expectedType: Type<unknown>) {
    super({ expectedType, transform: true, whitelist: true });
  }
  protected stripProtoKeys(value: unknown): void {
    if (value && typeof value === 'object' && Object.hasOwn(value, 'on')) {
      const reject = (item: unknown): void => {
        if (!item || typeof item !== 'object') return;
        for (const [key, child] of Object.entries(item)) {
          if (['__proto__', 'prototype', 'constructor'].includes(key))
            throw new BadRequestException('Unsupported trigger field');
          reject(child);
        }
      };
      reject((value as { on?: unknown }).on);
    }
    super.stripProtoKeys(value);
  }
}
