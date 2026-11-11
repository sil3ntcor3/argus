import { ToolInstallConfirmDialog } from '@/components/tools/tool-install-confirm-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import ToolLogo from '@/components/ui/tool-logo';
import useDebounce from '@/hooks/use-debounce';
import { usePermission } from '@/hooks/usePermission';
import { useWorkspaceState } from '@/hooks/useWorkspaceSelector';
import {
  toolsControllerInstallTool,
  useToolsControllerGetManyTools,
  useToolsControllerInstallTool,
  type Tool,
} from '@/services/apis/gen/queries';
import { getGlobalWorkspaceId } from '@/utils/workspaceState';
import { useQueryClient } from '@tanstack/react-query';
import { Download, LoaderCircle } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

interface Props {
  installedTools: Tool[];
  onInstalled: (id: string) => void;
  disabled?: boolean;
}

/** Remount the catalog and confirmation dialog when the selected workspace changes. */
export function PipelineToolInstaller(props: Props) {
  const {
    state: { selectedWorkspaceId },
  } = useWorkspaceState();
  const { hasPermission } = usePermission();
  if (!selectedWorkspaceId || !hasPermission('tool.write')) return null;
  return (
    <CatalogInstaller
      key={selectedWorkspaceId}
      workspaceId={selectedWorkspaceId}
      {...props}
    />
  );
}

/** Search the server catalog and install without changing the unsaved pipeline. */
function CatalogInstaller({
  workspaceId,
  installedTools,
  onInstalled,
  disabled = false,
}: Props & { workspaceId: string }) {
  const [search, setSearch] = useState('');
  const [installingId, setInstallingId] = useState<string | null>(null);
  const debouncedSearch = useDebounce(search.trim(), 300);
  const query = useToolsControllerGetManyTools(
    { limit: 100, search: debouncedSearch || undefined },
    { query: { enabled: !disabled } },
  );
  const { mutateAsync } = useToolsControllerInstallTool({
    mutation: {
      networkMode: 'always',
      retry: false,
      mutationFn: ({ data }) => {
        if (getGlobalWorkspaceId() !== workspaceId)
          throw new Error('The selected workspace changed');
        return toolsControllerInstallTool(data);
      },
    },
  });
  const queryClient = useQueryClient();
  const installedIds = new Set(installedTools.map((tool) => tool.id));
  const tools = (query.data?.data ?? []).filter(
    (tool) => !tool.isInstalled && !installedIds.has(tool.id),
  );

  /** A late response from another workspace cannot open a panel in this draft. */
  const install = async (tool: Tool) => {
    if (disabled || installingId || getGlobalWorkspaceId() !== workspaceId)
      return;
    setInstallingId(tool.id);
    try {
      await mutateAsync({ data: { toolId: tool.id } });
      await queryClient.invalidateQueries({
        predicate: (query) =>
          String(query.queryKey[0] ?? '').startsWith('/api/tools'),
      });
      if (getGlobalWorkspaceId() !== workspaceId) return;
      onInstalled(tool.id);
      toast.success(`${tool.name} installed`);
    } catch {
      if (getGlobalWorkspaceId() === workspaceId)
        toast.error(`Failed to install ${tool.name}`);
    } finally {
      setInstallingId(null);
    }
  };

  return (
    <section
      aria-label="Install pipeline tools"
      className="space-y-3 border-t pt-4"
    >
      <Input
        aria-label="Search tools to install"
        placeholder="Search tools to install..."
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        disabled={disabled}
        className="max-w-xs"
      />
      {query.isError ? (
        <div role="alert" className="flex items-center gap-3 text-sm">
          Could not load tools
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void query.refetch();
            }}
          >
            Retry
          </Button>
        </div>
      ) : query.isLoading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading tools...
        </p>
      ) : tools.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No tools available to install.
        </p>
      ) : (
        <div className="flex flex-wrap gap-3">
          {tools.map((tool) => (
            <ToolInstallConfirmDialog
              key={tool.id}
              tool={tool}
              onConfirm={() => {
                void install(tool);
              }}
              trigger={
                <Button
                  type="button"
                  variant="outline"
                  aria-label={`Install ${tool.name}`}
                  disabled={disabled || installingId !== null}
                >
                  <ToolLogo name={tool.name} logoUrl={tool.logoUrl} size={24} />
                  {tool.name}
                  {installingId === tool.id ? (
                    <LoaderCircle aria-hidden className="size-4 animate-spin" />
                  ) : (
                    <Download aria-hidden className="size-4" />
                  )}
                </Button>
              }
            />
          ))}
        </div>
      )}
    </section>
  );
}
