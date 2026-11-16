import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AssetGroup } from '../asset-group/entities/asset-groups.entity';
import { AssetGroupWorkflow } from '../asset-group/entities/asset-groups-workflows.entity';
import { AssetGroupService } from '../asset-group/asset-group.service';
import { AssetGroupAssetService } from '../asset-group/asset-group-asset.service';
import { AssetGroupWorkflowService } from '../asset-group/asset-group-workflow.service';
import { JobRunType } from '@/common/enums/enum';
import type { GetManyBaseQueryParams } from '@/common/dtos/get-many-base.dto';
import { WorkflowJob } from '../workflows/entities/workflow.entity';
import { WorkflowRunnerService } from '../jobs-registry/workflow-runner.service';
import type { StartRunInput } from '../jobs-registry/workflow-runner.service';
import { Tool } from '../tools/entities/tools.entity';
import { ProjectMetadataReadService } from './project-metadata-read.service';
import { ProjectAssetsCommandService } from './project-assets-command.service';
import { ProjectAssetReadService } from './project-asset-read.service';
import { ProjectScopeWriteService } from './project-scope-write.service';
import type { ScopeRuleInput } from './project-scope-normalizer.service';
import { ProjectWorkflowCreateService } from './project-workflow-create.service';
import { ProjectTriggerCreateService } from './project-trigger-create.service';
import { ProjectTriggerReadService } from './project-trigger-read.service';
import { ProjectRunReadService } from './project-run-read.service';
import { ProjectFindingReadService } from './project-finding-read.service';
import type { GetProjectFindingsQueryDto } from './dto/project-findings.dto';
import { ProjectOverviewReadService } from './project-overview-read.service';
import { findProjectOrFail } from './project-access';
import { lockEditableProjectWorkflow } from './project-workflow-write-context';
import { getManyResponse } from '@/utils/getManyResponse';
import { AgentConversation } from '../agents/entities/agent-conversation.entity';

interface PipelineInput { name?: string; template?: string; tools?: { toolId: string }[] }
interface ProjectInput extends PipelineInput { name: string; description?: string; scopeRules?: ScopeRuleInput[]; workflowName?: string; schedule?: string; runNow?: boolean }

/** Adapt release-level AI actions to Argus's existing canonical services. */
@Injectable()
export class ProjectAgentService {
  constructor(private readonly db: DataSource, private readonly metadata: ProjectMetadataReadService,
    private readonly groups: AssetGroupService, private readonly assets: ProjectAssetReadService,
    private readonly candidatesService: AssetGroupAssetService, private readonly commands: ProjectAssetsCommandService,
    private readonly scopes: ProjectScopeWriteService, private readonly workflows: ProjectWorkflowCreateService,
    private readonly bindings: AssetGroupWorkflowService, private readonly triggers: ProjectTriggerCreateService,
    private readonly triggerRead: ProjectTriggerReadService, private readonly runRead: ProjectRunReadService,
    private readonly findingRead: ProjectFindingReadService, private readonly overviewRead: ProjectOverviewReadService,
    private readonly runner: WorkflowRunnerService) {}

  /** Read explicit private context without exposing it on compatibility APIs. */
  async getById(id: string, workspaceId: string) {
    const row = await findProjectOrFail(this.db.getRepository(AssetGroup), id, workspaceId);
    const view = await this.metadata.getById(id, workspaceId);
    const triggers = await this.triggerRead.list(id, workspaceId);
    return { ...view, archivedAt: row.archivedAt, projectWorkflows: (view.assetGroupWorkflows ?? []).map(binding => ({ ...binding,
      triggers: triggers.filter(trigger => trigger.projectWorkflowId === binding.id) })) };
  }

