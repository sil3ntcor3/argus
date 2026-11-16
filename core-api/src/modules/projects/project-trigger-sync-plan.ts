import type { ProjectTriggerConfigDto } from './dto/project-trigger-read.dto';
import {
  eventConfigProblems,
  isTriggerEvent,
  normalizeEventConfig,
} from './project-trigger-config';
import { cronKey, eventKey, type DefinedTrigger } from './project-workflow-on';

export interface StoredTriggerRow {
  type: string;
  cron: string | null;
  event: string | null;
  config: unknown;
  enabled?: boolean;
}
export interface TriggerSyncPlan<Row> {
  create: DefinedTrigger[];
  update: { row: Row; config: ProjectTriggerConfigDto }[];
  remove: Row[];
}
export function keyOfRow(
  row: Pick<StoredTriggerRow, 'type' | 'cron' | 'event'>,
): string | undefined {
  if (row.type === 'cron' && typeof row.cron === 'string' && row.cron.trim())
    return cronKey(row.cron);
  if (row.type === 'event' && isTriggerEvent(row.event))
    return eventKey(row.event);
  return undefined;
}
function copyDefinition(defined: DefinedTrigger): DefinedTrigger {
  return defined.type === 'cron'
    ? { key: defined.key, type: 'cron', cron: defined.cron }
    : {
        key: defined.key,
        type: 'event',
        event: defined.event,
        config: normalizeEventConfig(defined.event, defined.config),
      };
}

/** Caller scopes inputs to one authorized binding; this computes a plan without I/O. */
export function planTriggerSync<Row extends StoredTriggerRow>(
  rows: readonly Row[],
  defined: readonly DefinedTrigger[],
): TriggerSyncPlan<Row> {
  const byKey = new Map<string, Row>();
  for (const row of rows) {
    const key = keyOfRow(row);
    if (key === undefined) continue;
    const previous = byKey.get(key);
    // Repairing a duplicate must not silently re-enable a disabled definition.
    if (previous?.enabled === false && row.enabled !== false) continue;
    byKey.set(key, row);
  }
  const definedKeys = new Set(defined.map((trigger) => trigger.key));
  return {
    create: defined
      .filter((trigger) => !byKey.has(trigger.key))
      .map(copyDefinition),
    update: defined.flatMap((trigger) => {
      const row = byKey.get(trigger.key);
      if (!row || trigger.type !== 'event') return [];
      const config = normalizeEventConfig(trigger.event, trigger.config);
      const invalid =
        eventConfigProblems(trigger.event, row.config, { ignoreUnknown: true })
          .length > 0;
      if (
        !invalid &&
        JSON.stringify(
          normalizeEventConfig(
            trigger.event,
            row.config as ProjectTriggerConfigDto,
          ),
        ) === JSON.stringify(config)
      )
        return [];
      return [{ row, config }];
    }),
    remove: rows.filter((row) => {
      const key = keyOfRow(row);
      return (
        key === undefined || !definedKeys.has(key) || byKey.get(key) !== row
      );
    }),
  };
}
