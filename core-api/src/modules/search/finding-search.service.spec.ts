import { randomUUID } from 'node:crypto';
import { Severity } from '@/common/enums/enum';
import type { DataSource } from 'typeorm';
import type { SearchAssetsTargetsDto } from './dto/search.dto';
import { FindingSearchService } from './finding-search.service';

describe('FindingSearchService', () => {
  const query = jest.fn();
  const db = { query } as unknown as DataSource;
  const service = new FindingSearchService(db);
  const workspace = randomUUID();
  const input = (value: string, severity?: Severity[]) =>
    ({ value, severity }) as SearchAssetsTargetsDto;
  beforeEach(() => query.mockReset().mockResolvedValue([]));

  it('skips storage when neither finding text nor a severity is supplied', async () => {
    await expect(service.search(input('  '), workspace)).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
  it('binds a literal escaped query, workspace and recognized severities in one bounded read', async () => {
    await service.search(input('  %_\\  '), workspace);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('LIMIT 5'), [
      workspace,
      Object.values(Severity),
      '%\\%\\_\\\\%',
    ]);
    expect(query.mock.calls[0][0]).toContain('v."reviewStatus" = \'approved\'');
    expect(query.mock.calls[0][0]).toContain(
      'ORDER BY v."createdAt" DESC, v.id DESC',
    );
  });
  it('supports severity-only reads and deduplicates the supplied filters', async () => {
    await service.search(input('', [Severity.HIGH, Severity.HIGH]), workspace);
    expect(query.mock.calls[0][1]).toEqual([workspace, [Severity.HIGH], null]);
  });
  it('projects only safe finding and asset fields even if an internal row contains extras', async () => {
    const record = {
      id: randomUUID(),
      name: 'Argus finding',
      severity: Severity.HIGH,
      affectedUrl: null,
      asset: { id: randomUUID(), value: 'api.example.test', private: 'hidden' },
      description: 'private proof',
      scanScopeKey: 'private',
    };
    query.mockResolvedValue([record]);
    await expect(service.search(input('Argus'), workspace)).resolves.toEqual([
      {
        id: record.id,
        name: record.name,
        severity: record.severity,
        affectedUrl: null,
        asset: { id: record.asset.id, value: record.asset.value },
      },
    ]);
  });
  it('propagates database failures instead of returning an authorized empty result', async () => {
    query.mockRejectedValue(new Error('database unavailable'));
    await expect(service.search(input('Argus'), workspace)).rejects.toThrow(
      'database unavailable',
    );
  });
});