  /** Page project identities with archive filtering before loading canonical views. */
  async getMany(query: GetManyBaseQueryParams & { status?: 'active' | 'archived' | 'all' }, workspaceId: string) {
    const page = Math.max(1, query.page); const limit = Math.min(100, Math.max(1, query.limit));
    const where = `"workspaceId"=$1 AND name ILIKE $2${query.status === 'all' ? '' : query.status === 'archived' ? ' AND "archivedAt" IS NOT NULL' : ' AND "archivedAt" IS NULL'}`;
    const params = [workspaceId, `%${query.search ?? ''}%`];
    const [{ total }] = await this.db.query<{ total: number }[]>(`SELECT count(*)::int AS total FROM projects WHERE ${where}`, params);
    const rows = await this.db.query<{ id: string }[]>(`SELECT id FROM projects WHERE ${where} ORDER BY "createdAt" DESC,id LIMIT $3 OFFSET $4`, [...params, limit, (page - 1) * limit]);
    const data = await Promise.all(rows.map(row => this.getById(row.id, workspaceId)));
    return getManyResponse({ query: { ...query, page, limit }, data, total });
  }

  /** Preserve canonical member exclusions and provenance on AI writes. */
  async addAssets(id: string, workspaceId: string, ids: string[]) {
    await this.writable(id, workspaceId); return this.commands.add(id, workspaceId, ids);
  }
  async removeAssets(id: string, workspaceId: string, ids: string[]) {
    await this.writable(id, workspaceId); return this.commands.remove(id, workspaceId, ids);
  }
  list(id: string, workspaceId: string, query: GetManyBaseQueryParams) { return this.assets.list(id, workspaceId, query); }
  candidates(id: string, workspaceId: string, query: GetManyBaseQueryParams) { return this.candidatesService.getAssetsNotInAssetGroup(id, query, workspaceId); }
  runs(id: string, workspaceId: string, query: GetManyBaseQueryParams) { return this.runRead.list(id, workspaceId, query); }
  vulnerabilities(id: string, workspaceId: string, query: GetProjectFindingsQueryDto) { return this.findingRead.listForAgent(id, workspaceId, query); }
  overview(id: string, workspaceId: string): ReturnType<ProjectOverviewReadService['read']> { return this.overviewRead.read(id, workspaceId); }

  private writable(id: string, workspaceId: string) { return findProjectOrFail(this.db.getRepository(AssetGroup), id, workspaceId, { writable: true }); }

  /** Claim an unscoped chat and create its project atomically, without a long-lived DB lock. */
  async createLinked(input: { name: string; description?: string }, workspaceId: string, userId: string, conversationId: string, abortSignal?: AbortSignal) {
    const id = await this.db.transaction(async manager => {
      await manager.query('SELECT id FROM workspaces WHERE id=$1 FOR KEY SHARE', [workspaceId]);
      const [conversation] = await manager.query<unknown[]>('SELECT id FROM agent_conversations WHERE id=$1 AND "workspaceId"=$2 AND "createdBy"=$3 AND "projectId" IS NULL FOR UPDATE', [conversationId, workspaceId, userId]);
      if (!conversation) return null;
      abortSignal?.throwIfAborted();
      if (await manager.existsBy(AssetGroup, { name: input.name, workspace: { id: workspaceId } })) throw new BadRequestException('A project with this name already exists');
      const project = await manager.save(AssetGroup, manager.create(AssetGroup, { name: input.name, description: input.description?.trim() || null, workspace: { id: workspaceId } }));
      await manager.update(AgentConversation, { id: conversationId, workspaceId, createdBy: userId }, { projectId: project.id });
      abortSignal?.throwIfAborted();
      return project.id;
    });
    return id ? this.getById(id, workspaceId) : null;
  }

  /** Prevent exact-ID data tools from bypassing the conversation's recorded project. */
  async assertToolScope(name: string, id: string, workspaceId: string, params: Record<string, unknown>, writable: boolean) {
    await findProjectOrFail(this.db.getRepository(AssetGroup), id, workspaceId, { writable });
    if (name === 'inspect_asset') {
      const rows = await this.db.query<unknown[]>('SELECT 1 FROM project_assets pa JOIN assets a ON a.id=pa."assetId" JOIN asset_services s ON s."assetId"=a.id JOIN targets t ON t.id=a."targetId" WHERE pa."projectId"=$1 AND s.id=$2 AND t."workspaceId"=$3', [id, params.assetId, workspaceId]);
      if (!rows.length) throw new NotFoundException('Asset not found in project');
    }
    if (name === 'investigate_vulnerability') {
      const rows = await this.db.query<unknown[]>('SELECT 1 FROM project_vulnerabilities pv JOIN vulnerabilities v ON v.id=pv."vulnerabilityId" JOIN assets a ON a.id=v."assetId" JOIN targets t ON t.id=a."targetId" WHERE pv."projectId"=$1 AND v.id=$2 AND t."workspaceId"=$3', [id, params.vulnId ?? params.id, workspaceId]);
      if (!rows.length) throw new NotFoundException('Finding not found in project');
    }
  }

