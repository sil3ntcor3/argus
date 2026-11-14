import type { Tool } from 'ai';
import { z } from 'zod';

import { SortOrder } from '@/common/dtos/get-many-base.dto';
import { WorkerScope } from '@/common/enums/enum';
import { VulnerabilityStatus } from '@/modules/vulnerabilities/dto/get-vulnerability.dto';
import {
  detailAssetSchema,
  detailIssueSchema,
  detailVulnSchema,
  getAssetsSchema,
  getPortsSchema,
  getTargetsSchema,
  getTechnologiesSchema,
  getTlsSchema,
  getVulnerabilitiesSchema,
  listAssetsInTargetSchema,
  listIssuesSchema,
  listJobsSchema,
  listToolsSchema,
  listWorkersSchema,
} from '@/mcp/mcp.schema';

import {
  NEWEST_FIRST,
  assetsInProject,
  defineTool,
  failSoft,
  pageOf,
  projectFor,
  projectIdInput,
} from './helpers';
import type { Deps, ToolScope } from './types';

// Tools over the workspace's Argus data, offered in every agent mode. The
// project-aware ones take a projectId, or are locked to the conversation's.

const getAssetsInput = getAssetsSchema.extend(projectIdInput);
const getVulnerabilitiesInput = getVulnerabilitiesSchema.extend(projectIdInput);
const listAssetsInTargetInput = listAssetsInTargetSchema.extend(projectIdInput);
const getPortsInput = getPortsSchema.extend(projectIdInput);
const getTechnologiesInput = getTechnologiesSchema.extend(projectIdInput);
const getTlsInput = getTlsSchema.extend(projectIdInput);
const statisticsInput = z.object(projectIdInput);

export function getAssetsTool(
  deps: Deps<'assetsService'>,
  workspaceId: string,
  scope: ToolScope = {},
): Tool {
  return defineTool({
    description:
      'List discovered assets (domains, IPs, URLs) in the workspace. Params: page, limit, value (filter text), projectId.',
    inputSchema: getAssetsInput,
    execute: async (params: z.infer<typeof getAssetsInput>) => {
      const response = await deps.assetsService.getManyAsssetServices(
        {
          ...pageOf(params),
          ...NEWEST_FIRST,
          value: params.value,
          ...assetsInProject(projectFor(scope, params)),
        },
        workspaceId,
      );
      return {
        ...response,
        data: response.data.map((i) => ({ id: i.id, value: i.value })),
      };
    },
  });
}

