import AccessDenied from '@/components/common/access-denied';
import Page from '@/components/common/page';
import { Button } from '@/components/ui/button';
import JobStatusBadge from '@/components/ui/job-status';
import { usePermission } from '@/hooks/usePermission';
import {
  JobStatus,
  TargetType,
  useTargetsControllerGetTargetById,
} from '@/services/apis/gen/queries';
import {
  getRouteApi,
  Link,
  Navigate,
  useNavigate,
  useParams,
} from '@tanstack/react-router';
import dayjs from 'dayjs';
import { Loader2 } from 'lucide-react';
import { useEffect, useRef } from 'react';
import AssetProvider from '../assets/context/asset-context';
import { DiscoverUrlsDialog } from '../assets/components/discover-urls-dialog';
import { ListAssets } from '../assets/list-assets';
import { FastScanDialog } from '../vulnerabilities/components/fast-scan-dialog';
import { VulnerabilitiesView } from '../vulnerabilities/vulnerabilities-view';
import AssetsDiscovering from './assets-discovering';
import { GitOrgDetail } from './git-org-detail';
import { TargetActivityTab } from './components/target-activity-tab';
import { TargetChangesPanel } from './components/target-changes-panel';
import { TargetOverviewTab } from './components/target-overview-tab';
import { TargetSwitcher } from './components/target-switcher';
import SettingTarget from './setting-target';

const routeApi = getRouteApi('/_authed/targets/$id/$tab');

