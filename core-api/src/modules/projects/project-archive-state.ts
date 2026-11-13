import { BadRequestException } from '@nestjs/common';

/** Existing private scheduler storage also fences deliveries across archive cycles. */
export const ARCHIVE_PENDING = 'project-archive-pending:';
export const INACTIVE_TRIGGER = 'project-trigger-inactive:';
export const EVENT_EPOCH = 'project-event-epoch:';

export function triggerEpoch(
  schedulerId: string | null | undefined,
): string | undefined {
  if (
    !schedulerId ||
    ![ARCHIVE_PENDING, INACTIVE_TRIGGER, EVENT_EPOCH, 'project-trigger:'].some(
      (prefix) => schedulerId.startsWith(prefix),
    )
  )
    return;
  const tail = schedulerId.slice(schedulerId.lastIndexOf(':') + 1);
  // The old cron key ends in the trigger ID; only generated keys have a second UUID.
  if (
    schedulerId.startsWith('project-trigger:') &&
    schedulerId.split(':').length !== 3
  )
    return;
  return /^(?:\d{13,16}\.)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    tail,
  )
    ? tail
    : undefined;
}

export function triggerCutoff(
  schedulerId: string | null | undefined,
): number | undefined {
  const epoch = triggerEpoch(schedulerId);
  return epoch?.includes('.') ? Number(epoch.split('.')[0]) : undefined;
}

export class ProjectArchivedException extends BadRequestException {
  constructor() {
    super('Project is archived');
  }
}
