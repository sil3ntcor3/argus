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
  ProjectScopeRuleMode,
  ProjectScopeRuleType,
  type ScopeRuleDto,
  type ScopeRuleInputDto,
  useProjectsControllerPreviewScope,
} from '@/services/apis/gen/queries';
import { useRef, useState } from 'react';

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
type PreviewProps = { projectId: string; rules: ScopeRuleDto[] };

function ScopePreviewForm({ projectId, rules }: PreviewProps) {
  const [draft, setDraft] = useState<DraftRule[]>(() =>
    rules.map(({ id, mode, type, value }) => ({ key: id, mode, type, value })),
  );
  const nextKey = useRef(0);
  const addButton = useRef<HTMLButtonElement>(null);
  const previewButton = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<string | null>(null);
  const preview = useProjectsControllerPreviewScope();
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
        if (preview.isPending || draft.some((row) => !row.value.trim())) return;
        previewButton.current?.focus();
        preview.mutate({
          data: {
            projectId,
            rules: draft.map(({ mode, type, value }) => ({
              mode,
              type,
              value,
            })),
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
          disabled={preview.isPending}
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
          aria-disabled={preview.isPending || draft.length >= maxRules}
          className="aria-disabled:opacity-50"
          onClick={() => {
            if (preview.isPending || draft.length >= maxRules) return;
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
          aria-disabled={
            preview.isPending || draft.some((row) => !row.value.trim())
          }
          className="aria-disabled:opacity-50"
        >
          {preview.isPending ? 'Previewing…' : 'Preview matches'}
        </Button>
      </div>
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
    </form>
  );
}

export function ProjectScopePreview(props: PreviewProps) {
  if (props.rules.length > maxRules) {
    return (
      <p className="text-sm text-muted-foreground">
        Scope preview supports up to 100 rules.
      </p>
    );
  }
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Preview scope
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Preview project scope</DialogTitle>
          <DialogDescription>
            Try rule changes and check the estimated membership.
          </DialogDescription>
        </DialogHeader>
        <ScopePreviewForm {...props} />
      </DialogContent>
    </Dialog>
  );
}
