import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  getProjectsControllerGetByIdQueryKey,
  getProjectsControllerGetManyQueryKey,
  projectsControllerArchive,
  projectsControllerUnarchive,
  projectsControllerGetById,
  type ProjectViewDto,
} from '@/services/apis/gen/queries';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { useProjectWorkflowAction } from './use-project-workflow-action';

export function ProjectArchivedNotice({
  archivedAt,
}: {
  archivedAt?: string | null;
}) {
  return archivedAt ? (
    <p role="status" className="rounded-md border bg-muted/30 p-3 text-sm">
      Archived project. Schedules are paused and project controls are read-only.
      Historical results remain available.
    </p>
  ) : null;
}

export function ProjectArchiveDialog({
  project,
  workspaceId,
}: {
  project: Pick<ProjectViewDto, 'id' | 'name' | 'archivedAt'>;
  workspaceId: string;
}) {
  const [open, setOpen] = useState(false),
    [checking, setChecking] = useState(false),
    [checkError, setCheckError] = useState('');
  const finishing = useRef(false);
  const archive = !project.archivedAt;
  const label = archive ? 'Archive project' : 'Reopen project';
  const action = useProjectWorkflowAction(
    workspaceId,
    project.id,
    project.id,
    archive ? 'archive' : 'unarchive',
  );
  const client = useQueryClient(),
    key = getProjectsControllerGetByIdQueryKey(project.id);
  const locked = () => finishing.current || action.isLocked();
  async function store(result: ProjectViewDto) {
    await client.cancelQueries({ queryKey: key, exact: true });
    if (!action.current()) return;
    setOpen(false);
    client.setQueryData(key, result);
    toast.success(
      result.archivedAt ? 'Project archived.' : 'Project reopened.',
    );
    void client
      .invalidateQueries({ queryKey: getProjectsControllerGetManyQueryKey() })
      .catch(() => undefined);
    void client
      .invalidateQueries({
        predicate: ({ queryKey: [path] }) =>
          typeof path === 'string' &&
          (path === key[0] || path.startsWith(key[0] + '/')),
      })
      .catch(() => undefined);
  }
  async function confirm() {
    if (locked()) return;
    finishing.current = true;
    try {
      const result = await action.execute((signal) =>
        (archive ? projectsControllerArchive : projectsControllerUnarchive)(
          project.id,
          {
            signal,
            timeout: 30_000,
            headers: { 'X-Workspace-Id': workspaceId },
          },
        ),
      );
      if (result && action.current()) await store(result);
    } finally {
      finishing.current = false;
    }
  }
  async function check() {
    if (locked() || !action.current() || !navigator.onLine) return;
    finishing.current = true;
    setChecking(true);
    setCheckError('');
    try {
      const saved = await projectsControllerGetById(project.id, {
        timeout: 30_000,
        headers: { 'X-Workspace-Id': workspaceId, 'Cache-Control': 'no-cache' },
      });
      if (!action.current()) return;
      if (Boolean(saved.archivedAt) === archive) {
        action.acknowledge();
        await store(saved);
      } else {
        // Both transitions are idempotent. A fresh opposite state allows an
        // explicit retry without automatically replaying a write.
        action.acknowledge();
        setCheckError(
          'The saved project state is unchanged. You can retry this action.',
        );
      }
    } catch {
      if (action.current())
        setCheckError('Unable to check the saved project state.');
    } finally {
      finishing.current = false;
      if (action.current()) setChecking(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!locked()) {
          if (next) action.resetSuccess();
          setOpen(next);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label={`${label} ${project.name}`}
        >
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent
        className="[overflow-wrap:anywhere]"
        showCloseButton={!action.busy && !checking}
      >
        <DialogHeader>
          <DialogTitle>{label}</DialogTitle>
          <DialogDescription>
            {archive
              ? `Archive ${project.name}? Its schedules and event triggers will pause. Project controls become read-only; historical results and running jobs remain.`
              : `Reopen ${project.name}? Its saved schedules and enabled triggers will resume. Work queued before archive will not be replayed.`}
          </DialogDescription>
        </DialogHeader>
        {(action.error || action.uncertain) && (
          <p role="alert">
            {action.uncertain
              ? 'Could not confirm the saved project state. Check it before making another change.'
              : action.error}
          </p>
        )}
        {checkError && <p role="alert">{checkError}</p>}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={action.busy || checking}
            onClick={() => {
              if (!locked()) setOpen(false);
            }}
          >
            Cancel
          </Button>
          {action.uncertain ? (
            <Button
              variant="outline"
              disabled={checking}
              onClick={() => void check()}
            >
              {checking ? 'Checking…' : 'Check project state'}
            </Button>
          ) : (
            <Button
              disabled={action.busy || checking}
              onClick={() => void confirm()}
            >
              {action.busy ? 'Saving…' : label}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
