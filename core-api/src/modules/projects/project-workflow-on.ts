import { isValidCronSchedule } from '../asset-group/dto/cron-schedule.validator';
import {
  PROJECT_TRIGGER_EVENTS,
  type ProjectTriggerConfigDto,
  type ProjectTriggerDto,
} from './dto/project-trigger-read.dto';
import {
  eventConfigProblems,
  isTriggerEvent,
  normalizeEventConfig,
} from './project-trigger-config';

type TriggerEvent = NonNullable<ProjectTriggerDto['event']>;
export type DefinedTrigger =
  | { key: string; type: 'cron'; cron: string }
  | {
      key: string;
      type: 'event';
      event: TriggerEvent;
      config: ProjectTriggerConfigDto;
    };
export type ProjectWorkflowOn = { schedule?: { cron: string }[] } & Partial<
  Record<TriggerEvent, ProjectTriggerConfigDto>
>;
export class WorkflowOnError extends Error {
  constructor(readonly errors: string[]) {
    super(errors.join('; '));
  }
}
export const normalizeCron = (value: string) =>
  value.trim().replace(/\s+/g, ' ');
export const cronKey = (value: string) => `cron:${normalizeCron(value)}`;
export const eventKey = (event: TriggerEvent) => `event:${event}`;

/** Parses project definitions only; legacy workspace target settings stay with the caller. */
export function triggersOfOn(on: unknown): DefinedTrigger[] {
  if (!on || typeof on !== 'object') return [];
  const block = on as Record<string, unknown>,
    errors: string[] = [],
    triggers: DefinedTrigger[] = [];
  const keys = new Set<string>();
  const schedules: unknown[] =
    block.schedule === undefined
      ? []
      : Array.isArray(block.schedule)
        ? block.schedule
        : [block.schedule];
  schedules.forEach((entry, index) => {
    const raw =
      entry && typeof entry === 'object'
        ? (entry as { cron?: unknown }).cron
        : entry;
    const cron = typeof raw === 'string' ? normalizeCron(raw) : '';
    if (cron === 'disabled' || !isValidCronSchedule(cron)) {
      errors.push(
        `on.schedule[${index}]: must be a valid 5-field cron expression`,
      );
      return;
    }
    const key = cronKey(cron);
    if (!keys.has(key)) {
      keys.add(key);
      triggers.push({ key, type: 'cron', cron });
    }
  });
  for (const event of PROJECT_TRIGGER_EVENTS) {
    const value = block[event];
    if (value === undefined || value === false) continue;
    const raw = value === true ? {} : value;
    const problems = eventConfigProblems(event, raw);
    if (problems.length) {
      errors.push(...problems.map((p) => `on.${event}: ${p}`));
      continue;
    }
    triggers.push({
      key: eventKey(event),
      type: 'event',
      event,
      config: normalizeEventConfig(event, raw as ProjectTriggerConfigDto),
    });
  }
  for (const key of Object.keys(block)) {
    if (key !== 'schedule' && key !== 'target' && !isTriggerEvent(key))
      errors.push(
        `on.${key}: unknown trigger (schedule, ${PROJECT_TRIGGER_EVENTS.join(', ')})`,
      );
  }
  if (errors.length) throw new WorkflowOnError(errors);
  return triggers;
}

/** Canonicalizes validated definitions without sharing mutable settings with them. */
export function onOfTriggers(
  triggers: readonly DefinedTrigger[],
): ProjectWorkflowOn | undefined {
  const on: ProjectWorkflowOn = {};
  const schedule = triggers.flatMap((trigger) =>
    trigger.type === 'cron' ? [{ cron: normalizeCron(trigger.cron) }] : [],
  );
  if (schedule.length) on.schedule = schedule;
  for (const event of PROJECT_TRIGGER_EVENTS) {
    const trigger = triggers.find(
      (t) => t.type === 'event' && t.event === event,
    );
    if (trigger?.type === 'event')
      on[event] = normalizeEventConfig(event, trigger.config);
  }
  return Object.keys(on).length ? on : undefined;
}
