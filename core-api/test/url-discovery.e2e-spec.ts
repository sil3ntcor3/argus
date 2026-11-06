import { DataAdapterService } from '@/modules/data-adapter/data-adapter.service';
import type { DiscoveredUrl } from '@/modules/assets/entities/discovered-url.entity';
import type { Job } from '@/modules/jobs-registry/entities/job.entity';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Host-wide URL discovery (e2e)', () => {
  jest.setTimeout(60_000);
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let assetId: string;
  let runId: string;
  let adapter: DataAdapterService;
  const services = new Map<number, string>();
  const host = 'url-discovery.example.com';
  const insert = async (sql: string, values: unknown[]): Promise<string> => {
    const [row]: { id: string }[] = await app.dataSource.query(
      sql + ' RETURNING id',
      values,
    );
    return row.id;
  };
  const job = (extra: Partial<Job> = {}) =>
    ({
      id: 'synthetic-url-job',
      asset: { id: assetId, value: host },
      jobHistory: { id: runId },
      ...extra,
    }) as Job;
  const ingest = (urls: string[], input = job()) =>
    adapter.urlDiscovery({
      data: urls.map((url) => ({ url }) as DiscoveredUrl),
      job: input,
    });
  const rows = () =>
    app.dataSource.query<{ url: string; assetServiceId: string }[]>(
      'SELECT url, "assetServiceId" FROM discovered_urls WHERE "jobHistoryId"=$1 ORDER BY url',
      [runId],
    );

  beforeAll(async () => {
    app = await createTestApp();
    owner = await createUserWithWorkspace(app.server, 'url-discovery-owner');
    adapter = app.app.get(DataAdapterService);
    const targetId = await insert(
      `INSERT INTO targets (value, "workspaceId", type) VALUES ($1, $2, 'DOMAIN')`,
      [host, owner.workspace.id],
    );
    assetId = await insert(
      'INSERT INTO assets (value, "targetId") VALUES ($1, $2)',
      [host, targetId],
    );
    for (const port of [443, 8443, 8080]) {
      services.set(
        port,
        await insert(
          'INSERT INTO asset_services (value, port, "assetId") VALUES ($1, $2, $3)',
          [`${host}:${port}`, port, assetId],
        ),
      );
    }
  });
  beforeEach(async () => {
    runId = await insert(
      'INSERT INTO job_histories ("jobHistoryName") VALUES ($1)',
      ['Argus URL ownership validation'],
    );
  });
  afterEach(async () => {
    await app.dataSource.query('DELETE FROM job_histories WHERE id=$1', [
      runId,
    ]);
  });
  afterAll(async () => {
    await cleanupE2eData(app.dataSource, {
      workspaceIds: [owner?.workspace.id].filter(Boolean),
      userIds: [owner?.user.userId].filter(Boolean),
    });
    await closeTestApp(app.app);
  });

  it('persists each host-wide URL on its own service and deduplicates retries', async () => {
    const urls = [
      `https://${host}/login`,
      `https://${host}:8443/admin`,
      `http://${host}:8080/api`,
    ];
    await ingest(urls);
    await ingest([...urls, urls[0]]);
    const saved = await rows();
    expect(saved).toHaveLength(3);
    for (const [index, port] of [443, 8443, 8080].entries()) {
      expect(saved).toContainEqual({
        url: urls[index],
        assetServiceId: services.get(port),
      });
    }
  });

  it('retains fallback capture semantics and explicit service ownership', async () => {
    await ingest(['https://cdn.example.net/file']);
    await ingest(
      [`https://${host}:8443/explicit`],
      job({ assetServiceId: services.get(8080) }),
    );
    expect(await rows()).toEqual(
      expect.arrayContaining([
        {
          url: 'https://cdn.example.net/file',
          assetServiceId: services.get(443),
        },
        {
          url: `https://${host}:8443/explicit`,
          assetServiceId: services.get(8080),
        },
      ]),
    );
  });

  it('does not attribute orphaned jobs to services of another asset', async () => {
    await ingest([`https://${host}/orphan`], job({ asset: undefined }));
    expect(await rows()).toEqual([]);
  });
});
