import type {
  ProjectTriggerConfigDto,
  ProjectTriggerDto,
} from './dto/project-trigger-read.dto';
import { isTriggerEvent } from './project-trigger-config';
import {
  cronKey,
  eventKey,
  triggersOfOn,
  WorkflowOnError,
  type DefinedTrigger,
} from './project-workflow-on';

type TriggerEvent = NonNullable<ProjectTriggerDto['event']>;
export type EventTriggerInput = Partial<ProjectTriggerConfigDto> & {
  event: TriggerEvent;
  enabled?: boolean;
};
export interface WorkflowOnInput {
  schedule?: readonly { cron: string; enabled?: boolean }[];
  events?: readonly EventTriggerInput[];
}

function validateInput(input: WorkflowOnInput): void {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new WorkflowOnError(['on must be an editor-input mapping']);
  const errors: string[] = [];
  for (const key of Object.keys(input))
    if (key !== 'schedule' && key !== 'events')
      errors.push(`on.${key}: unknown input field`);
  for (const [key, entries] of [
    ['schedule', input.schedule],
    ['events', input.events],
  ] as const) {
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) {
      errors.push(`on.${key}: must be a list`);
      continue;
    }
    entries.forEach((entry: unknown, index) => {
      const path = `on.${key}[${index}]`;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        errors.push(`${path}: must be a mapping`);
        return;
      }
      const data = entry as Record<string, unknown>;
      if (data.enabled !== undefined && typeof data.enabled !== 'boolean')
        errors.push(`${path}.enabled: must be a boolean`);
      if (key === 'events' && !isTriggerEvent(data.event))
        errors.push(`${path}.event: unknown trigger event`);
      if (key === 'schedule')
        for (const field of Object.keys(data))
          if (field !== 'cron' && field !== 'enabled')
            errors.push(`${path}.${field}: unknown setting`);
    });
  }
  if (errors.length) throw new WorkflowOnError(errors);
}

/** First definitions win; runtime state never enters the canonical file settings. */
export function triggersOfInput(input: WorkflowOnInput): DefinedTrigger[] {
  validateInput(input);
  const on: Record<string, unknown> = {
    schedule: (input.schedule ?? []).map((entry) => ({ cron: entry.cron })),
  };
  const seen = new Set<string>();
  for (const entry of input.events ?? []) {
    if (seen.has(entry.event)) continue;
    seen.add(entry.event);
    on[entry.event] = Object.fromEntries(
      Object.entries(entry).filter(
        ([key, value]) =>
          key !== 'event' && key !== 'enabled' && value !== undefined,
      ),
    );
  }
  return triggersOfOn(on);
}

/** Only explicit first-entry choices override runtime state; absence stays absent. */
export function enabledByKey(input: WorkflowOnInput): Map<string, boolean> {
  triggersOfInput(input);
  const wanted = new Map<string, boolean>(),
    seen = new Set<string>();
  const want = (key: string, enabled: boolean | undefined) => {
    if (seen.has(key)) return;
    seen.add(key);
    if (enabled !== undefined) wanted.set(key, enabled);
  };
  for (const entry of input.schedule ?? [])
    want(cronKey(entry.cron), entry.enabled);
  for (const entry of input.events ?? [])
    want(eventKey(entry.event), entry.enabled);
  return wanted;
}
