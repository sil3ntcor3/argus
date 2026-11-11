import { Button } from '@/components/ui/button';
import { useProjectsControllerGetById } from '@/services/apis/gen/queries';
import { useRef } from 'react';
import { projectWorkflowLabel } from './project-workflow-label';

/** Filters project readers by workflow binding, including a saved historical selection. */
export function ProjectWorkflowFilter({
  projectId,
  workflow,
  onChange,
}: {
  projectId: string;
  workflow?: string;
  onChange: (workflow?: string) => void;
}) {
  const selector = useRef<HTMLSelectElement>(null);
  const projectQuery = useProjectsControllerGetById(projectId, {
    query: { retry: false },
  });
  const bindings = projectQuery.data?.assetGroupWorkflows ?? [];
  let selectedWorkflowLabel = 'Unavailable workflow';
  if (projectQuery.isPending) selectedWorkflowLabel = 'Loading workflow';
  if (projectQuery.isError) selectedWorkflowLabel = 'Workflow name unknown';
  return (
    <div className="grid min-w-0 gap-2">
      <label className="flex min-w-0 items-center gap-2 text-sm">
        Workflow
        <select
          ref={selector}
          className="min-w-0 rounded-md border bg-background px-2 py-1"
          value={workflow ?? ''}
          onChange={(event) => onChange(event.target.value || undefined)}
        >
          <option value="">All workflows</option>
          {workflow && !bindings.some((binding) => binding.id === workflow) && (
            <option value={workflow}>{selectedWorkflowLabel}</option>
          )}
          {bindings.map(({ id, workflow: boundWorkflow }) => (
            <option key={id} value={id}>
              {projectWorkflowLabel(boundWorkflow)}
            </option>
          ))}
        </select>
      </label>
      {projectQuery.isError && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <p role="status">Unable to load workflow choices</p>
          <Button
            variant="outline"
            size="sm"
            disabled={projectQuery.isFetching}
            onClick={() => {
              selector.current?.focus();
              void projectQuery.refetch();
            }}
          >
            Retry workflows
          </Button>
        </div>
      )}
    </div>
  );
}