export function getVulnerabilitiesTool(
  deps: Deps<'vulnerabilitiesService' | 'projectResultsService' | 'workspacesService'>,
  workspaceId: string,
  scope: ToolScope = {},
): Tool {
  return defineTool({
    description: [
      'List security findings, highest severity first, open by default. AI proposals require explicit pending_review/rejected status.',
      'Params: page, limit, q, status, severity, overdue, discoveredBy, tags, targetIds, createdFrom/createdTo (first detection), projectId.',
      'Workspace rows include asset, lifecycle/review state, discovery source, SLA deadline, detection count, detection dates, CVEs/CVSS, active dismissal and authorized linked issue context.',
      'With a project: only its recorded findings; q/status/severity apply. Workspace-only overdue/source/tag/target/date filters do not apply. Project rows include status, provenance, CVEs and tool.',
    ].join('\n'),
    inputSchema: getVulnerabilitiesInput,
    execute: async (params: z.infer<typeof getVulnerabilitiesInput>, options = { toolCallId: 'mcp' }) => {
      options.abortSignal?.throwIfAborted();
      const projectId = projectFor(scope, params);
      let canReadIssues = scope.workspaceApiKey === true;
      if (scope.userId) {
        const { permissionKeys } = await deps.workspacesService.getMembershipWithPermissions(workspaceId, scope.userId);
        const has = (key: string) => permissionKeys.includes('*') || permissionKeys.includes(key)
          || permissionKeys.includes(key.replace(/\.read$/, '.write'));
        if (!has('vulnerability.read')) throw new Error('Requires vulnerability.read');
        if (projectId && !has('project.read')) throw new Error('Requires project.read');
        canReadIssues = has('workspace.read');
      } else if (!scope.workspaceApiKey || projectId) {
        throw new Error('Finding reads require authenticated user context');
      }
      options.abortSignal?.throwIfAborted();
      if (projectId) {
        const found = await deps.projectResultsService.vulnerabilities(
          projectId,
          workspaceId,
          {
            ...pageOf(params),
            ...NEWEST_FIRST,
            search: params.q ?? '',
            status: params.status ?? VulnerabilityStatus.OPEN,
            severity: params.severity,
          },
        );
        options.abortSignal?.throwIfAborted();
        return {
          total: found.total,
          page: found.page,
          limit: found.limit,
          pageCount: found.pageCount,
          hasNextPage: found.hasNextPage,
          data: found.data.map((i) => ({
            id: i.id,
            name: i.name,
            severity: i.severity,
            asset: i.assetValue,
            status: i.status,
            provenance: i.provenance,
            cveId: i.cveId ?? null,
            tool: i.toolName ?? null,
          })),
        };
      }
      const response = await deps.vulnerabilitiesService.getVulnerabilities(
        { ...pageOf(params), sortBy: 'severity', sortOrder: SortOrder.DESC, q: params.q,
          status: params.status ?? VulnerabilityStatus.OPEN, severity: params.severity,
          overdue: params.overdue, discoveredBy: params.discoveredBy, tags: params.tags,
          targetIds: params.targetIds?.length ? params.targetIds : undefined,
          createdFrom: params.createdFrom, createdTo: params.createdTo },
        workspaceId, false, { userId: scope.userId, canReadIssues }, 'model',
      );
      options.abortSignal?.throwIfAborted();
      return {
        ...response,
        data: response.data.map((i) => ({
          id: i.id,
          name: i.name,
          severity: i.severity,
          asset: i.asset?.value ?? null,
          detectionStatus: i.detectionStatus, reviewStatus: i.reviewStatus, discoveredBy: i.discoveredBy,
          dueAt: i.dueAt ?? null, timesDetected: i.timesDetected,
          firstDetectedDate: i.firstDetectedDate ?? null, lastSeenDate: i.lastSeenDate ?? null,
          cveId: i.cveId ?? null, cvssScore: i.cvssScore ?? null,
          dismissal: i.vulnerabilityDismissal ? { reason: i.vulnerabilityDismissal.reason, expiresAt: i.vulnerabilityDismissal.expiresAt ?? null } : null,
          openIssue: canReadIssues && i.openIssue ? { id: i.openIssue.id, no: i.openIssue.no, status: i.openIssue.status } : null,
        })),
      };
    },
  });
}

export function getTargetsTool(
  deps: Deps<'targetsService'>,
  workspaceId: string,
): Tool {
  return defineTool({
    description:
      'Show scanning scope (root domains, IP ranges added by user). Params: page, limit, value (filter text).',
    inputSchema: getTargetsSchema,
    execute: async (params: z.infer<typeof getTargetsSchema>) => {
      const response = await deps.targetsService.getTargetsInWorkspace(
        { ...pageOf(params), ...NEWEST_FIRST, value: params.value },
        workspaceId,
      );
      return {
        ...response,
        data: response.data.map((i) => ({ id: i.id, value: i.value })),
      };
    },
  });
}

export function getStatisticsTool(
  deps: Deps<'statisticService' | 'projectResultsService'>,
  workspaceId: string,
  scope: ToolScope = {},
): Tool {
  return defineTool({
    description:
      "Return security dashboard summary: asset/vulnerability counts, severity breakdown, security score. Params: projectId (that project's overview instead: assets, open vulnerabilities by severity, runs, recent activity).",
    inputSchema: statisticsInput,
    execute: (params: z.infer<typeof statisticsInput>) => {
      const projectId = projectFor(scope, params);
      return projectId
        ? deps.projectResultsService.overview(projectId, workspaceId)
        : deps.statisticService.getStatistics(workspaceId);
    },
  });
}