  /** Project-scoped versions of otherwise workspace-wide lookup tools. */
  async targets(id: string, workspaceId: string, params: Record<string, unknown>) {
    const page = Number(params.page ?? 1); const limit = Math.min(100, Number(params.limit ?? 100));
    const rows = await this.db.query<{ id: string; value: string }[]>(`SELECT DISTINCT t.id,t.value FROM project_assets pa JOIN assets a ON a.id=pa."assetId" JOIN targets t ON t.id=a."targetId" WHERE pa."projectId"=$1 AND t."workspaceId"=$2 AND t.value ILIKE $3 ORDER BY t.value,t.id`, [id, workspaceId, `%${typeof params.value === 'string' ? params.value : ''}%`]);
    return getManyResponse({ query: { page, limit, sortBy: 'value' }, data: rows.slice((page-1)*limit,page*limit), total: rows.length });
  }
  async jobs(id: string, workspaceId: string, params: Record<string, unknown>) {
    const page = Number(params.page ?? 1); const limit = Math.min(100, Number(params.limit ?? 100));
    const values: unknown[] = [id, workspaceId];
    let where = 'h."projectId"=$1 AND w."workspaceId"=$2';
    if (params.jobHistoryId) { values.push(params.jobHistoryId); where += ` AND h.id=$${values.length}`; }
    if (params.jobStatus) { values.push(params.jobStatus); where += ` AND j.status=$${values.length}`; }
    const from = 'FROM jobs j JOIN job_histories h ON h.id=j."jobHistoryId" JOIN workflows w ON w.id=h."workflowId"';
    const [{ total }] = await this.db.query<{ total: number }[]>(`SELECT COUNT(*)::int AS total ${from} WHERE ${where}`, values);
    const data = await this.db.query<{ id: string; status: string }[]>(`SELECT j.id,j.status ${from} WHERE ${where} ORDER BY j."createdAt" DESC,j.id LIMIT $${values.length+1} OFFSET $${values.length+2}`, [...values,limit,(page-1)*limit]);
    return getManyResponse({ query: { page, limit, sortBy: 'createdAt' }, data, total });
  }

  async update(id: string, input: { instruction?: string | null }, workspaceId: string) {
    await this.writable(id, workspaceId);
    await this.groups.updateAssetGroupById(id, {}, workspaceId, input);
    return this.getById(id, workspaceId);
  }

  /** Reuse normalization, synchronization and committed discovery events. */
  async replaceScope(id: string, workspaceId: string, rules: ScopeRuleInput[], autoAddAssets?: boolean) {
    await this.writable(id, workspaceId); return this.scopes.replaceRules(id, workspaceId, rules, autoAddAssets);
  }
  async patchScope(id: string, workspaceId: string, change: { add?: ScopeRuleInput[]; removeRuleIds?: string[]; autoAddAssets?: boolean }, abortSignal?: AbortSignal) {
    abortSignal?.throwIfAborted();
    return this.scopes.patchRules(id, workspaceId, change, abortSignal);
  }

  /** Materialize selected tools as an ordered graph through the approved workflow validator. */
  async addWorkflow(id: string, workspaceId: string, input: PipelineInput, abortSignal?: AbortSignal) {
    await this.writable(id, workspaceId);
    abortSignal?.throwIfAborted();
    if (!!input.template === !!input.tools?.length) throw new BadRequestException('Choose template or tools');
    if (input.template) return this.workflows.create(id, workspaceId, { template: input.template, name: input.name }, abortSignal);
    const jobs: Record<string, WorkflowJob> = {};
    for (const [index, selected] of (input.tools ?? []).entries()) {
      const tool = await this.db.getRepository(Tool).findOneBy({ id: selected.toolId });
      abortSignal?.throwIfAborted();
      if (!tool) throw new NotFoundException('Pipeline tool not found');
      jobs[`step_${index + 1}`] = { run: tool.name, ...(index ? { needs: [`step_${index}`] } : {}) };
    }
    return this.workflows.create(id, workspaceId, { jobs, name: input.name }, abortSignal);
  }

