import { type ColumnDef } from '@tanstack/react-table';
import dayjs from 'dayjs';
import duration from 'dayjs/plugin/duration';
import relativeTime from 'dayjs/plugin/relativeTime';
dayjs.extend(duration);
dayjs.extend(relativeTime);

import { DataTable } from '@/components/ui/data-table';
import { DataTableError } from '@/components/ui/data-table-error-boundary';
import { scanScheduleOptions } from '@/components/scan-schedule-options';
import {
  JobStatus,
  TargetScopeType,
  TargetType,
  useTargetsControllerGetTargetsInWorkspace,
} from '@/services/apis/gen/queries';
import { useEffect, useRef, useState } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Image from '@/components/ui/image';
import LogoFrame from '@/components/ui/logo-frame';
import JobStatusBadge from '@/components/ui/job-status';
import { usePermission } from '@/hooks/usePermission';
import { useServerDataTable } from '@/hooks/useServerDataTable';
import { useWorkspaceSelector } from '@/hooks/useWorkspaceSelector';
import { useSession } from '@/utils/authClient';
import type { GetManyTargetResponseDto } from '@/services/apis/gen/queries';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { isAxiosError } from 'axios';
import { ScanStatusFilter } from './components/scan-status-filter';
import { ScopeFilter } from './components/scope-filter';
import { StartDiscoveryButton } from './components/start-discovery-button';
import { TargetBulkActions } from './components/target-bulk-actions';
import { TargetLogo } from './components/target-logo';
import { TargetTypeBadge } from './components/target-type-badge';
import { TargetTypeFilter } from './components/target-type-filter';

interface TargetSourceCellProps {
  icon: string;
  source: string;
}

/** Source icon: tooltip on hover, navigates to the integration on click. */
function TargetSourceCell({ icon, source }: TargetSourceCellProps) {
  const navigate = useNavigate();
  // ponytail: appType parsed from icon path; cleaner would be exposing the raw source id in TargetSourceDto
  const tool = icon.split('/').pop()?.replace(/.svg$/, '') ?? '';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="flex cursor-pointer"
          onClick={(e) => {
            e.stopPropagation();
            navigate({
              to: '/integrations',
              search: { tab: 'connected', tool } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
            });
          }}
        >
          <LogoFrame className="rounded-md">
            <Image url={icon} width={16} height={16} />
          </LogoFrame>
        </span>
      </TooltipTrigger>
      <TooltipContent>Sync from {source}</TooltipContent>
    </Tooltip>
  );
}

const targetColumns: ColumnDef<GetManyTargetResponseDto>[] = [
  {
    accessorKey: 'value',
    header: 'Target',
    cell: ({ row }) => (
      <div className="flex items-center gap-2">
        <TargetLogo url={row.original.logo} />
        <span className="font-medium">{row.getValue('value')}</span>

        {row.original.source?.icon && (
          <TargetSourceCell
            icon={row.original.source.icon}
            source={row.original.source.source}
          />
        )}
        {row.original.internalNetworkId && (
          <Badge variant="secondary" className="text-xs">
            Internal
          </Badge>
        )}
      </div>
    ),
  },
  {
    accessorKey: 'type',
    header: 'Type',
    enableSorting: false,
    cell: ({ row }) => <TargetTypeBadge type={row.original.type} />,
  },
  {
    accessorKey: 'totalAssetServices',
    header: () => (
      <div className="flex flex-col">
        <span>Surface</span>
        <span className="text-xs font-normal text-muted-foreground">
          Sort by services
        </span>
      </div>
    ),
    cell: ({ row }) => {
      const { type, totalAssets, totalAssetServices } = row.original;
      // A Git organization has no services; its size is its repositories.
      if (type === TargetType.GIT_ORG) {
        return (
          <span className="font-medium">
            {totalAssets} {totalAssets === 1 ? 'repository' : 'repositories'}
          </span>
        );
      }
      return (
        <div className="flex flex-col">
          <span className="font-medium">
            {totalAssetServices}{' '}
            {totalAssetServices === 1 ? 'service' : 'services'}
          </span>
          <span className="text-muted-foreground">
            {totalAssets} {totalAssets === 1 ? 'asset' : 'assets'}
          </span>
        </div>
      );
    },
  },
  // {
  //   accessorKey: 'duration',
  //   header: 'Duration',
  //   cell: ({ row }) => {
  //     const status = row.getValue('status');
  //     if (status === 'in_progress') {
  //       return null;
  //     }

  //     const value: number = parseInt(row.getValue('duration'));
  //     const duration = dayjs.duration(value, 'seconds');
  //     const hours = duration.hours();
  //     const minutes = duration.minutes();
  //     const seconds = duration.seconds();

  //     return (
  //       <div className="text-gray-400 font-semibold">
  //         {hours > 0 && `${hours}h`}
  //         {minutes > 0 && `${minutes}m`}
  //         {seconds > 0 && `${seconds}s`}
  //       </div>
  //     );
  //   },
  // },
  {
    accessorKey: 'lastDiscoveredAt',
    header: 'Discovery',
    cell: ({ row }) => {
      const { lastDiscoveredAt, scanSchedule } = row.original;
      const discovered = lastDiscoveredAt ? dayjs(lastDiscoveredAt) : null;
      const schedule =
        !scanSchedule || scanSchedule === 'disabled'
          ? 'Manual'
          : (scanScheduleOptions.find(({ value }) => value === scanSchedule)
              ?.label ?? 'Scheduled');
      return (
        <div className="flex flex-col">
          {discovered ? (
            <time className="flex flex-col" dateTime={lastDiscoveredAt}>
              <span>{discovered.fromNow()}</span>
              <span className="text-xs text-muted-foreground">
                {discovered.format('MMM D, YYYY HH:mm')}
              </span>
            </time>
          ) : (
            <span>Never</span>
          )}
          <span className="text-muted-foreground">{schedule}</span>
        </div>
      );
    },
  },
  {
    accessorKey: 'status',
    header: 'Scan status',
    cell: ({ row }) => {
      const value: JobStatus = row.getValue('status');
      return <JobStatusBadge status={value} />;
    },
  },
];

