import { describe, expect, it } from 'vitest';
import {
  parseFindingSearch,
  withFindingSeverity,
} from './finding-search-query';

describe('finding search query syntax', () => {
  it('keeps ordinary text, unknown prefixes and invalid severity literals searchable', () => {
    expect(
      parseFindingSearch('  login unknown:literal severity:bogus  '),
    ).toEqual({
      value: 'login unknown:literal severity:bogus',
      severity: [],
    });
  });
  it('extracts recognized severity tokens case-insensitively and deduplicates them', () => {
    expect(
      parseFindingSearch(
        'severity:HIGH Severity:"critical" severity:high login',
      ),
    ).toEqual({
      value: 'login',
      severity: ['high', 'critical'],
    });
  });
  it('treats the other release prefixes as text shortcuts rather than structured filters', () => {
    expect(
      parseFindingSearch(
        'host:api cve:CVE-2026 tech:nginx port:443 status:open tag:external',
      ),
    ).toEqual({
      value: 'api CVE-2026 nginx 443 open external',
      severity: [],
    });
  });
  it('supports severity-only and blank input', () => {
    expect(parseFindingSearch('severity:info')).toEqual({
      value: '',
      severity: ['info'],
    });
    expect(parseFindingSearch('  ')).toEqual({ value: '', severity: [] });
  });
  it('replaces recognized filters without losing text shortcuts or unknown literal terms', () => {
    expect(
      withFindingSeverity(
        'cve:CVE-2026 severity:high severity:bogus severity:low',
        'critical',
      ),
    ).toBe('cve:CVE-2026 severity:bogus severity:critical');
    expect(withFindingSeverity('login severity:critical', 'all')).toBe('login');
  });
});
