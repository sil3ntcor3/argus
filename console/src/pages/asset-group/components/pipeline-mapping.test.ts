import { describe, expect, it } from 'vitest';
import { DataKind, type WorkflowJob } from '@/services/apis/gen/queries';
import { entriesFromContent, jobsFromEntries } from './pipeline-mapping';

const tools = [{ id: 'probe-id', name: 'httpx' }, { id: 'scan-id', name: 'nuclei' }, { id: 'ports-id', name: 'naabu' }];
const byName = new Map(tools.map((tool) => [tool.name, tool]));
const byId = new Map(tools.map((tool) => [tool.id, tool]));

describe('pipeline workflow mapping', () => {
  const jobs: Record<string, WorkflowJob> = {
    ports: { run: 'naabu' },
    probe: { run: 'httpx' },
    scan: {
      run: 'nuclei', name: 'Strict web scan', needs: ['probe'],
      input: [DataKind.web, DataKind.host], allowFailure: false,
      config: { severity: ['high'] }, configProfileId: 'profile-1',
    },
  };

  it('round-trips authored ids, ordered inputs and a non-barrier DAG unchanged', () => {
    const entries = entriesFromContent(jobs, byName);
    expect(entries.find((entry) => entry.toolId === 'scan-id')).toMatchObject({
      jobId: 'scan', stage: 2, input: ['web', 'host'],
    });
    expect(jobsFromEntries(entries, byId, jobs)).toEqual(jobs);
  });

  it('keeps topology and strict failure behavior when a profile changes', () => {
    const next = entriesFromContent(jobs, byName).map((entry) =>
      entry.toolId === 'scan-id' ? { ...entry, configProfileId: 'profile-2' } : entry,
    );
    expect(jobsFromEntries(next, byId, jobs)).toEqual({
      ...jobs, scan: { ...jobs.scan, configProfileId: 'profile-2' },
    });
  });

  it('rebuilds nearest-stage barriers after a stage change while retaining ids and metadata', () => {
    const next = entriesFromContent(jobs, byName).map((entry) =>
      entry.toolId === 'ports-id' ? { ...entry, stage: 5 } : entry,
    );
    const saved = jobsFromEntries(next, byId, jobs);
    expect(saved.ports.needs).toEqual(['scan']);
    expect(saved.scan.needs).toEqual(['probe']);
    expect(saved.scan).toMatchObject({ input: ['web', 'host'], name: 'Strict web scan', allowFailure: false });
  });

  it('reconnects remaining populated stages after removing an intermediate tool', () => {
    const chain = { ports: { run: 'naabu' }, probe: { run: 'httpx', needs: ['ports'] }, scan: { run: 'nuclei', needs: ['probe'] } };
    const next = entriesFromContent(chain, byName).filter((entry) => entry.toolId !== 'probe-id');
    expect(jobsFromEntries(next, byId, chain).scan.needs).toEqual(['ports']);
  });

  it('adds a root without overwriting a custom id used by another tool', () => {
    const existing = { nuclei: { run: 'naabu' } };
    const next = [...entriesFromContent(existing, byName), { toolId: 'scan-id' }];
    expect(jobsFromEntries(next, byId, existing)).toEqual({ nuclei: { run: 'naabu' }, nuclei_2: { run: 'nuclei' } });
  });

  it('preserves legacy array names and scalar dependencies on write', () => {
    const legacy = [{ name: 'Probe', run: 'httpx' }, { name: 'Scan', run: 'nuclei', needs: 'Probe' }];
    const entries = entriesFromContent(legacy, byName);
    expect(entries.map((entry) => entry.stage)).toEqual([1, 2]);
    expect(jobsFromEntries(entries, byId, legacy)).toEqual({
      Probe: { name: 'Probe', run: 'httpx' }, Scan: { name: 'Scan', run: 'nuclei', needs: ['Probe'] },
    });
  });

  it('retains uninstalled tools and leaves omitted stages parallel', () => {
    const existing = { unavailable: { run: 'unknown-tool' }, probe: { run: 'httpx' } };
    expect(jobsFromEntries(entriesFromContent(existing, byName), byId, existing)).toEqual(existing);
    expect(jobsFromEntries([{ toolId: 'probe-id' }, { toolId: 'scan-id' }], byId)).toEqual({ httpx: { run: 'httpx' }, nuclei: { run: 'nuclei' } });
  });

  it('keeps a legacy scalar input as one data kind', () => {
    const saved = { probe: { run: 'httpx', input: DataKind.host } };
    expect(entriesFromContent(saved, byName)[0].input).toEqual([DataKind.host]);
  });
});
