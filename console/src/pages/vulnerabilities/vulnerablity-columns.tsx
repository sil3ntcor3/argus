import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import Image from '@/components/ui/image';
import SeverityBadge from '@/components/ui/severity-badge';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { AnalyzeStatusButton } from '@/components/vulnerabilities/analyze-status-button';
import type { VulnerabilityLifecycleDto as Vulnerability } from '@/services/apis/gen/queries';
import { DetectionStatusBadge, SlaDue } from '@/components/vulnerabilities/lifecycle-badges';
import { isOpenFinding } from '@/components/vulnerabilities/lifecycle';
import { FindingSourceBadges } from '@/components/vulnerabilities/finding-sources';
import { Link } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { BellOff } from 'lucide-react';
import BadgeList from '../assets/components/badge-list';

export const vulnerabilityColumns: ColumnDef<Vulnerability, unknown>[] = [
  {
    id: 'select',
    header: ({ table }) => (
      <div className="flex items-center justify-center">
        <Checkbox
          checked={
            table.getIsAllPageRowsSelected() ||
            (table.getIsSomePageRowsSelected() && 'indeterminate')
          }
          onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
          aria-label="Select all"
          onClick={(e) => e.stopPropagation()}
        />
      </div>
    ),
    cell: ({ row }) => (
      <div
        className="flex items-center justify-center min-h-[60px]"
        onClick={(e) => e.stopPropagation()}
      >
        <Checkbox
          checked={row.getIsSelected()}
          onCheckedChange={(value) => row.toggleSelected(!!value)}
          aria-label="Select row"
        />
      </div>
    ),
    size: 50,
    enableSorting: false,
    enableHiding: false,
  },

  {
    accessorKey: 'severity',
    header: 'Severity',
    size: 120,
    cell: ({ row }) => {
      const value = String(row.getValue('severity')).toLowerCase();
      return (
        <div className="min-h-[60px] flex items-center">
          <SeverityBadge severity={value} />
        </div>
      );
    },
  },
  {
    accessorKey: 'name',
    header: 'Details',
    size: 480,
    enableHiding: false,
    cell: ({ row }) => {
      const value: string = row.getValue('name');
      const cveIds: string[] = row.original.cveId;
      return (
        <div className="flex flex-col gap-2 py-2 justify-center min-h-[60px] w-[480px] max-w-[480px]">
          <div className="flex items-center gap-2 min-w-0">
            <div className="font-medium truncate min-w-0 flex-1" title={value}>
              {value}
            </div>
            {Array.isArray(cveIds) && cveIds.length > 0 && (
              <BadgeList list={cveIds} maxDisplay={2} />
            )}
          </div>
          <FindingSourceBadges discoveredBy={row.original.discoveredBy} reviewStatus={row.original.reviewStatus} sources={row.original.sources} />
        </div>
      );
    },
  },
  {
    accessorKey: 'asset',
    header: 'Asset',
    size: 200,
    cell: ({ row }) => {
      const data = row.original;
      const value: string = data.asset?.value || data.affectedUrl;
      return <div className="flex items-center min-h-[60px]">{value}</div>;
    },
  },
  {
    accessorKey: 'tags',
    header: 'Tags',
    size: 150,
    cell: ({ row }) => {
      const tags = row.getValue('tags');
      if (!tags || !Array.isArray(tags)) {
        return (
          <div className="min-h-[60px] flex items-center">
            <div className="text-muted-foreground">Not matched</div>
          </div>
        );
      }

      const maxTagsDisplay = 3;
      const displayedTags = tags.slice(0, maxTagsDisplay);
      const remainingCount = tags.length - maxTagsDisplay;

      return (
        <div className="flex flex-wrap gap-1 max-w-[150px] min-h-[60px] items-center">
          {displayedTags.map((tag: string, index: number) => (
            <Badge variant="outline" key={index} className="text-xs">
              {tag}
            </Badge>
          ))}
          {remainingCount > 0 && (
            <Badge variant="outline" className="text-xs">
              +{remainingCount}
            </Badge>
          )}
        </div>
      );
    },
  },
  {
    accessorKey: 'firstDetectedDate',
    header: 'First Seen',
    size: 120,
    cell: ({ row }) => {
      const value: string = row.getValue('firstDetectedDate');
      return (
        <div className="min-h-[60px] flex items-center">
          {value ? (
            <div>{new Date(value).toLocaleDateString()}</div>
          ) : row.original.reviewStatus === 'pending_review' || row.original.reviewStatus === 'rejected' ? (
            <Badge variant="outline">{row.original.reviewStatus === 'pending_review' ? 'Pending review' : 'Rejected'}</Badge>
          ) : (
            <div className="text-muted-foreground">-</div>
          )}
        </div>
      );
    },
  },
  {
    accessorKey: 'lastSeenDate',
    header: 'Last Seen',
    size: 120,
    cell: ({ row }) => {
      const value: string = row.getValue('lastSeenDate');
      return (
        <div className="min-h-[60px] flex items-center">
          {value ? (
            <div>{new Date(value).toLocaleDateString()}</div>
          ) : (
            <div className="text-muted-foreground">-</div>
          )}
        </div>
      );
    },
  },
  {
    header: 'Scanned by',
    size: 200,
    cell: ({ row }) => {
      const { tool } = row.original;
      if (!tool)
        return (
          <div className="min-h-[60px] flex items-center justify-center">-</div>
        );
      return (
        <div className="min-h-[60px] flex items-center">
          <Link
            to="/tools/$id"
            params={{ id: tool.id }}
            className="flex items-center gap-2"
          >
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center gap-2 cursor-pointer">
                    <Image
                      url={tool?.logoUrl}
                      width={24}
                      height={24}
                      className="rounded"
                    />
                    <span className="text-sm font-medium">{tool.name}</span>
                  </div>
                </TooltipTrigger>
                <TooltipContent
                  side="bottom"
                  className="w-full max-w-[300px] p-2"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <Image
                      url={tool?.logoUrl}
                      width={40}
                      height={40}
                      className="rounded"
                    />
                    <h4 className="font-bold">{tool.name}</h4>
                  </div>
                  {tool.description && (
                    <p className="text-sm">{tool.description}</p>
                  )}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </Link>
        </div>
      );
    },
  },
  {
    id: 'status',
    header: 'Status',
    size: 100,
    cell: ({ row }) => {
      const dismissal = row.original.vulnerabilityDismissal;
      const isDismissed = !!dismissal;

      return (
        <div className="min-h-[60px] flex items-center">
          {isDismissed ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    variant="outline"
                    className="h-8 gap-1 border-transparent text-amber-500"
                  >
                    <BellOff className="h-4 w-4" />
                    Dismissed
                  </Badge>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-xs">
                  <div className="text-xs">
                    <span className="font-medium">Reason:</span>{' '}
                    {dismissal.reason === 'false_positive'
                      ? 'False positive'
                      : dismissal.reason === 'used_in_test'
                        ? 'Used in tests'
                        : dismissal.reason === 'risk_accepted'
                          ? 'Risk accepted'
                          : "Won't fix"}
                    {dismissal.comment && (
                      <>
                        <br />
                        <span className="font-medium">Comment:</span>{' '}
                        {dismissal.comment}
                      </>
                    )}
                  </div>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : (
            <DetectionStatusBadge status={row.original.detectionStatus} />
          )}
        </div>
      );
    },
    enableSorting: false,
  },
  {
    id: 'dueAt', header: 'SLA', size: 150, enableSorting: false,
    cell: ({ row }) => <SlaDue dueAt={row.original.dueAt} status={row.original.detectionStatus}
      paused={!isOpenFinding(row.original)} />,
  },
  {
    id: 'analyzeStatus',
    header: 'Analyze',
    size: 100,
    cell: ({ row }) => {
      const { id, analyzeStatus, analyzeResult } = row.original;
      return (
        <div className="min-h-15 flex items-center">
          <AnalyzeStatusButton
            id={id}
            status={analyzeStatus}
            result={analyzeResult}
          />
        </div>
      );
    },
    enableSorting: false,
  },
];