  /** Detach by binding identity, retaining Argus's historical run references. */
  async removeWorkflow(id: string, workspaceId: string, bindingId: string) {
    await this.writable(id, workspaceId);
    const binding = await this.db.getRepository(AssetGroupWorkflow).findOneBy({ id: bindingId, assetGroupId: id });
    if (!binding) throw new NotFoundException('Project workflow not found');
    return this.bindings.removeManyWorkflows(id, [binding.workflowId], workspaceId);
  }

  /** Create a project through existing writers, retaining disabled trigger defaults. */
  async create(input: ProjectInput, workspaceId: string, abortSignal?: AbortSignal) {
    abortSignal?.throwIfAborted();
    const project = await this.groups.create({ name: input.name }, workspaceId, { description: input.description });
    return this.configure(project.id, input, workspaceId, abortSignal);
  }

  async configure(id: string, input: ProjectInput, workspaceId: string, abortSignal?: AbortSignal) {
    abortSignal?.throwIfAborted();
    if (input.scopeRules?.length) await this.replaceScope(id, workspaceId, input.scopeRules);
    abortSignal?.throwIfAborted();
    if (input.template || input.tools?.length) {
      const binding = await this.addWorkflow(id, workspaceId, { ...input, name: input.workflowName }, abortSignal);
      abortSignal?.throwIfAborted();
      if (input.schedule) await this.triggers.create(id, workspaceId, { projectWorkflowId: binding.id, type: 'cron', cron: input.schedule });
      abortSignal?.throwIfAborted();
      if (input.runNow) await this.runWorkflow(id, workspaceId, binding.id, undefined, abortSignal);
    }
    return this.getById(id, workspaceId);
  }

  /** Validate the same current project/binding and enabled asset scope as trigger launches. */
  async runWorkflow(id: string, workspaceId: string, bindingId: string, assetIds?: string[], abortSignal?: AbortSignal) {
    abortSignal?.throwIfAborted();
    await this.writable(id, workspaceId);
    const binding = await this.db.getRepository(AssetGroupWorkflow).findOne({ where: { id: bindingId, assetGroupId: id }, relations: { workflow: { workspace: true } } });
    if (!binding || binding.workflow.workspace.id !== workspaceId) throw new NotFoundException('Project workflow not found');
    const input: StartRunInput = { workflow: binding.workflow, workspaceId, jobName: binding.workflow.name, jobRunType: JobRunType.MANUAL, projectId: id, projectWorkflowId: bindingId };
    const result = await this.runner.startRun(input, async manager => {
      const locked = await lockEditableProjectWorkflow(manager, id, workspaceId, bindingId);
      abortSignal?.throwIfAborted();
      if (locked.workflow.updatedAt.getTime() !== binding.workflow.updatedAt.getTime()) throw new BadRequestException('Workflow changed before launch');
      const rows = await manager.query<{ id: string }[]>(`SELECT a.id FROM project_assets pa JOIN assets a ON a.id=pa."assetId" JOIN targets t ON t.id=a."targetId" WHERE pa."projectId"=$1 AND t."workspaceId"=$2 AND a."isEnabled"=true${assetIds ? ' AND a.id=ANY($3::uuid[])' : ''} ORDER BY a.id FOR SHARE OF a`, assetIds ? [id, workspaceId, assetIds] : [id, workspaceId]);
      if (!rows.length || (assetIds && rows.length !== new Set(assetIds.map(value => value.toLowerCase())).size)) throw new BadRequestException('No eligible project asset scope');
      abortSignal?.throwIfAborted();
      input.assetIds = rows.map(row => row.id);
    });
    return { jobHistoryId: result.jobHistory?.id, message: 'Project workflow started' };
  }
}