export function detailAssetTool(
  deps: Deps<'assetsService'>,
  workspaceId: string,
): Tool {
  return defineTool({
    description: 'Get full technical details of a single asset by assetId.',
    inputSchema: detailAssetSchema,
    execute: (params: z.infer<typeof detailAssetSchema>) =>
      deps.assetsService.getAssetById(params.assetId, workspaceId),
  });
}

export function listAssetsInTargetTool(
  deps: Deps<'assetsService'>,
  workspaceId: string,
  scope: ToolScope = {},
): Tool {
  return defineTool({
    description:
      'List assets discovered from a specific target by targetId. Params: targetId, page, limit, value (filter), projectId.',
    inputSchema: listAssetsInTargetInput,
    execute: (params: z.infer<typeof listAssetsInTargetInput>) =>
      deps.assetsService.getManyAsssetServices(
        {
          ...pageOf(params),
          ...NEWEST_FIRST,
          targetIds: [params.targetId],
          value: params.value,
          ...assetsInProject(projectFor(scope, params)),
        },
        workspaceId,
      ),
  });
}

export function detailVulnTool(
  deps: Deps<'vulnerabilitiesService'>,
  workspaceId: string,
): Tool {
  return defineTool({
    description:
      'Get full vulnerability report with CVSS, PoC, remediation steps. Params: vulnId.',
    inputSchema: detailVulnSchema,
    execute: (params: z.infer<typeof detailVulnSchema>) =>
      deps.vulnerabilitiesService.getVulnerability(
        params.vulnId ?? params.id,
        workspaceId,
      ),
  });
}

export function getPortsTool(
  deps: Deps<'assetsService'>,
  workspaceId: string,
  scope: ToolScope = {},
): Tool {
  return defineTool({
    description:
      'List open network ports with asset counts. Params: page, limit, value (port number filter), projectId.',
    inputSchema: getPortsInput,
    execute: (params: z.infer<typeof getPortsInput>) =>
      deps.assetsService.getPortAssets(
        {
          ...pageOf(params),
          ...NEWEST_FIRST,
          value: params.value,
          ...assetsInProject(projectFor(scope, params)),
        },
        workspaceId,
      ),
  });
}

export function getTechnologiesTool(
  deps: Deps<'assetsService'>,
  workspaceId: string,
  scope: ToolScope = {},
): Tool {
  return defineTool({
    description:
      'List detected technologies (software, frameworks, servers). Params: page, limit, value (filter by name), projectId.',
    inputSchema: getTechnologiesInput,
    execute: (params: z.infer<typeof getTechnologiesInput>) =>
      deps.assetsService.getTechnologyAssets(
        {
          ...pageOf(params),
          ...NEWEST_FIRST,
          value: params.value,
          ...assetsInProject(projectFor(scope, params)),
        },
        workspaceId,
      ),
  });
}

export function getTlsTool(
  deps: Deps<'assetsService'>,
  workspaceId: string,
  scope: ToolScope = {},
): Tool {
  return defineTool({
    description:
      'List TLS/SSL certificates with issuer, subject, expiry. Params: page, limit, search (host name filter), projectId.',
    inputSchema: getTlsInput,
    execute: (params: z.infer<typeof getTlsInput>) =>
      deps.assetsService.getManyTls(
        {
          ...pageOf(params),
          sortBy: 'not_after',
          sortOrder: SortOrder.ASC,
          search: params.search,
          ...assetsInProject(projectFor(scope, params)),
        },
        workspaceId,
      ),
  });
}