const routeApi = getRouteApi('/_authed/targets/');
const targetViews = [
  { value: 'all', label: 'All targets' },
  { value: 'critical', label: 'Open critical findings' },
  { value: 'stale', label: 'Stale targets' },
] as const;
type TargetView = (typeof targetViews)[number]['value'];
const criticalAccessMessage =
  'The critical findings view requires vulnerability read access.';

/** A background refresh can reject a view after its rows were cached. */
function isAccessDenied(error: unknown) {
  return isAxiosError(error) && [401, 403].includes(error.response?.status ?? 0);
}

export function ListTargets() {
  const { selectedWorkspace: selectedWorkspaceId, workspaces } = useWorkspaceSelector();
  const { data: session } = useSession();
  const permission = usePermission();
  const targetList = useRef<HTMLElement>(null);
  const canSchedule = Boolean(selectedWorkspaceId) && permission.hasPermission('target.write');
  const canDelete = canSchedule && workspaces.some(
    (workspace) => workspace.id === selectedWorkspaceId && workspace.ownerId === session?.user.id,
  );
  const [selection, setSelection] = useState<{
    scope: string;
    rows: Record<string, boolean>;
  }>({ scope: '', rows: {} });
  const navigate = routeApi.useNavigate();
  const search = routeApi.useSearch();
  const canReadFindings =
    !permission.error && permission.hasPermission('vulnerability.read');
  const view: TargetView =
    search.view === 'stale' || (search.view === 'critical' && canReadFindings)
      ? search.view
      : 'all';
  const deniedLink =
    search.view === 'critical' && !permission.isLoading && !canReadFindings;
  const criticalView = view === 'critical';
  const refreshPermissions = permission.refetch;

  /** Preserve table filters and return to the first page for the new view. */
  function changeView(next: TargetView) {
    void navigate({
      search: (previous) => ({
        ...previous,
        view: next === 'all' ? undefined : next,
        page: 1,
      }),
      replace: true,
    });
  }

  // Initialize type filter from URL params
  const urlType = search.type as TargetType | undefined;
  const [typeFilter, setTypeFilter] = useState<TargetType | undefined>(
    urlType ?? undefined,
  );

  // Initialize status filter from URL params
  const urlStatus = search.status as JobStatus | undefined;
  const [statusFilter, setStatusFilter] = useState<JobStatus | undefined>(
    urlStatus ?? undefined,
  );

  // Initialize scope filter from URL params
  const urlScope = search.scope as TargetScopeType | undefined;
  const [scopeFilter, setScopeFilter] = useState<TargetScopeType | undefined>(
    (urlScope as TargetScopeType) ?? undefined,
  );

  /** Sync type filter to URL search params */
  const handleTypeFilterChange = (newType: TargetType | undefined) => {
    setTypeFilter(newType);
    navigate({
      search: ((prev: Record<string, unknown>) => ({
        ...prev,
        type: newType || undefined,
      })) as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      replace: true,
    });
  };

  /** Sync status filter to URL search params */
  const handleStatusFilterChange = (newStatus: JobStatus | undefined) => {
    setStatusFilter(newStatus);
    navigate({
      search: ((prev: Record<string, unknown>) => ({
        ...prev,
        status: newStatus || undefined,
      })) as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      replace: true,
    });
  };

  /** Sync scope filter to URL search params */
  const handleScopeFilterChange = (newValue: TargetScopeType | undefined) => {
    setScopeFilter(newValue);
    navigate({
      search: ((prev: Record<string, unknown>) => ({
        ...prev,
        scope: newValue || undefined,
      })) as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      replace: true,
    });
  };

  const {
    tableParams: { page, pageSize, sortBy, sortOrder, filter },
    tableHandlers: { setPage, setPageSize, setFilter, setParams },
  } = useServerDataTable();

  const listKey = [
    'targets',
    selectedWorkspaceId,
    pageSize,
    page,
    sortBy,
    sortOrder,
    filter,
    typeFilter,
    statusFilter,
    scopeFilter,
    view,
  ];
  const { data, error, isFetchedAfterMount, isLoading, refetch } =
    useTargetsControllerGetTargetsInWorkspace(
      {
        limit: pageSize,
        page,
        sortBy,
        sortOrder,
        value: filter,
        type: typeFilter,
        status: statusFilter,
        scope: scopeFilter,
        hasCritical: criticalView || undefined,
        stale: view === 'stale' || undefined,
      },
      {
        query: {
          refetchInterval: ({ state }) =>
            criticalView && isAccessDenied(state.error) ? false : 3000,
          refetchOnMount: criticalView ? 'always' : undefined,
          queryKey: listKey,
        },
      },
    );

  const deniedResults = criticalView && isAccessDenied(error);
  useEffect(() => {
    if (deniedResults) void refreshPermissions();
  }, [deniedResults, refreshPermissions]);

  // Every critical view entry needs a fresh server authorization, including
  // returning to a cached page or switching from a different set of filters.
  const visibleData =
    criticalView && (!isFetchedAfterMount || error) ? undefined : data;
  const loading =
    isLoading || (criticalView && !isFetchedAfterMount && !error);
  const selectionScope = JSON.stringify([listKey, canSchedule, deniedResults]);
  if (selection.scope !== selectionScope) {
    setSelection({ scope: selectionScope, rows: {} });
  }
  const targets = visibleData?.data ?? [];
  const total = visibleData?.total ?? 0;
  const selectedTargets =
    canSchedule && selection.scope === selectionScope
      ? targets.filter(({ id }) => selection.rows[id])
      : [];
  const rowSelection = Object.fromEntries(
    selectedTargets.map(({ id }) => [id, true]),
  );

  /** Drop only successful targets so the user can retry failures. */
  function removeCompleted(updated: string[]) {
    const completed = new Set(updated);
    setSelection((previous) =>
      previous.scope === selectionScope
        ? {
            scope: selectionScope,
            rows: Object.fromEntries(
              Object.entries(previous.rows).filter(([id]) => !completed.has(id)),
            ),
          }
        : previous,
    );
  }

  const handleRowClick = (target: GetManyTargetResponseDto) => {
    navigate({
      to: '/targets/$id/$tab',
      params: { id: target.id, tab: 'assets' },
    });
  };

  const results =
    !visibleData && !loading ? (
      <DataTableError
        message={
          deniedResults ? criticalAccessMessage : 'Failed to load targets.'
        }
        onRetry={refetch}
      />
    ) : (
      <DataTable
        data={targets}
        columns={targetColumns}
        getRowId={(target) => target.id}
        showCheckBox={canSchedule}
        rowSelection={rowSelection}
        onRowSelectionChange={(rows) => setSelection({ scope: selectionScope, rows })}
        selectionHeader={() => (
          <TargetBulkActions
            key={selectionScope}
            targets={selectedTargets}
            workspaceId={selectedWorkspaceId}
            canDelete={canDelete}
            focusTargets={() => targetList.current?.focus()}
            onComplete={removeCompleted}
            onClear={() => setSelection({ scope: selectionScope, rows: {} })}
          />
        )}
        isLoading={loading}
        page={page}
        pageSize={pageSize}
        sortBy={sortBy}
        sortOrder={sortOrder}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        onSortChange={(col, order) => {
          setParams({ sortBy: col, sortOrder: order });
        }}
        filterColumnKey="value"
        filterValue={filter}
        onFilterChange={setFilter}
        filterComponents={[
          <TargetTypeFilter
            key="type-filter"
            value={typeFilter}
            onValueChange={handleTypeFilterChange}
          />,
          <ScanStatusFilter
            key="status-filter"
            value={statusFilter}
            onValueChange={handleStatusFilterChange}
          />,
          <ScopeFilter
            key="scope-filter"
            value={scopeFilter}
            onValueChange={handleScopeFilterChange}
          />,
        ]}
        toolbarComponents={[<StartDiscoveryButton key="start-discovery" />]}
        totalItems={total}
        onRowClick={handleRowClick}
        rowClassName="cursor-pointer hover:bg-muted/50 transition-colors"
      />
    );

  return (
    <section
      ref={targetList}
      tabIndex={-1}
      aria-label="Target results"
      className="space-y-4"
    >
      <div
        role="group"
        aria-label="Target views"
        className="flex flex-wrap gap-2"
      >
        {targetViews
          .filter(({ value }) => value !== 'critical' || canReadFindings)
          .map(({ value, label }) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={value === view ? 'secondary' : 'outline'}
              aria-pressed={value === view}
              onClick={() => changeView(value)}
            >
              {label}
            </Button>
          ))}
      </div>
      {deniedLink ? (
        <p role="status" className="text-sm text-muted-foreground">
          {criticalAccessMessage}
        </p>
      ) : null}
      {results}
    </section>
  );
}
