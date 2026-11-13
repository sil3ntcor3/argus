import { afterEach, describe, expect, it } from 'vitest';
import { setGlobalWorkspaceId } from '@/utils/workspaceState';
import { templateReadRequest } from './template-reads';

describe('shared template read transport', () => {
  afterEach(() => setGlobalWorkspaceId(null));
  it('shares one workspace lifetime across sidebar and overlay consumers', () => {
    setGlobalWorkspaceId('a');
    expect(templateReadRequest().signal).toBe(templateReadRequest().signal);
    expect(templateReadRequest().signal.aborted).toBe(false);
  });
  it('permanently aborts old and paused reads through an A-B-A switch', () => {
    setGlobalWorkspaceId('a'); const first = templateReadRequest().signal;
    setGlobalWorkspaceId('b'); const second = templateReadRequest().signal;
    setGlobalWorkspaceId('a');
    expect(first.aborted).toBe(true);
    expect(second.aborted).toBe(true);
    expect(templateReadRequest().signal.aborted).toBe(false);
    expect(templateReadRequest().signal).not.toBe(first);
  });
});
