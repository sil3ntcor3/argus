import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { getProjectsControllerGetFilesQueryKey, getProjectsControllerGetByIdQueryKey, projectsControllerCompleteFile, projectsControllerGetById, projectsControllerPresignFile, projectsControllerRemoveFile, projectsControllerUpdate, useProjectsControllerGetFiles, type ProjectViewDto } from '@/services/apis/gen/queries';
import { getGlobalWorkspaceId } from '@/utils/workspaceState';
import { useIsMutating, useMutation, useMutationState, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { FileText, Upload, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { isAxiosError } from 'axios';

type Action = { type: 'instruction'; value: string; saved: string | null } | { type: 'upload'; file: File } | { type: 'detach'; id: string };

function contextError(cause: unknown): string | undefined {
  const message = isAxiosError<{ message?: unknown }>(cause) ? cause.response?.data?.message : undefined;
  if (typeof message === 'string') return message;
  return cause instanceof Error ? cause.message : undefined;
}

/** Project instructions and reference files, using the workspace's existing storage. */
export function ProjectAgentContext({ project, workspaceId, canEdit, canChat }: { project: ProjectViewDto; workspaceId: string; canEdit: boolean; canChat: boolean }) {
  const client = useQueryClient();
  const filesKey = [...getProjectsControllerGetFilesQueryKey(project.id), workspaceId];
  const mutationKey = ['project-agent-context', workspaceId, project.id];
  const busy = useIsMutating({ mutationKey }) > 0;
  const files = useProjectsControllerGetFiles(project.id, { query: { queryKey: filesKey, retry: false } });
  const [draft, setDraft] = useState<{ value: string; saved: string | null }>();
  const failures = useMutationState({ filters: { mutationKey, status: 'error' }, select: entry => entry });
  const uncertain = failures.length > 0;
  const [error, setError] = useState<string>();
  const [reloading, setReloading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true); const locked = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const current = () => mounted.current && getGlobalWorkspaceId() === workspaceId;
  const assertWorkspace = () => { if (getGlobalWorkspaceId() !== workspaceId) throw new Error('The selected workspace changed'); if (!navigator.onLine) throw new Error('You are offline'); };
  const mutation = useMutation({
    mutationKey, networkMode: 'always', retry: false,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: filesKey, exact: true, refetchType: getGlobalWorkspaceId() === workspaceId ? 'active' : 'none' });
      await client.invalidateQueries({ queryKey: getProjectsControllerGetByIdQueryKey(project.id), exact: true, refetchType: getGlobalWorkspaceId() === workspaceId ? 'active' : 'none' });
    },
    mutationFn: async (action: Action) => {
      assertWorkspace();
      if (action.type === 'instruction') {
        const fresh = await projectsControllerGetById(project.id, { headers: { 'Cache-Control': 'no-cache' } });
        assertWorkspace();
        if ((fresh.instruction ?? null) !== action.saved) throw new Error('Instructions changed. Load the saved values before trying again.');
        await projectsControllerUpdate(project.id, { instruction: action.value.trim() || null });
      } else if (action.type === 'detach') {
        await projectsControllerRemoveFile(project.id, action.id);
      } else {
        const file = action.file;
        if (!/\.(md|markdown|txt|csv)$/i.test(file.name) || file.size < 1 || file.size > 10 * 1024 * 1024) throw new Error('Choose a Markdown, text or CSV file from 1 byte to 10 MiB.');
        const upload = await projectsControllerPresignFile(project.id, { fileName: file.name, sizeBytes: file.size });
        assertWorkspace();
        const form = new FormData();
        for (const [key, value] of Object.entries(upload.fields)) form.append(key, value);
        form.append('file', file);
        const response = await fetch(upload.url, { method: 'POST', body: form });
        if (!response.ok) throw new Error('The file upload failed');
        assertWorkspace();
        await projectsControllerCompleteFile(project.id, upload.artifactId);
      }
    },
  });

  /** Suppress late effects and duplicate writes across unmounts or workspace switches. */
  async function perform(action: Action) {
    if (!canEdit || locked.current || busy || reloading || uncertain || !current()) return;
    locked.current = true; setError(undefined);
    try {
      await mutation.mutateAsync(action);
      if (!current()) return;
      if (action.type === 'instruction') setDraft(undefined);
      toast.success(action.type === 'instruction' ? 'Instructions saved' : action.type === 'upload' ? 'Project file added' : 'File detached');
    } catch (cause) {
      if (!current()) return;
      setError(contextError(cause) ?? 'Unable to update project context');
    } finally { locked.current = false; }
  }

  async function loadSaved() {
    if (locked.current || busy || !current()) return;
    locked.current = true; setReloading(true);
    try {
      assertWorkspace();
      const fresh = await projectsControllerGetById(project.id, { headers: { 'Cache-Control': 'no-cache' } });
      if (current()) { client.setQueryData(getProjectsControllerGetByIdQueryKey(project.id), fresh); setDraft(undefined); acknowledge(); }
    } catch { if (current()) setError('Unable to reload saved instructions'); }
    finally { locked.current = false; if (mounted.current) setReloading(false); }
  }

  const instruction = draft?.value ?? project.instruction ?? '';
  const list = files.isError ? [] : files.data ?? [];
  const disabled = !canEdit || busy || reloading || uncertain;
  const sharedError = error ?? contextError(failures.at(-1)?.state.error);
  const acknowledge = () => { for (const failure of failures) client.getMutationCache().remove(failure); setError(undefined); };
  return <Card>
    <CardHeader className="flex flex-wrap items-start justify-between gap-3 sm:flex-row">
      <div className="space-y-1"><CardTitle>AI context</CardTitle><CardDescription>Instructions and files used by chats about this project.</CardDescription></div>
      {canChat && <Button asChild variant="outline"><Link to="/aistudio" search={{ projectId: project.id }}>Chat about project</Link></Button>}
    </CardHeader>
    <CardContent className="space-y-6">
      <section className="space-y-3" aria-label="Project instructions">
        <Label htmlFor={`project-instruction-${project.id}`}>Instructions</Label>
        <Textarea id={`project-instruction-${project.id}`} value={instruction} disabled={!canEdit} readOnly={busy || reloading} maxLength={2000} rows={4} placeholder="Describe scope, constraints and reporting expectations" onChange={event => setDraft(value => ({ saved: value ? value.saved : project.instruction ?? null, value: event.target.value }))} />
        <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs text-muted-foreground">{instruction.length}/2000</span>
          {canEdit && <Button size="sm" disabled={disabled || !draft || (instruction.trim() || null) === draft.saved} onClick={() => void perform({ type: 'instruction', value: instruction, saved: draft ? draft.saved : project.instruction ?? null })}>Save instructions</Button>}
        </div>
      </section>
      <section className="space-y-3 border-t pt-4" aria-label="Project files">
        <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-sm font-medium">Reference files <span className="text-muted-foreground">{list.length}/5</span></h3>
          {canEdit && <Button size="sm" variant="outline" disabled={disabled || files.isPending || files.isFetching || files.isError || list.length >= 5} onClick={() => fileInput.current?.click()}><Upload className="size-4" />Upload file</Button>}
        </div>
        <input ref={fileInput} type="file" className="hidden" aria-label="Upload a project file" accept=".md,.markdown,.txt,.csv" disabled={disabled} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void perform({ type: 'upload', file }); }} />
        {files.isPending ? <p role="status">Loading project files…</p> : files.isError ? <p role="alert">Unable to load project files.</p> : list.length ? <ul className="space-y-2">{list.map(file => <li key={file.id} className="flex min-w-0 items-center gap-3 rounded-md border p-3"><FileText className="size-4 shrink-0" /><div className="min-w-0 flex-1"><p className="truncate text-sm" title={file.name}>{file.name}</p><p className="text-xs text-muted-foreground">{(file.sizeBytes / 1024).toFixed(1)} KB</p></div>{canEdit && <Button variant="ghost" size="icon" disabled={disabled} aria-label={`Detach ${file.name}`} onClick={() => void perform({ type: 'detach', id: file.id })}><X className="size-4" /></Button>}</li>)}</ul> : <p className="text-sm text-muted-foreground">No reference files attached.</p>}
        <p className="text-xs text-muted-foreground">Markdown, text or CSV, up to 10 MiB each. Files count toward workspace storage. Detaching keeps the file in Files.</p>
      </section>
      {sharedError && <p role="alert" className="text-sm text-destructive">{sharedError} Refresh to verify the saved state before another change.</p>}
      {(uncertain || files.isError) && <Button variant="outline" disabled={busy} onClick={() => { void files.refetch().then(result => { if (current() && !result.isError) acknowledge(); }); }}>Refresh files</Button>}
      {draft && <Button variant="outline" disabled={busy || reloading} onClick={() => void loadSaved()}>Load saved instructions</Button>}
    </CardContent>
  </Card>;
}
