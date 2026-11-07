import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  getProjectsControllerGetAssetCandidatesQueryKey,
  getProjectsControllerGetAssetsQueryKey,
  getProjectsControllerGetByIdQueryKey,
  getProjectsControllerGetManyQueryKey,
  getProjectsControllerGetOverviewQueryKey,
  getProjectsControllerGetScopeRulesQueryKey,
  projectsControllerGetScopeRules,
  ProjectScopeRuleMode,
  ProjectScopeRuleType,
  type ScopeRuleDto,
  type ScopeRuleInputDto,
  useProjectsControllerPreviewScope,
  useProjectsControllerReplaceScopeRules,
} from '@/services/apis/gen/queries';
import { getGlobalWorkspaceId } from '@/utils/workspaceState';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { toast } from 'sonner';

const maxRules = 100;
const modes = Object.values(ProjectScopeRuleMode);
const types = Object.values(ProjectScopeRuleType);
const typeLabels = {
  target: 'Target ID',
  asset: 'Asset ID',
  hostname: 'Hostname pattern',
  cidr: 'CIDR',
} satisfies Record<ProjectScopeRuleType, string>;

type DraftRule = ScopeRuleInputDto & { key: string };
type PreviewProps = {
  projectId: string;
  rules: ScopeRuleDto[];
  canEdit?: boolean;
  autoAddAssets?: boolean;
};
const scopeRevision = (rules: ScopeRuleDto[], autoAddAssets: boolean) =>
  JSON.stringify([
    autoAddAssets,
    rules.map(({ id, mode, type, value }) => [id, mode, type, value]),
  ]);

