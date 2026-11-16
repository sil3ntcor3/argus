import { ForbiddenException } from '@nestjs/common';
import type { Tool } from 'ai';
import type { AgentToolDeps, ToolCallOptions, ToolScope } from './types';

export const PROJECT_READ_TOOLS: ReadonlySet<string> = new Set(['list_projects', 'inspect_project', 'read_project_file', 'list_project_assets', 'list_project_runs', 'list_workflow_templates', 'list_pipeline_tools']);
const WRITES = new Set(['create_project', 'add_targets', 'update_project_scope', 'add_project_workflow', 'remove_project_workflow', 'add_project_trigger', 'remove_project_trigger', 'install_tool', 'update_project_instruction', 'add_assets_to_project', 'remove_assets_from_project', 'run_project_workflow']);
const DATA: Readonly<Record<string, string[]>> = {
  enumerate_assets: ['asset.read'], inspect_asset: ['asset.read'], examine_target_assets: ['target.read', 'asset.read'],
  discover_vulnerabilities: ['vulnerability.read'], investigate_vulnerability: ['vulnerability.read'],
  list_network_ports: ['asset.read'], fingerprint_technologies: ['asset.read'], verify_tls_settings: ['asset.read'],
  retrieve_targets: ['target.read'], review_jobs: ['job.read'], list_project_assets: ['asset.read'], list_project_runs: ['job.read'],
  gather_statistics: ['asset.read', 'vulnerability.read', 'job.read'],
};

/** Recheck current membership, domain permissions and scope after approval, at execution. */
export function withProjectAccess(name: string, tool: Tool, deps: AgentToolDeps, workspaceId: string, scope: ToolScope): Tool {
  const original = tool.execute;
  if (!original) return tool;
  return { ...tool, execute: async (input: unknown, options: ToolCallOptions = { toolCallId: 'mcp' }) => {
    options.abortSignal?.throwIfAborted();
    const params = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const projectId = scope.projectId ?? (typeof params.projectId === 'string' ? params.projectId : undefined);
    if (!PROJECT_READ_TOOLS.has(name) && !WRITES.has(name) && !projectId) return original(input, options as never) as Promise<unknown>;
    if (!scope.userId) throw new ForbiddenException('No authenticated user for project tools');
    const { permissionKeys } = await deps.workspacesService.getMembershipWithPermissions(workspaceId, scope.userId);
    const required = [...(WRITES.has(name) ? [name === 'install_tool' ? 'workspace.write' : name === 'add_targets' && !projectId ? 'target.write' : 'project.write'] : ['project.read']), ...(DATA[name] ?? [])];
    if (name === 'run_project_workflow' || (name === 'create_project' && params.runNow)) required.push('workflow.write');
    for (const key of required) if (!permissionKeys.includes('*') && !permissionKeys.includes(key) && !(key.endsWith('.read') && permissionKeys.includes(key.replace(/\.read$/, '.write')))) throw new ForbiddenException(`Requires ${key}`);
    if (projectId) {
      if (['enumerate_open_issues', 'inspect_issue'].includes(name)) throw new ForbiddenException('Use project findings in a project conversation');
      await deps.projectsService.assertToolScope(name, projectId, workspaceId, params, WRITES.has(name));
    }
    options.abortSignal?.throwIfAborted();
    if (projectId && name === 'retrieve_targets') return deps.projectsService.targets(projectId, workspaceId, params);
    if (projectId && name === 'review_jobs') return deps.projectsService.jobs(projectId, workspaceId, params);
    return original(input, options as never) as Promise<unknown>;
  } };
}
