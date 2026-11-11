import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import {
  isPipelineValid,
  ToolPipelineBuilder,
  type PipelineToolEntry,
} from '@/pages/asset-group/components/tool-pipeline-builder';
import {
  entriesFromContent,
  jobsFromEntries,
} from '@/pages/asset-group/components/pipeline-mapping';
import {
  useToolsControllerGetInstalledTools,
  type AssetGroupWorkflow,
} from '@/services/apis/gen/queries';
import { useState } from 'react';
import { useProjectWorkflowSave } from './use-project-workflow-save';
import { toast } from 'sonner';

/** Edit an owned pipeline without resetting drafts when tools are installed. */
export function ProjectWorkflowPipelineDialog({
  projectId,
  binding,
  workflowName,
  workspaceId,
}: {
  projectId: string;
  binding: AssetGroupWorkflow;
  workflowName: string;
  workspaceId: string;
}) {
  const [open, setOpen] = useState(false);
  const [original, setOriginal] = useState(binding.workflow);
  const [draft, setDraft] = useState<PipelineToolEntry[]>([]);
  const update = useProjectWorkflowSave(projectId, workspaceId);
  const { saving } = update;
  const tools = useToolsControllerGetInstalledTools(undefined, {
    query: { enabled: open, retry: false },
  });
  const byId = new Map((tools.data?.data ?? []).map((tool) => [tool.id, tool]));
  const byName = new Map(
    (tools.data?.data ?? []).map((tool) => [tool.name, tool]),
  );
  // Resolve fallback names as the catalog arrives, retaining unsaved selections.
  const entries = draft.map((entry) => ({
    ...entry,
    toolId: byId.has(entry.toolId)
      ? entry.toolId
      : (byName.get(entry.toolId)?.id ?? entry.toolId),
  }));
  const repeated =
    new Set(entries.map((entry) => entry.toolId)).size < entries.length;
  const conflict =
    open &&
    !saving &&
    JSON.stringify(original) !== JSON.stringify(binding.workflow);
  const changed =
    JSON.stringify(entries) !==
    JSON.stringify(entriesFromContent(original.content.jobs ?? {}, byName));
  const canSave =
    !!tools.data &&
    !repeated &&
    !conflict &&
    changed &&
    entries.length > 0 &&
    entries.length <= 50 &&
    isPipelineValid(entries, byId);
  async function save() {
    if (!canSave) return;
    await update.save(
      binding.id,
      {
        jobs: jobsFromEntries(entries, byId, original.content.jobs ?? {}),
      },
      () => {
        setOpen(false);
        toast.success('Pipeline saved.');
      },
    );
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (update.isLocked()) return;
        if (next) {
          const snapshot = structuredClone(binding.workflow);
          setOriginal(snapshot);
          setDraft(entriesFromContent(snapshot.content.jobs ?? {}, byName));
          update.reset();
        }
        setOpen(next);
      }}
    >
      <SheetTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label={`Edit pipeline for ${workflowName}`}
        >
          Edit pipeline
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full sm:max-w-3xl [overflow-wrap:anywhere]">
        <SheetHeader>
          <SheetTitle>Edit pipeline</SheetTitle>
          <SheetDescription>
            Tools in one stage run together; the next stage starts when they
            finish. Select 1–50 tools.
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4">
          {!tools.data ? (
            tools.isError ? (
              <div role="status">
                Unable to load tools.{' '}
                <Button variant="outline" onClick={() => void tools.refetch()}>
                  Retry tools
                </Button>
              </div>
            ) : (
              <p role="status">Loading tools…</p>
            )
          ) : (
            <>
              {repeated && (
                <p role="status">
                  This workflow repeats a tool. View its saved definition to
                  inspect the pipeline.
                </p>
              )}
              <ToolPipelineBuilder
                allowInstall
                tools={tools.data.data}
                value={entries}
                onChange={(next) => {
                  setDraft(next);
                  if (update.isError) update.reset();
                }}
                disabled={saving || repeated || conflict}
              />
            </>
          )}
          {(conflict || update.isError) && (
            <p role="alert" className="text-sm text-destructive">
              {conflict
                ? 'This workflow changed. Close and reopen to edit it.'
                : 'Could not save this pipeline. Try again.'}
            </p>
          )}
        </div>
        <SheetFooter className="border-t">
          <Button
            variant="outline"
            disabled={saving}
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
          <Button disabled={!canSave || saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save pipeline'}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
