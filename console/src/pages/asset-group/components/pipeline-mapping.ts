import type { Tool, WorkflowJob } from '@/services/apis/gen/queries';
import type { PipelineToolEntry } from './tool-pipeline-builder';

type SavedJob = Omit<WorkflowJob, 'needs'> & { needs?: string[] | string };
type SavedJobs = Record<string, SavedJob> | SavedJob[];
type ToolRef = Pick<Tool, 'id' | 'name'>;

/** Match the API's legacy job identity rules before reading dependencies. */
function jobMap(saved: SavedJobs): Record<string, SavedJob> {
  return Array.isArray(saved)
    ? Object.fromEntries(saved.map((job, index) => [
        job.name?.trim() || job.run?.trim() || `job-${index + 1}`, job,
      ]))
    : saved;
}

/** Normalize legacy scalar needs without changing authored dependency order. */
function needsOf(job: SavedJob): string[] {
  return typeof job.needs === 'string' ? [job.needs] : job.needs ?? [];
}

/** Layer a saved DAG by its deepest dependency; malformed legacy cycles stop. */
function pipelineStages(jobs: Record<string, SavedJob>): Map<string, number> {
  const stages = new Map<string, number>();
  const visit = (id: string, path: Set<string>): number => {
    const known = stages.get(id);
    if (known !== undefined) return known;
    if (path.has(id)) return 1;
    path.add(id);
    const needs = needsOf(jobs[id]).filter((need) => need in jobs);
    const stage = 1 + Math.max(0, ...needs.map((need) => visit(need, path)));
    path.delete(id);
    stages.set(id, stage);
    return stage;
  };
  Object.keys(jobs).forEach((id) => visit(id, new Set()));
  return stages;
}

/** Retain each job's identity and input/config selections in the tool editor. */
export function entriesFromContent(
  saved: SavedJobs,
  toolsByName: ReadonlyMap<string, ToolRef>,
): PipelineToolEntry[] {
  const jobs = jobMap(saved), stages = pipelineStages(jobs);
  return Object.entries(jobs).map(([jobId, job]) => ({
    jobId, toolId: toolsByName.get(job.run)?.id ?? job.run,
    stage: stages.get(jobId) ?? 1,
    ...(job.category ? { category: job.category } : {}),
    ...(job.input?.length ? { input: [...job.input] } : {}),
    ...(job.config ? { config: job.config } : {}),
    ...(job.configProfileId ? { configProfileId: job.configProfileId } : {}),
  }));
}

/** Keep authored edges for metadata edits; rebuild stage barriers on topology edits. */
export function jobsFromEntries(
  entries: PipelineToolEntry[],
  toolsById: ReadonlyMap<string, ToolRef>,
  saved: SavedJobs = {},
): Record<string, WorkflowJob> {
  const previous = jobMap(saved), oldStages = pipelineStages(previous);
  const nameOf = (entry: PipelineToolEntry) => toolsById.get(entry.toolId)?.name ?? entry.toolId;
  const unchanged = Object.keys(previous).length === entries.length &&
    new Set(entries.map((entry) => entry.jobId)).size === entries.length &&
    entries.every((entry) => entry.jobId && previous[entry.jobId]?.run === nameOf(entry) &&
      (entry.stage ?? 1) === oldStages.get(entry.jobId));
  const used = new Set(entries.flatMap((entry) => entry.jobId ? [entry.jobId] : []));
  const ids = entries.map((entry) => {
    if (entry.jobId && previous[entry.jobId]) return entry.jobId;
    const name = nameOf(entry); let id = name, suffix = 2;
    while (used.has(id)) id = `${name}_${suffix++}`;
    used.add(id); return id;
  });
  const stages = [...new Set(entries.map((entry) => entry.stage ?? 1))].sort((a, b) => a - b);
  return Object.fromEntries(entries.map((entry, index) => {
    const old = entry.jobId ? previous[entry.jobId] : undefined;
    const position = stages.indexOf(entry.stage ?? 1);
    const needs = unchanged && old ? needsOf(old) : entries.flatMap((other, i) =>
      position > 0 && (other.stage ?? 1) === stages[position - 1] ? [ids[i]] : [],
    );
    return [ids[index], {
      ...(old?.name ? { name: old.name } : {}),
      ...(old?.allowFailure !== undefined ? { allowFailure: old.allowFailure } : {}),
      run: nameOf(entry),
      ...(entry.category ? { category: entry.category } : {}),
      ...(entry.input?.length ? { input: entry.input } : {}),
      ...(needs.length ? { needs } : {}),
      ...(entry.config ? { config: entry.config } : {}),
      ...(entry.configProfileId ? { configProfileId: entry.configProfileId } : {}),
    }];
  }));
}