/** Generic issue filters always run under the authenticated caller's current permissions. */
export function listIssuesTool(deps: Deps<'issuesService'>, workspaceId: string, scope: ToolScope = {}): Tool {
  return defineTool({
    description: 'List workspace work items by title or #number, status, type, priority, assigneeId, mine, overdue or resourceType/resourceId. Status: open, in_progress, resolved, closed. Types: vulnerability_remediation, task, asset_review, scan_failure.',
    inputSchema: listIssuesSchema,
    execute: (params: z.infer<typeof listIssuesSchema>) => failSoft('read issues', async () => {
      if (!scope.userId && !scope.workspaceApiKey) throw new Error('Issue reads require authenticated user context');
      return deps.issuesService.getMany({ ...params, ...pageOf(params), sortBy: 'updatedAt', sortOrder: SortOrder.DESC }, workspaceId, scope.userId);
    }),
  });
}

/** Issue details contain only the resource summaries the caller may currently read. */
export function detailIssueTool(deps: Deps<'issuesService'>, workspaceId: string, scope: ToolScope = {}): Tool {
  return defineTool({
    description: 'Get a workspace work item by issueId, with its fields, progress and authorized resource links.',
    inputSchema: detailIssueSchema,
    execute: (params: z.infer<typeof detailIssueSchema>) => failSoft('read issue', async () => {
      if (!scope.userId && !scope.workspaceApiKey) throw new Error('Issue reads require authenticated user context');
      return deps.issuesService.getById(params.issueId, workspaceId, scope.userId);
    }),
  });
}

/**
 * display_available_tools: the tools the agent can use in this workspace —
 * built-in tools plus the installed agent connectors — with their readiness.
 */
export function listConnectorsTool(
  deps: Deps<'toolsService'>,
  workspaceId: string,
): Tool {
  return defineTool({
    description: [
      'List the security tools/scanners the agent can use in this workspace: built-in tools and the installed connectors that support the agent.',
      'Each item: id, name, type (built_in or connector), categories (modes it can run in), description, isReady.',
      'A tool runs only when isReady is true; isReady=false means the connector still needs a config profile in this workspace.',
      'type decides how it runs: built_in → execute_remote_command with the tool name as the command; connector → run_tool_connector.',
      'Returns a JSON array, sorted by name. Params: q (search by name or description).',
    ].join('\n'),
    inputSchema: listToolsSchema,
    execute: async (params: z.infer<typeof listToolsSchema>) => {
      const tools = await deps.toolsService.getAgentTools(
        workspaceId,
        params.q,
      );
      return tools.map((i) => ({
        id: i.id,
        name: i.name,
        type: i.type,
        categories: (i.categories ?? []).map((c) => c.name),
        description: i.description,
        isReady: i.isReady,
      }));
    },
  });
}

export function listWorkersTool(
  deps: Deps<'workersService'>,
  workspaceId: string,
): Tool {
  return defineTool({
    description:
      'List connected worker nodes. Params: page, limit, q (search query).',
    inputSchema: listWorkersSchema,
    execute: async (params: z.infer<typeof listWorkersSchema>) => {
      // This workspace's own workers and the global ones
      const response = await deps.workersService.getWorkers(
        {
          ...pageOf(params),
          ...NEWEST_FIRST,
          search: params.q,
          enabledAgentMode: true,
        },
        { agentWorkspaceId: workspaceId },
      );
      return {
        ...response,
        data: response.data.map((i) => ({
          id: i.id,
          name: i.name,
          scope: i.scope === WorkerScope.CLOUD ? 'global' : 'workspace',
        })),
      };
    },
  });
}

export function listJobsTool(
  deps: Deps<'jobsRegistryService'>,
  workspaceId: string,
): Tool {
  return defineTool({
    description:
      'List background scan jobs with status. Params: page, limit, jobHistoryId, jobStatus (completed/failed/active).',
    inputSchema: listJobsSchema,
    execute: async (params: z.infer<typeof listJobsSchema>) => {
      const response = await deps.jobsRegistryService.getManyJobs(workspaceId, {
        ...pageOf(params),
        ...NEWEST_FIRST,
        jobHistoryId: params.jobHistoryId,
        jobStatus: params.jobStatus,
      });
      return {
        ...response,
        data: response.data.map((i) => ({ id: i.id, status: i.status })),
      };
    },
  });
}
