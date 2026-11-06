import { describe, expect, it } from 'vitest';
import { workflowYaml } from '@/components/common/workflow-file-sheet';
import { parse } from 'yaml';

describe('workflowYaml', () => {
  it('orders numeric ids by dependencies and keeps numeric extras after named fields', () => {
    const stored = {
      0: 'extra',
      jobs: { 1: { run: 'nuclei', needs: ['2'] }, 2: { run: 'httpx' } },
      name: 'Argus',
    };
    const yaml = workflowYaml(stored);
    expect(yaml.startsWith('name:')).toBe(true);
    expect(yaml.indexOf('run: httpx')).toBeLessThan(
      yaml.indexOf('run: nuclei'),
    );
    expect(parse(yaml)).toEqual(stored);
  });

  it.each(['constructor', 'toString', '__proto__'])(
    'keeps missing inherited-name reference %s as data',
    (need) => {
      const stored = { jobs: { scan: { run: 'nuclei', needs: [need] } } };
      expect(parse(workflowYaml(stored))).toEqual(stored);
    },
  );
  it('reads as a file whatever order jsonb kept the keys in', () => {
    const stored = {
      jobs: {
        nuclei: { needs: ['httpx'], run: 'nuclei', input: ['web'] },
        httpx: { run: 'httpx', name: 'Probe' },
      },
      name: 'Web scan',
    };

    expect(workflowYaml(stored)).toBe(
      [
        'name: Web scan',
        'jobs:',
        '  httpx:',
        '    name: Probe',
        '    run: httpx',
        '  nuclei:',
        '    run: nuclei',
        '    input:',
        '      - web',
        '    needs:',
        '      - httpx',
        '',
      ].join('\n'),
    );
  });

  it('keeps a legacy jobs list and an empty definition as they are', () => {
    expect(workflowYaml({ name: 'Old', jobs: [{ run: 'naabu' }] })).toBe(
      'name: Old\njobs:\n  - run: naabu\n',
    );
    expect(workflowYaml(null)).toBe('');
  });

  it('preserves input order, strict failure policy and unknown fields without mutation', () => {
    const stored = {
      extra: 'keep',
      jobs: {
        scan: {
          run: 'nuclei',
          input: ['web', 'host'],
          allowFailure: false,
          configProfileId: 'profile',
          config: { severity: ['high'] },
          custom: 1,
        },
      },
      on: { schedule: 'disabled' },
      name: 'Argus',
    };
    const original = structuredClone(stored),
      yaml = workflowYaml(stored);
    expect(parse(yaml)).toEqual(original);
    expect(stored).toEqual(original);
    expect(yaml.indexOf('name:')).toBeLessThan(yaml.indexOf('on:'));
    expect(yaml.indexOf('on:')).toBeLessThan(yaml.indexOf('jobs:'));
  });

  it('displays malformed legacy dependency cycles and unknown references without hanging', () => {
    const jobs = {
      a: { run: 'a', needs: ['b'] },
      b: { run: 'b', needs: 'a' },
      c: { run: 'c', needs: ['missing'] },
    };
    expect(parse(workflowYaml({ jobs })).jobs).toEqual(jobs);
  });
});
