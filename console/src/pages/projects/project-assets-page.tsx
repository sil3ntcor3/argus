import AccessDenied from '@/components/common/access-denied';
import Page from '@/components/common/page';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { usePermission } from '@/hooks/usePermission';
import { useWorkspaceState } from '@/hooks/useWorkspaceSelector';
import {
  type ProjectAssetDto,
  useProjectsControllerGetAssets,
} from '@/services/apis/gen/queries';
import { Link } from '@tanstack/react-router';
import { isAxiosError } from 'axios';
import type { ReactNode } from 'react';
import { projectRouteId } from './project-route-id';

const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

type AssetProps = {
  page: number;
  projectId: string;
  onChange: (page: number) => void;
};
type AssetLinks = { canOpenAssets: boolean; canOpenRuns: boolean };

function AssetCard({
  asset,
  canOpenAssets,
  canOpenRuns,
}: AssetLinks & { asset: ProjectAssetDto }) {
  const scan = asset.lastScan;
  const scannedAt = scan && date.format(new Date(scan.createdAt));
  const findings = Object.entries(asset.vulnerabilities).filter(
    ([, count]) => count > 0,
  );

  return (
    <li className="space-y-2 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium">
          {canOpenAssets ? (
            <Link
              to="/assets/services/$id"
              params={{ id: asset.id }}
              aria-label={`${asset.value} in target ${asset.targetValue}`}
              className="text-primary underline-offset-4 hover:underline focus-visible:underline"
            >
              {asset.value}
            </Link>
          ) : (
            asset.value
          )}
        </h2>
        <Badge variant="outline">
          {asset.source === 'rule' ? 'Scope rule' : 'Manual'}
        </Badge>
      </div>
      <p className="text-sm text-muted-foreground">
        Target {asset.targetValue}
      </p>
      {asset.rule && (
        <p className="text-sm text-muted-foreground">
          {asset.rule.label || asset.rule.value}
        </p>
      )}
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted-foreground">
        <span>
          Added{' '}
          <time dateTime={asset.addedAt}>
            {date.format(new Date(asset.addedAt))}
          </time>
        </span>
        {!scan ? (
          <span>No saved run scope includes this asset</span>
        ) : (
          <span>
            Latest run with this asset in scope{' '}
            {canOpenRuns ? (
              <Link
                to="/jobs/runs/$id"
                params={{ id: scan.runId }}
                aria-label={`${scannedAt}, latest run with ${asset.value} in scope`}
                className="text-primary underline-offset-4 hover:underline focus-visible:underline"
              >
                <time dateTime={scan.createdAt}>{scannedAt}</time>
              </Link>
            ) : (
              <time dateTime={scan.createdAt}>{scannedAt}</time>
            )}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>
          {findings.length
            ? 'Open project findings'
            : 'No open project findings'}
        </span>
        {findings.map(([severity, count]) => (
          <Badge key={severity} variant="secondary">
            {count} {severity}
          </Badge>
        ))}
      </div>
    </li>
  );
}

function AssetList({
  projectId,
  page,
  onChange,
  canOpenAssets,
  canOpenRuns,
}: AssetProps & AssetLinks) {
  const { data, error, isError, isPending, isFetching, refetch } =
    useProjectsControllerGetAssets(
      projectId,
      { page, limit: 20, sortOrder: 'DESC' },
      { query: { retry: false } },
    );
  const status = isAxiosError(error) ? error.response?.status : undefined;
  if (status === 403) return <AccessDenied />;
  if (status === 404) return <p role="status">Project not found</p>;

  let results: ReactNode;
  if (isError) {
    results = (
      <div className="flex flex-wrap items-center gap-3">
        <p role="status">Unable to load project assets</p>
        <Button
          variant="outline"
          disabled={isFetching}
          onClick={() => void refetch()}
        >
          Retry
        </Button>
      </div>
    );
  } else if (isPending || !data) {
    results = (
      <Skeleton
        role="status"
        aria-label="Loading project assets"
        className="h-32 rounded-xl"
      />
    );
  } else if (!data.data.length) {
    results = (
      <p role="status">
        {page > 1 ? 'No assets on this page' : 'No project assets found'}
      </p>
    );
  } else {
    results = (
      <ol aria-label="Project assets" className="space-y-2">
        {data.data.map((asset) => (
          <AssetCard
            key={asset.id}
            asset={asset}
            canOpenAssets={canOpenAssets}
            canOpenRuns={canOpenRuns}
          />
        ))}
      </ol>
    );
  }

  return (
    <div className="space-y-4">
      {results}
      <nav
        aria-label="Project asset pages"
        className="flex flex-wrap items-center gap-3"
      >
        <Button
          variant="outline"
          aria-disabled={page <= 1}
          className="aria-disabled:opacity-50"
          onClick={() => {
            if (page > 1)
              onChange(page > (data?.pageCount ?? page) ? 1 : page - 1);
          }}
        >
          Previous
        </Button>
        <span aria-live="polite">{data ? `Page ${page}` : ''}</span>
        <Button
          variant="outline"
          aria-disabled={!data?.hasNextPage}
          className="aria-disabled:opacity-50"
          onClick={() => {
            if (data?.hasNextPage) onChange(page + 1);
          }}
        >
          Next
        </Button>
      </nav>
    </div>
  );
}

/** Lists saved project memberships for authorized workspace readers. */
export function ProjectAssetsPage(props: AssetProps) {
  const { state } = useWorkspaceState();
  const permission = usePermission();
  const canRead =
    permission.hasPermission('project.read') ||
    permission.hasPermission('group.read');

  let content: ReactNode;
  if (!state.selectedWorkspaceId)
    content = <p role="status">Select a workspace</p>;
  else if (permission.isLoading)
    content = <p role="status">Loading project access</p>;
  else if (permission.error)
    content = <p role="status">Unable to load project access</p>;
  else if (!canRead) content = <AccessDenied />;
  else if (!projectRouteId.safeParse(props.projectId).success)
    content = <p role="status">Project not found</p>;
  else
    content = (
      <div className="space-y-4">
        <Link
          to="/projects/$id"
          params={{ id: props.projectId }}
          className="text-sm text-primary hover:underline"
        >
          Back to project overview
        </Link>
        <AssetList
          {...props}
          canOpenAssets={permission.hasPermission('asset.read')}
          canOpenRuns={permission.hasPermission('job.read')}
        />
      </div>
    );
  return (
    <Page title="Project assets" className="[overflow-wrap:anywhere]">
      {content}
    </Page>
  );
}
