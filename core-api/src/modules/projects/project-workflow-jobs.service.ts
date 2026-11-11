import { WorkerType } from '@/common/enums/enum';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { In, type EntityManager } from 'typeorm';
import { ConnectorRegistryService } from '../connectors/connector-registry.service';
import { ToolConfigProfile } from '../tools/entities/tool-config-profiles.entity';
import { Tool } from '../tools/entities/tools.entity';
import { resolveToolCategory } from '../tools/tool-categories';
import { resolveStepInputs } from '../tools/tool-io';
import {
  deepMerge,
  decryptInlineConfig,
  encryptInlineConfig,
  getSensitiveFields,
  isMaskedValue,
} from '../tools/validators/tool-config-profiles.crypto';
import { validateProfileOrThrow } from '../tools/validators/tool-config-profiles.validator';
import { WorkflowJob } from '../workflows/entities/workflow.entity';
import {
  jobEntries,
  normalizeWorkflowContent,
  WorkflowGraphError,
  type WorkflowJobsInput,
} from '../workflows/workflow-graph';

/** JSONB cannot store NUL, including in an authored configuration value. */
function hasNul(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('\u0000');
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(
    ([key, item]) => key.includes('\u0000') || hasNul(item),
  );
}

@Injectable()
export class ProjectWorkflowJobsService {
  constructor(private readonly registry: ConnectorRegistryService) {}

  /** Validate the DAG and references before encrypting new connector secrets. */
  async prepare(
    manager: EntityManager,
    workspaceId: string,
    input: Record<string, WorkflowJob>,
    previous: WorkflowJobsInput,
    dek: Buffer | null,
  ): Promise<Record<string, WorkflowJob>> {
    const values = Object.values(input);
    if (
      !values.length ||
      values.length > 50 ||
      hasNul(input) ||
      Object.keys(input).some((id) =>
        Object.hasOwn(Object.prototype, id.trim()),
      )
    )
      throw new BadRequestException('Pipeline must contain 1–50 valid jobs');
    for (const value of values) {
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        validateSync(plainToInstance(WorkflowJob, value)).length
      )
        throw new BadRequestException('Invalid pipeline job');
    }
    let jobs: Record<string, WorkflowJob>;
    try {
      jobs = normalizeWorkflowContent({ jobs: input }).jobs;
    } catch (error) {
      if (!(error instanceof WorkflowGraphError)) throw error;
      throw new BadRequestException('Invalid pipeline graph');
    }
    const tools = await manager.find(Tool, {
      where: {
        name: In([...new Set(Object.values(jobs).map((job) => job.run))]),
      },
    });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const profiles = await manager.find(ToolConfigProfile, {
      where: {
        workspace: { id: workspaceId },
        tool: { id: In(tools.map((tool) => tool.id!)) },
      },
      relations: { tool: true },
      select: { id: true, isDefault: true, config: true, tool: { id: true } },
    });
    const byProfile = new Map(profiles.map((profile) => [profile.id, profile]));
    const storedJobs = new Map(jobEntries(previous));
    for (const [id, job] of Object.entries(jobs)) {
      const tool = byName.get(job.run);
      if (!tool) throw new NotFoundException('Pipeline tool not found');
      if (
        job.configProfileId &&
        byProfile.get(job.configProfileId)?.tool.id !== tool.id
      )
        throw new NotFoundException('Tool configuration profile not found');
      try {
        resolveStepInputs(
          tool.name,
          resolveToolCategory(tool, job.category),
          job.input,
        );
      } catch (error) {
        throw new BadRequestException((error as Error).message);
      }
      if (tool.type !== WorkerType.CONNECTOR) continue;
      const profile = job.configProfileId
        ? byProfile.get(job.configProfileId)
        : profiles.find(
            (profile) => profile.tool.id === tool.id && profile.isDefault,
          );
      if (!profile && !Object.keys(job.config ?? {}).length)
        throw new BadRequestException(
          `Tool "${tool.name}" requires configuration`,
        );
      const schema = this.registry.getConnector(tool.name)?.configSchema;
      const sensitive = getSensitiveFields(schema);
      const before = storedJobs.get(id);
      const stored = before?.run === job.run ? (before.config ?? {}) : {};
      const config = job.config ?? {};
      const keep = sensitive.filter(
        (field) =>
          Object.hasOwn(stored, field) &&
          (config[field] === stored[field] || isMaskedValue(config[field])),
      );
      const preserved = Object.fromEntries(
        keep.map((field) => [field, stored[field]]),
      );
      if (schema)
        validateProfileOrThrow(
          this.registry,
          tool.name,
          deepMerge(
            decryptInlineConfig(profile?.config ?? {}, sensitive, dek),
            { ...config, ...decryptInlineConfig(preserved, sensitive, dek) },
          ),
        );
      if (!job.config) continue;
      job.config = {
        ...encryptInlineConfig(
          config,
          sensitive.filter((field) => !keep.includes(field)),
          dek,
        ),
        ...preserved,
      };
    }
    return jobs;
  }
}
