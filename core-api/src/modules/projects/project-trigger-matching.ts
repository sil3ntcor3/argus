import type { Severity } from '@/common/enums/enum';
import type { ProjectTriggerConfigDto } from './dto/project-trigger-read.dto';
import {
  eventConfigProblems,
  isTriggerEvent,
  normalizeEventConfig,
} from './project-trigger-config';

/** Private matching inputs; the future event boundary retains tenant/run provenance. */
export type ProjectTriggerMatchFact =
  | { event: 'project.assets.added' }
  | {
      event: 'project.run.completed';
      projectWorkflowId: string;
      workflowName: string;
      outcome: 'success' | 'failure';
    }
  | { event: 'vulnerability.detected'; severities: readonly Severity[] };
export interface MatchableTrigger {
  type: string;
  enabled?: boolean;
  event: string | null;
  projectWorkflowId: string;
  config: unknown;
}

/** Split pre-scoped items into independent batches. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isSafeInteger(size) || size <= 0)
    throw new RangeError('Batch size must be a positive safe integer');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

/**
 * Match pre-scoped rows/assets without I/O. The caller owns workspace/project
 * authorization and revalidates enabled asset membership and target types before
 * launching. Run cause/depth checks remain with dispatch. Row identity stays
 * intact; every match receives its own asset array.
 */
export function matchTriggers<Row extends MatchableTrigger>(
  fact: ProjectTriggerMatchFact,
  triggers: readonly Row[],
  assetIds: readonly string[],
): { trigger: Row; assetIds: string[] }[] {
  if (assetIds.length === 0) return [];
  return triggers
    .filter((trigger) => {
      const event = trigger.event;
      if (
        trigger.enabled !== true ||
        trigger.type !== 'event' ||
        !isTriggerEvent(event) ||
        event !== fact.event
      )
        return false;
      if (
        eventConfigProblems(event, trigger.config, { ignoreUnknown: true })
          .length
      )
        return false;
      const config = normalizeEventConfig(
        event,
        trigger.config as ProjectTriggerConfigDto,
      );
      switch (fact.event) {
        case 'project.run.completed': {
          if (trigger.projectWorkflowId === fact.projectWorkflowId)
            return false;
          const followed = (config.workflows ?? []).map((name) =>
            name.trim().toLowerCase(),
          );
          return (
            (config.status ?? []).includes(fact.outcome) &&
            (followed.length === 0 ||
              followed.includes(fact.workflowName.trim().toLowerCase()))
          );
        }
        case 'vulnerability.detected':
          return fact.severities.some((severity) =>
            (config.severity ?? []).includes(severity),
          );
        default:
          return true;
      }
    })
    .map((trigger) => ({ trigger, assetIds: [...assetIds] }));
}