function ScopePreviewForm({
  projectId,
  rules,
  canEdit,
  autoAddAssets = false,
  saving,
  beginSave,
  endSave,
  onSaved,
}: PreviewProps & {
  saving: boolean;
  beginSave: () => boolean;
  endSave: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<DraftRule[]>(() =>
    rules.map(({ id, mode, type, value }) => ({ key: id, mode, type, value })),
  );
  const nextKey = useRef(0);
  const addButton = useRef<HTMLButtonElement>(null);
  const previewButton = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<string | null>(null);
  const preview = useProjectsControllerPreviewScope();
  const queryClient = useQueryClient();
  const [autoAdd, setAutoAdd] = useState(autoAddAssets);
  const [baseline] = useState(() => scopeRevision(rules, autoAddAssets));
  const [saveCheck, setSaveCheck] = useState<'stale' | 'failed' | null>(null);
  const scopeChanged =
    saveCheck === 'stale' || baseline !== scopeRevision(rules, autoAddAssets);
  const save = useProjectsControllerReplaceScopeRules();
  const busy = preview.isPending || saving;
  const inputs = () =>
    draft.map(({ mode, type, value }) => ({ mode, type, value }));
  const canSave = Boolean(canEdit && preview.data && !busy && !scopeChanged);

  const saveDraft = async () => {
    const workspaceId = getGlobalWorkspaceId();
    if (!workspaceId || !canSave || !beginSave()) return;
    setSaveCheck(null);
    try {
      // Recheck the server before replacing the entire rule set.
      const latest = await projectsControllerGetScopeRules(projectId, {
        headers: { 'Cache-Control': 'no-cache' },
      }).catch(() => undefined);
      if (getGlobalWorkspaceId() !== workspaceId) return;
      if (!latest) {
        setSaveCheck('failed');
        return;
      }
      if (scopeRevision(latest.rules, latest.autoAddAssets) !== baseline) {
        setSaveCheck('stale');
        queryClient.setQueryData(
          getProjectsControllerGetScopeRulesQueryKey(projectId),
          latest,
        );
        return;
      }
      const result = await save
        .mutateAsync({
          id: projectId,
          data: { rules: inputs(), autoAddAssets: autoAdd },
        })
        .catch(() => undefined);
      if (!result || getGlobalWorkspaceId() !== workspaceId) return;

      const keys = [
        getProjectsControllerGetScopeRulesQueryKey(projectId),
        getProjectsControllerGetAssetsQueryKey(projectId),
        getProjectsControllerGetAssetCandidatesQueryKey(projectId),
        getProjectsControllerGetOverviewQueryKey(projectId),
        getProjectsControllerGetByIdQueryKey(projectId),
        getProjectsControllerGetManyQueryKey(),
      ];
      await Promise.all(
        keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
      if (getGlobalWorkspaceId() !== workspaceId) return;
      toast.success(
        `Scope saved. ${result.added} added, ${result.removed} removed.`,
      );
      onSaved();
    } finally {
      endSave();
    }
  };

  const update = (key: string, patch: Partial<ScopeRuleInputDto>) => {
    setDraft((rows) =>
      rows.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    );
    preview.reset();
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy || draft.some((row) => !row.value.trim())) return;
        previewButton.current?.focus();
        preview.mutate({
          data: {
            projectId,
            rules: inputs(),
          },
        });
      }}
    >
      <p className="text-sm text-muted-foreground">
        Use the asset or target UUID for ID-based rules. Hostname patterns
        accept wildcards, and CIDRs accept IPv4 or IPv6 ranges.
      </p>
      {draft.map(({ key, mode, type, value }, index) => (
        <fieldset
          key={key}
          disabled={busy}
          className="flex flex-wrap items-end gap-3 rounded-md border p-3"
        >
          <legend className="px-1 text-sm font-medium">Rule {index + 1}</legend>
          <label className="flex flex-col gap-1 text-sm">
            Action
            <select
              value={mode}
              className="rounded-md border bg-background p-2"
              onChange={({ target }) => {
                const next = modes.find((item) => item === target.value);
                if (next) update(key, { mode: next });
              }}
            >
              <option value="include">Include</option>
              <option value="exclude">Exclude</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Rule type
            <select
              value={type}
              className="rounded-md border bg-background p-2"
              onChange={({ target }) => {
                const next = types.find((item) => item === target.value);
                if (next) update(key, { type: next, value: '' });
              }}
            >
              {types.map((item) => (
                <option key={item} value={item}>
                  {typeLabels[item]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
            Rule value
            <Input
              ref={(input) => {
                if (input && pendingFocus.current === key) {
                  pendingFocus.current = null;
                  input.focus();
                }
              }}
              value={value}
              required
              maxLength={255}
              className="focus-visible:ring-2 focus-visible:ring-ring"
              onChange={({ target }) => update(key, { value: target.value })}
            />
          </label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Remove rule ${index + 1}`}
            onClick={() => {
              setDraft((rows) => rows.filter((row) => row.key !== key));
              preview.reset();
              addButton.current?.focus();
            }}
          >
            Remove rule
          </Button>
          {preview.data && (
            <Badge variant="secondary">
              {preview.data.perRule[index]}{' '}
              {mode === 'include' ? 'matched' : 'excluded from rule matches'}
            </Badge>
          )}
        </fieldset>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button
          ref={addButton}
          type="button"
          variant="outline"
          aria-disabled={busy || draft.length >= maxRules}
          className="aria-disabled:opacity-50"
          onClick={() => {
            if (busy || draft.length >= maxRules) return;
            const key = `new-${nextKey.current++}`;
            pendingFocus.current = key;
            setDraft((rows) => [
              ...rows,
              { key, mode: 'include', type: 'hostname', value: '' },
            ]);
            preview.reset();
          }}
        >
          Add rule
        </Button>
        <Button
          ref={previewButton}
          type="submit"
          aria-disabled={busy || draft.some((row) => !row.value.trim())}
          className="aria-disabled:opacity-50"
        >
          {preview.isPending ? 'Previewing…' : 'Preview matches'}
        </Button>
      </div>
      {canEdit && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={autoAdd}
            disabled={busy}
            onChange={({ target }) => setAutoAdd(target.checked)}
          />
          Automatically add newly discovered matching assets
        </label>
      )}
      {preview.isError && (
        <p role="status">
          Unable to preview scope. Check the rules and try again.
        </p>
      )}
      {preview.data && (
        <p role="status">
          {preview.data.total} assets in scope, including{' '}
          {preview.data.ruleAssets} matched by rules.
        </p>
      )}
      {canEdit && (
        <div className="space-y-2 border-t pt-4">
          <p className="text-sm text-muted-foreground">
            Saving replaces the saved scope rules and applies the new
            membership.
          </p>
          {scopeChanged && (
            <p role="status">
              Saved scope changed. Reopen the editor to load it.
            </p>
          )}
          {saveCheck === 'failed' ? (
            <p role="status">Unable to verify saved scope. Try again.</p>
          ) : (
            save.isError && (
              <p role="status">Unable to save project scope. Try again.</p>
            )
          )}
          <Button
            type="button"
            aria-disabled={!canSave}
            className="aria-disabled:opacity-50"
            onClick={() => void saveDraft()}
          >
            {saving ? 'Saving…' : 'Save scope'}
          </Button>
        </div>
      )}
    </form>
  );
}

export function ProjectScopePreview(props: PreviewProps) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const saveLock = useRef(false);
  if (props.rules.length > maxRules) {
    return (
      <p className="text-sm text-muted-foreground">
        Scope preview supports up to 100 rules.
      </p>
    );
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!saveLock.current) setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          {props.canEdit ? 'Edit scope' : 'Preview scope'}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {props.canEdit ? 'Edit project scope' : 'Preview project scope'}
          </DialogTitle>
          <DialogDescription>
            Try rule changes and check the estimated membership.
          </DialogDescription>
        </DialogHeader>
        <ScopePreviewForm
          {...props}
          saving={saving}
          beginSave={() => {
            if (saveLock.current) return false;
            saveLock.current = true;
            setSaving(true);
            return true;
          }}
          endSave={() => {
            saveLock.current = false;
            setSaving(false);
          }}
          onSaved={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
