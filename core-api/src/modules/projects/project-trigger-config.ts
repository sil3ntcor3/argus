import { Severity, TargetType } from '@/common/enums/enum';
import {
  PROJECT_TRIGGER_EVENTS,
  type ProjectTriggerConfigDto,
  type ProjectTriggerDto,
} from './dto/project-trigger-read.dto';

type TriggerEvent = NonNullable<ProjectTriggerDto['event']>;
const COMMON_SETTINGS = ['windowMinutes', 'maxAssets', 'targetTypes'];
const EVENT_SETTINGS: Record<TriggerEvent, readonly string[]> = {
  'project.assets.added': [],
  'project.run.completed': ['workflows', 'status'],
  'vulnerability.detected': ['severity'],
};
const OUTCOMES = ['success', 'failure'] as const;
export const isTriggerEvent = (value: unknown): value is TriggerEvent =>
  PROJECT_TRIGGER_EVENTS.some((event) => event === value);

/** Writer/parser defaults; the read API continues to report stored settings only. */
export function normalizeEventConfig(
  event: TriggerEvent,
  config?: Readonly<ProjectTriggerConfigDto>,
): ProjectTriggerConfigDto {
  const common: ProjectTriggerConfigDto = {
    windowMinutes: config?.windowMinutes ?? 10,
    maxAssets: config?.maxAssets ?? 200,
    targetTypes: [...(config?.targetTypes ?? [])],
  };
  switch (event) {
    case 'project.run.completed':
      return {
        ...common,
        workflows: [...(config?.workflows ?? [])],
        status: [...(config?.status ?? ['success'])],
      };
    case 'vulnerability.detected':
      return {
        ...common,
        severity: [...(config?.severity ?? [Severity.CRITICAL, Severity.HIGH])],
      };
    default:
      return common;
  }
}

/** Strict for definitions; stored-row comparisons can retain unrelated opaque keys. */
export function eventConfigProblems(
  event: TriggerEvent,
  raw: unknown,
  options: { ignoreUnknown?: boolean } = {},
): string[] {
  const allowed = [...COMMON_SETTINGS, ...EVENT_SETTINGS[event]];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return [`must be a mapping (${allowed.join(', ')})`];
  }
  const config = raw as Record<string, unknown>,
    problems: string[] = [];
  const intIn = (key: string, min: number, max: number) => {
    const value = config[key];
    if (
      value !== undefined &&
      (typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < min ||
        value > max)
    ) {
      problems.push(`${key} must be a whole number from ${min} to ${max}`);
    }
  };
  const listOf = (
    key: string,
    label: string,
    values: readonly string[],
    nonEmpty: boolean,
  ) => {
    const value = config[key];
    if (
      value !== undefined &&
      (!Array.isArray(value) ||
        (nonEmpty && !value.length) ||
        value.some((v) => typeof v !== 'string' || !values.includes(v)))
    ) {
      problems.push(`${key} must list ${label} (${values.join(', ')})`);
    }
  };
  intIn('windowMinutes', 0, 1440);
  intIn('maxAssets', 1, 5000);
  listOf('targetTypes', 'target types', Object.values(TargetType), false);
  if (event === 'project.run.completed') {
    const workflows = config.workflows;
    if (
      workflows !== undefined &&
      (!Array.isArray(workflows) ||
        workflows.length > 20 ||
        workflows.some((v) => typeof v !== 'string' || !v.trim()))
    ) {
      problems.push('workflows must list up to 20 workflow names');
    }
    listOf('status', 'one or more run outcomes', OUTCOMES, true);
  }
  if (event === 'vulnerability.detected')
    listOf('severity', 'one or more severities', Object.values(Severity), true);
  const unknown = Object.keys(config).filter((key) => !allowed.includes(key));
  if (!options.ignoreUnknown && unknown.length)
    problems.push(`unknown setting ${unknown.join(', ')}`);
  return problems;
}
