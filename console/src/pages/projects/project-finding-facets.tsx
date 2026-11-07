import {
  type ProjectFindingProvenanceCountsDto,
  ProjectsControllerGetFindingsProvenance,
  ProjectsControllerGetFindingsSeverityItem,
  ProjectsControllerGetFindingsStatus,
  type SeverityCountsDto,
} from '@/services/apis/gen/queries';

export const provenanceLabels = {
  new: 'New',
  recurring: 'Recurring',
  not_seen: 'Not seen again',
} satisfies Record<ProjectsControllerGetFindingsProvenance, string>;

const provenances = Object.values(ProjectsControllerGetFindingsProvenance);
const severities = Object.values(
  ProjectsControllerGetFindingsSeverityItem,
).reverse();
const statuses = Object.values(ProjectsControllerGetFindingsStatus);
const provenanceKeys = {
  new: 'new',
  recurring: 'recurring',
  not_seen: 'notSeen',
} as const;

export type FindingFacets = {
  provenance?: ProjectsControllerGetFindingsProvenance;
  severity?: ProjectsControllerGetFindingsSeverityItem[];
  status?: ProjectsControllerGetFindingsStatus;
};

type FacetProps = FindingFacets & {
  provenanceCounts?: ProjectFindingProvenanceCountsDto;
  severityCounts?: SeverityCountsDto;
  onChange: (facets: FindingFacets) => void;
};

function withCount(label: string, count?: number) {
  return count === undefined ? label : `${label} (${count.toLocaleString()})`;
}

export function ProjectFindingFacets({
  provenance,
  severity = [],
  status,
  provenanceCounts,
  severityCounts,
  onChange,
}: FacetProps) {
  const filters = {
    provenance,
    severity: severity.length ? severity : undefined,
    status,
  };
  return (
    <div className="flex flex-wrap items-start gap-3">
      <label className="flex w-fit items-center gap-2 text-sm">
        Status
        <select
          className="rounded-md border bg-background px-2 py-1"
          value={status ?? 'open'}
          onChange={({ target }) =>
            onChange({
              ...filters,
              status: statuses.find((value) => value === target.value),
            })
          }
        >
          <option value="open">Open</option>
          <option value="dismissed">Dismissed</option>
          <option value="all">All, including archived</option>
        </select>
      </label>
      <label className="flex w-fit items-center gap-2 text-sm">
        Provenance
        <select
          className="rounded-md border bg-background px-2 py-1"
          value={provenance ?? ''}
          onChange={({ target }) =>
            onChange({
              ...filters,
              provenance: provenances.find((value) => value === target.value),
            })
          }
        >
          <option value="">
            {withCount('All provenance', provenanceCounts?.all)}
          </option>
          {provenances.map((value) => (
            <option key={value} value={value}>
              {withCount(
                provenanceLabels[value],
                provenanceCounts?.[provenanceKeys[value]],
              )}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <legend className="font-medium">Severity</legend>
        {severities.map((value) => (
          <label key={value} className="flex items-center gap-1 capitalize">
            <input
              type="checkbox"
              checked={severity.includes(value)}
              onChange={({ target }) => {
                const selected = severities.filter((key) =>
                  key === value ? target.checked : severity.includes(key),
                );
                onChange({
                  ...filters,
                  severity: selected.length ? selected : undefined,
                });
              }}
            />
            {withCount(value, severityCounts?.[value])}
          </label>
        ))}
      </fieldset>
    </div>
  );
}
