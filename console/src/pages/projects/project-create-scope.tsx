import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import useDebounce from '@/hooks/use-debounce';
import {
  useAssetsControllerGetHostAssets,
  useProjectsControllerPreviewScope,
  type ScopeRuleInputDto,
  type ScopePreviewResultDto,
} from '@/services/apis/gen/queries';
import { getGlobalWorkspaceId } from '@/utils/workspaceState';
import { useRef, useState } from 'react';

export interface ProjectCreateScopeProps {
  workspaceId: string;
  rules: ScopeRuleInputDto[];
  onRulesChange: (rules: ScopeRuleInputDto[]) => void;
  hostIds: string[];
  onHostsChange: (ids: string[]) => void;
  autoAddAssets: boolean;
  onAutoAddChange: (value: boolean) => void;
  disabled: boolean;
  canReadAssets: boolean;
}

/** Draft scope stays local until the single create request commits. */
export function ProjectCreateScope(props: ProjectCreateScopeProps) {
  const { rules, disabled } = props;
  const [search, setSearch] = useState(''),
    [page, setPage] = useState(1);
  const filter = useDebounce(search.trim(), 300);
  const assets = useAssetsControllerGetHostAssets(
    { page, limit: 10, value: filter, sortBy: 'host', sortOrder: 'ASC' },
    {
      query: { enabled: props.canReadAssets, retry: false },
    },
  );
  const preview = useProjectsControllerPreviewScope();
  const [result, setResult] = useState<ScopePreviewResultDto>();
  const [previewFailed, setPreviewFailed] = useState(false);
  const revision = useRef(0),
    addButton = useRef<HTMLButtonElement>(null);
  const busy = disabled || preview.isPending;
  const assetsReady =
    props.canReadAssets &&
    assets.data &&
    !assets.isError &&
    !assets.isFetching &&
    search.trim() === filter;

  /** A changed draft invalidates any in-flight or previously displayed estimate. */
  function change(next: ScopeRuleInputDto[]) {
    revision.current++;
    setResult(undefined);
    setPreviewFailed(false);
    preview.reset();
    props.onRulesChange(next);
  }
  async function previewRules() {
    if (
      busy ||
      rules.some((rule) => !rule.value.trim()) ||
      getGlobalWorkspaceId() !== props.workspaceId
    )
      return;
    const current = revision.current;
    setPreviewFailed(false);
    try {
      const next = await preview.mutateAsync({ data: { rules } });
      if (
        current === revision.current &&
        getGlobalWorkspaceId() === props.workspaceId
      )
        setResult(next);
    } catch {
      if (getGlobalWorkspaceId() === props.workspaceId) setPreviewFailed(true);
    }
  }
  return (
    <section
      aria-labelledby="create-project-scope-heading"
      className="space-y-4 rounded-xl border bg-card p-4"
    >
      <h2 id="create-project-scope-heading" className="font-semibold">
        Project scope
      </h2>
      <p className="text-sm text-muted-foreground">
        Choose assets, add include/exclude rules, or start with an empty scope.
      </p>
      {props.canReadAssets && (
        <div className="space-y-3">
          <label className="block text-sm">
            Search assets
            <Input
              type="search"
              value={search}
              readOnly={disabled}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.preventDefault();
              }}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
            />
          </label>
          {assets.isError ? (
            <div role="status">
              Unable to load assets.{' '}
              <Button
                type="button"
                variant="outline"
                onClick={() => void assets.refetch()}
              >
                Retry assets
              </Button>
            </div>
          ) : !assetsReady ? (
            <p role="status">Loading assets…</p>
          ) : !assets.data?.data.length ? (
            <p className="text-sm" role="status">
              No matching assets.
            </p>
          ) : (
            <ul
              aria-label="Assets to include"
              className="max-h-52 space-y-2 overflow-y-auto rounded-md border p-3"
            >
              {assets.data.data.map((asset) => (
                <li key={asset.id} className="min-w-0">
                  <label className="flex items-start gap-2 text-sm [overflow-wrap:anywhere]">
                    <input
                      type="checkbox"
                      disabled={
                        disabled ||
                        (!props.hostIds.includes(asset.id) &&
                          props.hostIds.length >= 1000)
                      }
                      checked={props.hostIds.includes(asset.id)}
                      onChange={(event) =>
                        props.onHostsChange(
                          event.target.checked
                            ? [...props.hostIds, asset.id]
                            : props.hostIds.filter((id) => id !== asset.id),
                        )
                      }
                    />
                    <span>{asset.host}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled || !assetsReady || page <= 1}
              onClick={() => setPage((value) => value - 1)}
            >
              Previous assets
            </Button>
            <span>Page {page}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={
                disabled ||
                !assetsReady ||
                page >= (assets.data?.pageCount ?? 1)
              }
              onClick={() => setPage((value) => value + 1)}
            >
              Next assets
            </Button>
            <span>{props.hostIds.length} selected</span>
            {props.hostIds.length > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled}
                onClick={() => props.onHostsChange([])}
              >
                Clear selected assets
              </Button>
            )}
          </div>
        </div>
      )}
      {rules.map((rule, index) => (
        <fieldset
          key={index}
          disabled={busy}
          className="flex flex-wrap items-end gap-3 rounded-md border p-3"
        >
          <legend className="px-1 text-sm font-medium">
            Scope rule {index + 1}
          </legend>
          <label className="flex flex-col gap-1 text-sm">
            Action {index + 1}
            <select
              className="rounded-md border bg-background p-2"
              value={rule.mode}
              onChange={(e) =>
                change(
                  rules.map((row, i) =>
                    i === index
                      ? {
                          ...row,
                          mode: e.target.value as ScopeRuleInputDto['mode'],
                        }
                      : row,
                  ),
                )
              }
            >
              <option value="include">Include</option>
              <option value="exclude">Exclude</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Rule type {index + 1}
            <select
              className="rounded-md border bg-background p-2"
              value={rule.type}
              onChange={(e) =>
                change(
                  rules.map((row, i) =>
                    i === index
                      ? {
                          ...row,
                          type: e.target.value as ScopeRuleInputDto['type'],
                          value: '',
                        }
                      : row,
                  ),
                )
              }
            >
              <option value="hostname">Hostname pattern</option>
              <option value="target">Target ID</option>
              <option value="asset">Asset ID</option>
              <option value="cidr">CIDR</option>
            </select>
          </label>
          <label className="flex min-w-0 basis-full flex-col gap-1 text-sm sm:min-w-48 sm:flex-1 sm:basis-auto">
            Rule value {index + 1}
            <Input
              required
              maxLength={255}
              value={rule.value}
              onChange={(e) =>
                change(
                  rules.map((row, i) =>
                    i === index ? { ...row, value: e.target.value } : row,
                  ),
                )
              }
            />
          </label>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              change(rules.filter((_, i) => i !== index));
              addButton.current?.focus();
            }}
          >
            Remove rule {index + 1}
          </Button>
        </fieldset>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button
          ref={addButton}
          type="button"
          variant="outline"
          disabled={busy || rules.length >= 100}
          onClick={() =>
            change([...rules, { mode: 'include', type: 'hostname', value: '' }])
          }
        >
          Add scope rule
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy || rules.some((rule) => !rule.value.trim())}
          onClick={() => void previewRules()}
        >
          {preview.isPending ? 'Previewing…' : 'Preview rule matches'}
        </Button>
      </div>
      {result && (
        <p role="status" className="text-sm">
          {result.ruleAssets} assets match these rules. Manual selections are
          added separately.
        </p>
      )}
      {previewFailed && (
        <p role="alert" className="text-sm">
          Unable to preview scope. Check the rules and try again.
        </p>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={props.autoAddAssets}
          disabled={disabled}
          onChange={(e) => props.onAutoAddChange(e.target.checked)}
        />
        Automatically add newly discovered matching assets
      </label>
    </section>
  );
}
