import { ScanScheduleSelect } from '@/components/scan-schedule-select';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { useWorkspaceSelector } from '@/hooks/useWorkspaceSelector';
import type { Target } from '@/services/apis/gen/queries';
import {
  JobStatus,
  TargetType,
  targetsControllerDeleteTarget,
  targetsControllerReScanTarget,
  targetsControllerUpdateTarget,
  UpdateTargetDtoScanSchedule,
  useTargetsControllerDeleteTarget,
  useTargetsControllerReScanTarget,
  useTargetsControllerUpdateTarget,
} from '@/services/apis/gen/queries';
import { useIsMutating, useQueryClient } from '@tanstack/react-query';
import type { AxiosError } from 'axios';
import clsx from 'clsx';
import { Clock, GitFork, RefreshCw, Settings, Trash2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { getGlobalWorkspaceId } from '@/utils/workspaceState';
import { useSession } from '@/utils/authClient';

/** Keeps Git organization settings in their existing sheet. */
function SettingsFrame({
  inline,
  open,
  onOpenChange,
  children,
}: {
  inline: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  if (inline) return children;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          aria-label="Target settings"
          className="cursor-pointer h-8 w-8 rounded-full border-border/50 hover:border-border hover:bg-accent hover:text-accent-foreground"
        >
          <Settings className="h-4 w-4" />
        </Button>
      </SheetTrigger>
      {children}
    </Sheet>
  );
}

/** Renders existing target actions in a Settings page or a Git organization sheet. */
const SettingTarget = ({
  target,
  refetch,
  inline = false,
  scanActions,
}: {
  target: Target;
  refetch: () => Promise<unknown>;
  inline?: boolean;
  scanActions?: ReactNode;
}) => {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { selectedWorkspace: workspaceId, workspaces } = useWorkspaceSelector();
  const { data: session } = useSession();
  const canDelete = workspaces.some(
    (workspace) =>
      workspace.id === workspaceId && workspace.ownerId === session?.user.id,
  );
  const mutationKey = ['target-settings', workspaceId, target.id];
  const mutationFilter = { mutationKey, exact: true };
  const changing = useIsMutating(mutationFilter) > 0;
  const canChange = () =>
    workspaceId === getGlobalWorkspaceId() &&
    !queryClient.isMutating(mutationFilter);
  function assertWorkspace() {
    if (workspaceId !== getGlobalWorkspaceId())
      throw new Error('The selected workspace changed');
  }
  const Surface = inline ? 'section' : SheetContent;
  const Header = inline ? 'header' : SheetHeader;
  const Title = inline ? 'h2' : SheetTitle;
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isRediscovering, setIsRediscovering] = useState(false);
  const isGitOrg = target.type === TargetType.GIT_ORG;
  const gitOrgSettings = (target.settings ?? {}) as {
    includeArchived?: boolean;
    includeForks?: boolean;
  };

  // Mutation hook to permanently delete a target
  const { mutate: deleteTarget } = useTargetsControllerDeleteTarget({
    mutation: {
      mutationKey,
      retry: false,
      networkMode: 'always',
      mutationFn: async ({ id }) => {
        assertWorkspace();
        return targetsControllerDeleteTarget(id);
      },
      onSuccess: () => {
        setIsDeleting(false);
        const current = workspaceId === getGlobalWorkspaceId();
        void queryClient.invalidateQueries({
          queryKey: ['targets', workspaceId],
          refetchType: current ? 'active' : 'none',
        });
        if (current) toast.success('Target deleted successfully');
      },
      onError: (err) => {
        const axiosErr = err as AxiosError<{ message: string }>;
        toast.error(
          axiosErr.response?.data.message ?? 'Failed to delete target',
        );
        setIsDeleting(false);
      },
    },
  });

  // Mutation hook to rediscover/re-scan a target
  const { mutate: rediscoverTarget } = useTargetsControllerReScanTarget({
    mutation: {
      mutationKey,
      retry: false,
      networkMode: 'always',
      mutationFn: async ({ id }) => {
        assertWorkspace();
        return targetsControllerReScanTarget(id);
      },
      onSettled: () => setIsRediscovering(false),
      onError: () => setIsRediscovering(false),
      onSuccess: () => {
        if (workspaceId === getGlobalWorkspaceId()) refetch();
      },
    },
  });

  // Update target scan schedule
  const updateTarget = useTargetsControllerUpdateTarget({
    mutation: {
      mutationKey,
      retry: false,
      networkMode: 'always',
      mutationFn: async ({ id, data }) => {
        assertWorkspace();
        return targetsControllerUpdateTarget(id, data);
      },
      onSuccess: async () => {
        if (workspaceId !== getGlobalWorkspaceId()) return;
        toast.success('Updated');
        await refetch();
      },
      onError: () => toast.error('Failed to update target scan schedule'),
    },
  });
  const pendingSchedule = updateTarget.isPending
    ? updateTarget.variables?.data.scanSchedule
    : undefined;
  const frequency =
    pendingSchedule ??
    target.scanSchedule ??
    UpdateTargetDtoScanSchedule['0_0_*_*_0'];

  // GIT_ORG filters; the API starts a repository sync to apply them.
  const updateGitOrgSetting = (
    key: 'includeArchived' | 'includeForks',
    value: boolean,
  ) => {
    if (!canChange()) return;
    updateTarget.mutate({
      id: target.id,
      data: { settings: { [key]: value } },
    });
  };

  return (
    <SettingsFrame
      inline={inline}
      open={isSheetOpen}
      onOpenChange={setIsSheetOpen}
    >
      <Surface
        className={
          inline
            ? 'max-w-3xl space-y-4 rounded-xl border bg-card p-4'
            : 'flex flex-col w-full sm:max-w-md p-0 h-full'
        }
      >
        <Header>
          <Title className="font-bold text-lg">
            {inline ? 'Target settings' : target.value}
          </Title>
        </Header>

        <div className="flex flex-col h-full">
          <div className="flex-1 space-y-0.5 overflow-y-auto p-1">
            <div className={clsx('space-y-4')}>
              <div className="space-y-2">
                <div>
                  <div className="flex items-center gap-3 p-2">
                    <div className="p-2.5 rounded-lg bg-purple-100 dark:bg-purple-900/30">
                      <Clock className="h-4 w-4 text-purple-600 dark:text-purple-400" />
                    </div>
                    <div className="flex-1 flex flex-wrap items-center justify-between gap-2">
                      <label
                        htmlFor="scan-frequency"
                        className="text-sm font-medium"
                      >
                        {isGitOrg ? 'Sync Schedule' : 'Scan Schedule'}
                      </label>
                      <ScanScheduleSelect
                        value={frequency}
                        disabled={changing}
                        onChange={(value: UpdateTargetDtoScanSchedule) => {
                          if (!canChange()) return;
                          updateTarget.mutate({
                            id: target.id,
                            data: {
                              scanSchedule: value,
                            },
                          });
                        }}
                      />
                    </div>
                  </div>
                </div>
              </div>

              {isGitOrg && (
                <div className="space-y-3 p-2">
                  <div className="flex items-center gap-3">
                    <div className="p-2.5 rounded-lg bg-purple-100 dark:bg-purple-900/30">
                      <GitFork className="h-4 w-4 text-purple-600 dark:text-purple-400" />
                    </div>
                    <p className="text-sm font-medium">Repositories to scan</p>
                  </div>
                  <div className="flex items-center justify-between gap-2 pl-12">
                    <Label
                      htmlFor="setting-include-archived"
                      className="font-normal"
                    >
                      Archived repositories
                    </Label>
                    <Switch
                      id="setting-include-archived"
                      disabled={changing}
                      checked={gitOrgSettings.includeArchived === true}
                      onCheckedChange={(checked) =>
                        updateGitOrgSetting('includeArchived', checked)
                      }
                    />
                  </div>
                  <div className="flex items-center justify-between gap-2 pl-12">
                    <Label
                      htmlFor="setting-include-forks"
                      className="font-normal"
                    >
                      Forks
                    </Label>
                    <Switch
                      id="setting-include-forks"
                      disabled={changing}
                      checked={gitOrgSettings.includeForks === true}
                      onCheckedChange={(checked) =>
                        updateGitOrgSetting('includeForks', checked)
                      }
                    />
                  </div>
                </div>
              )}

              <div className="space-y-0.5">
                <div className="space-y-1">
                  <ConfirmDialog
                    title={
                      isGitOrg ? 'Sync repositories' : 'Re-discover target'
                    }
                    description={
                      isGitOrg
                        ? 'This fetches the repository list from the provider again.'
                        : 'This will initiate a new scan of the target. The process might take a few minutes to complete.'
                    }
                    onConfirm={() => {
                      if (!canChange()) return;
                      setIsRediscovering(true);
                      rediscoverTarget(
                        {
                          id: target.id,
                        },
                        {
                          onError: (e) => {
                            const err = e as AxiosError<{ message: string }>;
                            toast.error(
                              err.response?.data.message ??
                                'Failed to re-discover target',
                            );
                          },
                          onSuccess: () => {
                            toast.success('Target re-discovered successfully');
                            setIsRediscovering(false);
                            if (
                              inline &&
                              workspaceId === getGlobalWorkspaceId()
                            ) {
                              void navigate({
                                to: '/targets/$id/$tab',
                                params: { id: target.id, tab: 'assets' },
                                search: { animation: 'true' },
                              });
                            }
                          },
                        },
                      );
                      if (!inline) {
                        void navigate({
                          to: '/targets/$id/$tab',
                          params: {
                            id: target.id,
                            tab: isGitOrg ? 'repositories' : 'assets',
                          },
                          search: isGitOrg
                            ? {}
                            : { animation: 'true', page: 1, pageSize: 100 },
                        });
                        setIsSheetOpen(false);
                      }
                    }}
                    trigger={
                      <Button
                        variant="ghost"
                        className="w-full justify-start h-12 text-left p-2"
                        disabled={
                          changing || target.status !== JobStatus.completed
                        }
                      >
                        <div className="flex items-center gap-3">
                          <div className="p-2.5 rounded-lg bg-blue-100 dark:bg-blue-900/30">
                            <RefreshCw
                              className={`h-4 w-4 text-blue-600 dark:text-blue-400 ${isRediscovering ? 'animate-spin' : ''}`}
                            />
                          </div>
                          <div className="flex-1">
                            <p className="font-medium">
                              {isGitOrg
                                ? 'Sync Repositories'
                                : 'Re-discover Target'}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {target.status !== JobStatus.completed
                                ? 'Target is currently being processed'
                                : isGitOrg
                                  ? 'Fetch new, renamed and removed repositories'
                                  : 'Scan the target again for changes'}
                            </p>
                          </div>
                          {target.status !== JobStatus.completed && (
                            <Clock className="h-4 w-4 text-muted-foreground" />
                          )}
                        </div>
                      </Button>
                    }
                  />
                </div>
              </div>
            </div>
          </div>
          {scanActions && (
            <div className="flex flex-wrap gap-2 p-2">{scanActions}</div>
          )}
        </div>

        {canDelete && (
          <SheetFooter className={inline ? 'border-t p-2 pt-4' : 'p-4 mt-auto'}>
            {inline && (
              <h3 className="font-medium text-destructive">Danger zone</h3>
            )}
            <div className={inline ? 'flex' : 'flex justify-center'}>
              <ConfirmDialog
                title="Delete target"
                description="This action cannot be undone. This will permanently delete the target and all its data."
                onConfirm={() => {
                  if (!canChange()) return;
                  setIsDeleting(true);
                  deleteTarget(
                    { id: target.id },
                    {
                      onSuccess: () => {
                        if (workspaceId !== getGlobalWorkspaceId()) return;
                        if (inline) void navigate({ to: '/targets' });
                        else window.history.back();
                      },
                    },
                  );
                }}
                typeToConfirm={target.value}
                trigger={
                  <Button
                    variant="outline"
                    className="w-fit text-red-500 hover:bg-red-50 hover:text-red-600"
                    disabled={changing || isDeleting}
                  >
                    {isDeleting ? (
                      <>
                        <RefreshCw className="mr-2 h-4 w-4 animate-spin text-red-500 hover:text-red-600" />
                        Deleting...
                      </>
                    ) : (
                      <>
                        <Trash2 className="mr-2 h-4 w-4 text-red-500 hover:text-red-600" />
                        Delete Target
                      </>
                    )}
                  </Button>
                }
              />
            </div>
          </SheetFooter>
        )}
      </Surface>
    </SettingsFrame>
  );
};

export default SettingTarget;
