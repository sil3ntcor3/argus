import { DataKind, ToolCategory } from '@/common/enums/enum';
import { buildPipelineJobs } from './pipeline';

describe('buildPipelineJobs', () => {
  it('runs tools of one stage in parallel and chains the stages', () => {
    expect(
      buildPipelineJobs([
        { run: 'subfinder', stage: 1 },
        { run: 'naabu', stage: 2 },
        { run: 'httpx', stage: 3 },
        { run: 'nuclei', stage: 4 },
        { run: 'screenshot', stage: 4 },
      ]),
    ).toEqual({
      subfinder: { run: 'subfinder' },
      naabu: { run: 'naabu', needs: ['subfinder'] },
      httpx: { run: 'httpx', needs: ['naabu'] },
      nuclei: { run: 'nuclei', needs: ['httpx'] },
      screenshot: { run: 'screenshot', needs: ['httpx'] },
    });
  });

  it("keeps a tool's chosen input on its job", () => {
    expect(
      buildPipelineJobs([
        { run: 'httpx', stage: 1 },
        { run: 'nuclei', stage: 2, input: [DataKind.WEB] },
      ]),
    ).toEqual({
      httpx: { run: 'httpx' },
      nuclei: { run: 'nuclei', input: ['web'], needs: ['httpx'] },
    });
  });

  it('treats a missing stage as stage 1 and skips gaps between stages', () => {
    expect(
      buildPipelineJobs([
        { run: 'naabu' },
        { run: 'httpx' },
        { run: 'nuclei', stage: 5 },
      ]),
    ).toEqual({
      naabu: { run: 'naabu' },
      httpx: { run: 'httpx' },
      nuclei: { run: 'nuclei', needs: ['naabu', 'httpx'] },
    });
  });

  it('keys a tool used in two categories by category', () => {
    const jobs = buildPipelineJobs([
      { run: 'nmap', category: ToolCategory.PORTS_SCANNER },
      { run: 'nmap', category: ToolCategory.VULNERABILITIES, stage: 2 },
    ]);
    expect(Object.keys(jobs)).toEqual([
      `nmap_${ToolCategory.PORTS_SCANNER}`,
      `nmap_${ToolCategory.VULNERABILITIES}`,
    ]);
    expect(jobs[`nmap_${ToolCategory.VULNERABILITIES}`].needs).toEqual([
      `nmap_${ToolCategory.PORTS_SCANNER}`,
    ]);
  });

  it('keeps config and profile references', () => {
    expect(
      buildPipelineJobs([
        { run: 'gitleaks', config: { scanHistory: false }, configProfileId: 'p-1' },
      ]),
    ).toEqual({
      gitleaks: {
        run: 'gitleaks',
        config: { scanHistory: false },
        configProfileId: 'p-1',
      },
    });
  });
});


describe('pipeline ordering compatibility', () => {
  it('keeps all roots parallel when stage is omitted', () => {
    expect(buildPipelineJobs([{ run: 'a' }, { run: 'b' }])).toEqual({
      a: { run: 'a' }, b: { run: 'b' },
    });
  });
  it('orders barriers by stage rather than entry order', () => {
    const jobs = buildPipelineJobs([
      { run: 'last', stage: 20 }, { run: 'first', stage: 1 },
      { run: 'middle', stage: 8 }, { run: 'peer', stage: 8 },
    ]);
    expect(jobs.last.needs).toEqual(['middle', 'peer']);
    expect(jobs.middle.needs).toEqual(['first']);
    expect(jobs.peer.needs).toEqual(['first']);
    expect(jobs.first.needs).toBeUndefined();
  });
  it('allows an empty pipeline', () => expect(buildPipelineJobs([])).toEqual({}));
});
