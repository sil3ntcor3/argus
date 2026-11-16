import { FilterToolbar } from '@/components/filter-builder/filter-toolbar';
import {
  decodeFilter,
  encodeFilter,
} from '@/components/filter-builder/filter-model';
import { Input } from '@/components/ui/input';
import { usePermission } from '@/hooks/usePermission';
import type { ProjectsControllerGetFindingsParams } from '@/services/apis/gen/queries';
import { VULNERABILITY_FILTER_FIELDS } from '@/pages/vulnerabilities/vulnerability-filter-fields';
import type { FindingFacets } from './project-finding-facets';

export type FindingsSearch = FindingFacets &
  Pick<
    ProjectsControllerGetFindingsParams,
    | 'overdue'
    | 'discoveredBy'
    | 'createdFrom'
    | 'createdTo'
    | 'filter'
    | 'sortBy'
    | 'sortOrder'
  > & {
    page: number;
    query?: string;
    run?: string;
    workflow?: string;
  };
const sorts = {
  severity: 'Severity',
  name: 'Name',
  firstDetectedDate: 'First detected',
  lastSeenDate: 'Last detected',
  firstSeenAt: 'First seen in project',
  lastSeenAt: 'Last seen in project',
  dueAt: 'SLA deadline',
} as const;
const sources = {
  tool: 'Scanner',
  ai: 'AI',
  ai_tool: 'AI tool',
  manual: 'Manual',
} as const;
const selectClass = 'h-9 min-w-0 rounded-md border bg-background px-2 text-sm';

/** Keep bound finding filters in route state alongside Argus's provenance/run facets. */
export function ProjectFindingFilters({
  value,
  onChange,
}: {
  value: FindingsSearch;
  onChange: (search: FindingsSearch) => void;
}) {
  const permission = usePermission();
  const change = (next: Partial<FindingsSearch>) =>
    onChange({ ...value, ...next, page: 1 });
  // Project-only readers can enter a target ID or tool name without invoking
  // suggestion APIs they cannot read.
  const fields = VULNERABILITY_FILTER_FIELDS.map((field) =>
    (field.key === 'target' && !permission.hasPermission('target.read')) ||
    (field.key === 'tool' && !permission.hasPermission('tool.read'))
      ? { ...field, useSuggestions: () => ({ options: [], isFetching: false }) }
      : field,
  );
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-sm">
          First detected from
          <Input
            aria-label="First detected from"
            type="date"
            value={value.createdFrom ?? ''}
            onChange={(event) =>
              change({ createdFrom: event.target.value || undefined })
            }
          />
        </label>
        <label className="grid gap-1 text-sm">
          First detected through
          <Input
            aria-label="First detected through"
            type="date"
            value={value.createdTo ?? ''}
            onChange={(event) =>
              change({ createdTo: event.target.value || undefined })
            }
          />
        </label>
        <label className="grid gap-1 text-sm">
          Sort findings
          <select
            className={selectClass}
            value={value.sortBy ?? ''}
            onChange={(event) =>
              change({
                sortBy:
                  (event.target.value as FindingsSearch['sortBy']) || undefined,
              })
            }
          >
            <option value="">Severity then project sighting</option>
            {Object.entries(sorts).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          Sort direction
          <select
            className={selectClass}
            value={value.sortOrder ?? 'DESC'}
            disabled={!value.sortBy}
            onChange={(event) =>
              change({
                sortOrder: event.target.value as FindingsSearch['sortOrder'],
              })
            }
          >
            <option value="DESC">Descending</option>
            <option value="ASC">Ascending</option>
          </select>
        </label>
        <label className="flex h-9 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={!!value.overdue}
            onChange={(event) =>
              change({ overdue: event.target.checked || undefined })
            }
          />
          Overdue only
        </label>
      </div>
      <fieldset className="flex min-w-0 flex-wrap gap-x-4 gap-y-2 text-sm">
        <legend className="mb-1 font-medium">Discovery source</legend>
        {Object.entries(sources).map(([key, label]) => (
          <label key={key} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={
                value.discoveredBy?.includes(key as keyof typeof sources) ??
                false
              }
              onChange={(event) => {
                const next = Object.keys(sources).filter((source) =>
                  source === key
                    ? event.target.checked
                    : value.discoveredBy?.includes(
                        source as keyof typeof sources,
                      ),
                ) as NonNullable<FindingsSearch['discoveredBy']>;
                change({ discoveredBy: next.length ? next : undefined });
              }}
            />
            {label}
          </label>
        ))}
      </fieldset>
      <FilterToolbar
        key={`${permission.hasPermission('target.read')}:${permission.hasPermission('tool.read')}`}
        fields={fields}
        value={decodeFilter(value.filter)}
        onApply={(filter) => change({ filter: encodeFilter(filter) })}
      />
    </div>
  );
}
