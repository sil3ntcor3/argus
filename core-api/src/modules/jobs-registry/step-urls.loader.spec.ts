import { DataKind, TargetType } from '@/common/enums/enum';
import type { DataSource } from 'typeorm';
import { planStepInputs } from './step-inputs';
import {
  loadScopedUrls,
  URL_INPUT_PAGE_SIZE,
  URL_INPUTS_PER_HOST,
} from './step-urls.loader';

describe('loadScopedUrls', () => {
  const asset = {
    id: 'asset',
    value: 'app.example.com',
    isPrimary: false,
    targetType: TargetType.DOMAIN,
  };
  const row = (url: string, index = 0) => ({
    url,
    assetId: asset.id,
    serviceId: 'service',
    cursorId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    cursorCreatedAt: '2026-11-06 00:00:00.123456',
  });
  let query: jest.Mock;
  let source: DataSource;
  beforeEach(() => {
    query = jest.fn().mockResolvedValue([]);
    source = { query } as unknown as DataSource;
  });

  it('backfills past external/invalid candidates before planning a URL input', async () => {
    const excluded = Array.from({ length: URL_INPUT_PAGE_SIZE }, (_, i) =>
      row(
        [
          'https://external.example.net/a',
          'invalid',
          'ftp://app.example.com/a',
        ][i % 3],
        i,
      ),
    );
    const url = 'https://app.example.com:8443/login';
    query.mockResolvedValueOnce(excluded).mockResolvedValueOnce([row(url)]);
    const urls = await loadScopedUrls(source, [asset], ['service']);
    expect(
      planStepInputs([DataKind.URL, DataKind.HOST], {
        assets: [asset],
        urls: new Map([[asset.id, urls]]),
      })[0].connectorInputs,
    ).toEqual({ target: url });
    expect(query.mock.calls[1][1]).toEqual([
      asset.id,
      ['service'],
      URL_INPUT_PAGE_SIZE,
      excluded.at(-1)!.cursorCreatedAt,
      excluded.at(-1)!.cursorId,
    ]);
    expect(query.mock.calls[1][0]).toContain(
      '(du."createdAt", du.id) < ($4::timestamp, $5::uuid)',
    );
    expect(query.mock.calls[0][0]).toContain('du."createdAt"::text');
    expect(query.mock.calls[0][0]).toContain(
      'ORDER BY du."createdAt" DESC, du.id DESC',
    );
  });

  it('caps eligible rows independently per asset and hides cursor fields', async () => {
    const other = { ...asset, id: 'other', value: 'other.example.com' };
    query
      .mockResolvedValueOnce(
        Array.from({ length: 60 }, (_, i) =>
          row(`https://app.example.com/${i}`, i),
        ),
      )
      .mockResolvedValueOnce([
        { ...row('https://other.example.com/a'), assetId: other.id },
      ]);
    const urls = await loadScopedUrls(source, [asset, other]);
    expect(urls.filter((u) => u.assetId === asset.id)).toHaveLength(
      URL_INPUTS_PER_HOST,
    );
    expect(urls.filter((u) => u.assetId === other.id)).toHaveLength(1);
    expect(urls[0]).toEqual({
      url: 'https://app.example.com/0',
      assetId: asset.id,
      serviceId: 'service',
    });
    expect(query).toHaveBeenCalledTimes(2);
    const calls = query.mock.calls as [string, unknown[]][];
    expect(calls.map(([, params]) => params[0])).toEqual([asset.id, other.id]);
  });

  it('uses canonical IPv6 host matching', async () => {
    const ipv6 = { ...asset, value: '2001:DB8::1' };
    query.mockResolvedValueOnce([
      row('https://[2001:db8::1]:8443/a'),
      row('https://[2001:db8::2]/a'),
    ]);
    expect(await loadScopedUrls(source, [ipv6])).toHaveLength(1);
  });

  it('keeps service filtering parameterized and reads nothing for an empty scope', async () => {
    expect(await loadScopedUrls(source, [])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
    await loadScopedUrls(source, [asset], ['selected']);
    expect(query.mock.calls[0][1]).toEqual([
      asset.id,
      ['selected'],
      URL_INPUT_PAGE_SIZE,
    ]);
    expect(query.mock.calls[0][0]).toContain('s.id::text = ANY($2::text[])');
  });

  it('propagates query failures', async () => {
    query.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(loadScopedUrls(source, [asset])).rejects.toThrow(
      'database unavailable',
    );
  });
});