export function DetailTarget() {
  const { id, tab } = useParams({ from: '/_authed/targets/$id/$tab' });
  const { animation, tab: inventoryTab } = routeApi.useSearch();
  const permission = usePermission();
  const navigate = useNavigate({ from: '/targets/$id/$tab' });
  const sectionNav = useRef<HTMLElement>(null);
  const keyboardDestination = useRef<string>(null);
  useEffect(() => {
    const destination = keyboardDestination.current;
    keyboardDestination.current = null;
    if (destination === tab && document.activeElement === document.body) {
      sectionNav.current
        ?.querySelector<HTMLAnchorElement>('[aria-current="page"]')
        ?.focus();
    }
  }, [tab]);

  const {
    data: target,
    isLoading,
    error,
    refetch,
  } = useTargetsControllerGetTargetById(id || '', {
    query: { enabled: !!id, refetchInterval: 5000 },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin" />
      </div>
    );
  }

  if (error || !target) {
    return (
      <div className="text-center py-12">
        <h2 className="text-xl font-semibold">Target not found</h2>
        <p className="text-muted-foreground mt-2">
          The target you're looking for doesn't exist or you don't have
          permission to view it.
        </p>
        <Button className="mt-4" onClick={() => window.history.back()}>
          Go back
        </Button>
      </div>
    );
  }

  // A Git organization has repositories, not a host inventory.
  if (target.type === TargetType.GIT_ORG) {
    return <GitOrgDetail target={target} tab={tab} refetch={refetch} />;
  }

  const legacyInventory = tab === 'inventory' || tab === 'asset-services';
  const legacyFindings = inventoryTab === 'vulnerabilities';
  if (legacyInventory || legacyFindings) {
    return (
      <Navigate
        from="/targets/$id/$tab"
        to="/targets/$id/$tab"
        params={{ id, tab: legacyFindings ? 'vulnerabilities' : 'assets' }}
        search={(previous) => ({
          ...previous,
          ...(legacyFindings ? { tab: undefined } : {}),
        })}
        replace
      />
    );
  }

  const activeTab =
    tab === 'overview' ||
    tab === 'vulnerabilities' ||
    tab === 'activity' ||
    tab === 'settings'
      ? tab
      : 'assets';
  const canReadAssets = !permission.error && permission.hasPermission('asset.read');
  const canReadJobs = !permission.error && permission.hasPermission('job.read');
  const canReadActivity = canReadAssets || canReadJobs;
  const canChangeTarget = permission.hasPermission('target.write');
  const scanning = target.status !== JobStatus.completed;
  const scanTarget = { id: target.id, value: target.value };

  return (
    <Page
      permission="target.read"
      title={
        <TargetSwitcher
          currentTargetId={target.id}
          currentTargetValue={target.value}
          currentTargetLogo={target.logo}
        />
      }
      isShowButtonGoBack
      header={
        <div className="flex items-center gap-3 justify-between">
          <div className="flex items-center gap-3">
            <JobStatusBadge
              status={target.status}
              onClick={() => {
                const showAnimation =
                  target.status === JobStatus.pending ||
                  target.status === JobStatus.in_progress;
                void navigate({
                  to: '/targets/$id/$tab',
                  params: { id, tab: 'assets' },
                  search: { animation: showAnimation ? 'true' : undefined },
                  replace: true,
                });
              }}
            />
          </div>
          <div className="flex items-center gap-3">
            <p className="text-muted-foreground hidden md:block">
              {dayjs(target.lastDiscoveredAt).fromNow()}
            </p>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <nav
          ref={sectionNav}
          aria-label="Target sections"
          className="flex flex-wrap gap-2"
        >
          {[
            ...(canReadAssets ? [{ value: 'overview', label: 'Overview' }] : []),
            { value: 'assets', label: 'Assets' },
            { value: 'vulnerabilities', label: 'Vulnerabilities' },
            ...(canReadActivity ? [{ value: 'activity', label: 'Activity' }] : []),
            ...(canChangeTarget
              ? [{ value: 'settings', label: 'Settings' }]
              : []),
          ].map(({ value, label }) => (
            <Button
              key={value}
              asChild
              size="sm"
              variant={activeTab === value ? 'secondary' : 'ghost'}
            >
              <Link
                from="/targets/$id/$tab"
                to="/targets/$id/$tab"
                params={{ id, tab: value }}
                search={
                  activeTab === value
                    ? true
                    : (previous) => ({ ...previous, tab: undefined })
                }
                aria-current={activeTab === value ? 'page' : undefined}
              >
                {label}
              </Link>
            </Button>
          ))}
        </nav>
        {activeTab === 'overview' ? (
          canReadAssets ? (
            <TargetOverviewTab
              targetId={target.id}
              canManageDiscovery={canChangeTarget}
              canReadJobs={canReadJobs}
              onKeyboardNavigate={(destination) => {
                keyboardDestination.current = destination;
              }}
              onAccessDenied={permission.refetch}
            />
          ) : (
            <AccessDenied />
          )
        ) : activeTab === 'activity' ? (
          canReadActivity ? (
            <div
              className={
                canReadJobs && canReadAssets
                  ? 'grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]'
                  : undefined
              }
            >
              {canReadJobs && (
                <TargetActivityTab
                  key={`runs-${target.id}`}
                  targetId={target.id}
                  onAccessDenied={permission.refetch}
                />
              )}
              {canReadAssets && (
                <TargetChangesPanel
                  key={`changes-${target.id}`}
                  targetId={target.id}
                  onAccessDenied={permission.refetch}
                />
              )}
            </div>
          ) : (
            <AccessDenied />
          )
        ) : activeTab === 'settings' ? (
          canChangeTarget ? (
            <SettingTarget
              key={target.id}
              inline
              target={target}
              refetch={refetch}
              scanActions={
                <>
                  {permission.hasPermission('vulnerability.write') && (
                    <FastScanDialog target={scanTarget} disabled={scanning} />
                  )}
                  {target.type === TargetType.DOMAIN &&
                    permission.hasPermission('asset.write') && (
                      <DiscoverUrlsDialog
                        target={scanTarget}
                        disabled={scanning}
                      />
                    )}
                </>
              }
            />
          ) : (
            <AccessDenied />
          )
        ) : activeTab === 'vulnerabilities' ? (
          <VulnerabilitiesView
            targetId={target.id}
            actions={
              <FastScanDialog
                target={{ id: target.id, value: target.value }}
                disabled={target.status !== JobStatus.completed}
              />
            }
          />
        ) : (
          <>
            {animation &&
              (target.status === JobStatus.in_progress ||
                target.status === JobStatus.pending) && (
                <AssetsDiscovering targetId={target.id} />
              )}
            <AssetProvider
              targetId={target.id}
              refetchInterval={
                target.status === JobStatus.in_progress ? 1000 : 30 * 1000
              }
            >
              <ListAssets
                urlsActions={
                  target.type === TargetType.DOMAIN ? (
                    <DiscoverUrlsDialog
                      target={{ id: target.id, value: target.value }}
                      disabled={target.status !== JobStatus.completed}
                    />
                  ) : null
                }
              />
            </AssetProvider>
          </>
        )}
      </div>
    </Page>
  );
}

export default DetailTarget;
