import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { wsHeaders } from './helpers/auth';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Finding search previews (Docker)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let other: typeof owner;
  let memberHeaders: Record<string, string>;
  let role: string, asset: string, foreignAsset: string;
  const marker = randomUUID();
  const matches: Record<string, string> = {};
  const capIds: string[] = [];
  const basePermissions = ['asset.read', 'target.read'];
  const metadata = (body: Record<string, unknown>) =>
    Object.fromEntries(
      ['total', 'page', 'limit', 'pageCount', 'hasNextPage'].map((key) => [
        key,
        body[key],
      ]),
    );
  async function insert(table: string, values: Record<string, unknown>) {
    const keys = Object.keys(values);
    const [row] = await app.dataSource.query<{ id: string }[]>(
      `INSERT INTO ${table} (${keys.map((k) => '"' + k + '"').join(',')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING id`,
      Object.values(values),
    );
    return row.id;
  }
  const finding = (values: Record<string, unknown>) =>
    insert('vulnerabilities', {
      assetId: asset,
      name: 'Argus ' + marker,
      severity: 'critical',
      description: 'Private scanner proof must not escape the preview',
      ...values,
    });
  const grant = (keys: string[]) =>
    app.dataSource.query(
      'UPDATE workspace_permissions SET permissions=$1 WHERE id=$2',
      [keys, role],
    );
  const search = (query: Record<string, unknown>, headers = owner.headers) =>
    request(app.server).get('/api/search').set(headers).query(query);

  beforeAll(async () => {
    app = await createTestApp();
    owner = await createUserWithWorkspace(app.server, 'finding-search-owner');
    other = await createUserWithWorkspace(app.server, 'finding-search-other');
    for (const person of [owner, other]) {
      const target = await insert('targets', {
        workspaceId: person.workspace.id,
        type: 'DOMAIN',
        value: marker + '.example.test',
      });
      const id = await insert('assets', {
        targetId: target,
        isPrimary: true,
        value: marker + '.example.test',
      });
      await insert('asset_services', {
        assetId: id,
        port: 443,
        value: 'https://' + marker + '.example.test',
      });
      if (person === owner) asset = id;
      else foreignAsset = id;
    }
    const member = await insert('workspace_members', {
      workspaceId: owner.workspace.id,
      userId: other.user.userId,
    });
    role = await insert('workspace_permissions', {
      workspaceId: owner.workspace.id,
      name: 'Search reader',
      permissions: basePermissions,
    });
    await insert('workspace_member_permissions', {
      memberId: member,
      permissionId: role,
    });
    memberHeaders = wsHeaders(other.user.cookie, owner.workspace.id);
    matches.name = await finding({ name: 'ArGuS LoGiN-' + marker });
    matches.cve = await finding({
      name: 'CVE result',
      cveId: ['CVE-2026-' + marker],
    });
    matches.url = await finding({
      name: 'URL result',
      affectedUrl: 'https://portal.example.test/path-' + marker,
    });
    const sameTime = new Date(Date.now() - 60000);
    for (let i = 0; i < 7; i++) {
      const id = await finding({
        name: 'cap-' + marker,
        severity: 'low',
        createdAt: sameTime,
        ...(i === 0 ? { detectionStatus: 'fixed', fixedAt: new Date() } : {}),
        ...(i === 1 ? { isArchived: true } : {}),
      });
      capIds.push(id);
      if (i === 2)
        await insert('vulnerability_dismissals', {
          vulnerabilityId: id,
          userId: owner.user.userId,
          reason: 'wont_fix',
        });
    }
    capIds.sort((a, b) => b.localeCompare(a));
    for (const values of [
      { reviewStatus: 'pending_review' },
      { reviewStatus: 'rejected' },
      { assetId: foreignAsset },
      { severity: 'unknown' },
    ])
      await finding({ name: 'cap-' + marker, severity: 'low', ...values });
    matches.literal = await finding({ name: 'literal %_\\ token-' + marker });
    matches.quote = await finding({
      name: "quote ' OR 1=1 -- " + marker,
      severity: 'info',
    });
  });
  afterAll(async () => {
    if (!app) return;
    try {
      await cleanupE2eData(app.dataSource, {
        workspaceIds: [owner?.workspace.id, other?.workspace.id].filter(
          Boolean,
        ),
        userIds: [owner?.user.userId, other?.user.userId].filter(Boolean),
      });
    } finally {
      await closeTestApp(app.app);
    }
  });

  it.each([
    ['name', 'login-'],
    ['cve', 'cve-2026-'],
    ['url', 'path-'],
  ])(
    'matches %s case-insensitively and returns only safe preview fields',
    async (kind, prefix) => {
      const response = await search({ value: prefix + marker })
        .expect(200)
        .expect('Cache-Control', 'private, no-store');
      expect(response.body.data.vulnerabilities).toEqual([
        {
          id: matches[kind],
          name: expect.any(String),
          severity: 'critical',
          affectedUrl:
            kind === 'url'
              ? 'https://portal.example.test/path-' + marker
              : null,
          asset: { id: asset, value: marker + '.example.test' },
        },
      ]);
      expect(response.body.total).toBe(0);
      expect(JSON.stringify(response.body.data.vulnerabilities)).not.toMatch(
        /description|reviewStatus|proof|scanScopeKey/,
      );
    },
  );

  it('caps approved previews at five with stable ties and includes closed findings', async () => {
    const response = await search({ value: 'cap-' + marker }).expect(200);
    expect(
      response.body.data.vulnerabilities.map((row: { id: string }) => row.id),
    ).toEqual(capIds.slice(0, 5));
    const closedIds = await app.dataSource.query<{ id: string }[]>(
      'SELECT id FROM vulnerabilities WHERE "assetId"=$1 AND ("isArchived" OR "detectionStatus"=\'fixed\' OR id IN (SELECT "vulnerabilityId" FROM vulnerability_dismissals))',
      [asset],
    );
    for (const row of closedIds) {
      const name = 'closed-' + row.id;
      await app.dataSource.query(
        'UPDATE vulnerabilities SET name=$1 WHERE id=$2',
        [name, row.id],
      );
      expect(
        (await search({ value: name }).expect(200)).body.data.vulnerabilities[0]
          .id,
      ).toBe(row.id);
      await app.dataSource.query(
        'UPDATE vulnerabilities SET name=$1 WHERE id=$2',
        ['cap-' + marker, row.id],
      );
    }
    const foreign = await search(
      { value: 'cap-' + marker },
      other.headers,
    ).expect(200);
    expect(foreign.body.data.vulnerabilities).toHaveLength(1);
    expect(foreign.body.data.vulnerabilities[0].asset.id).toBe(foreignAsset);
  });

  it('supports severity-only and combined repeated severity filters without changing base pagination', async () => {
    await grant(basePermissions);
    for (const page of [1, 2]) {
      const base = await search(
        { value: '', page, limit: 1 },
        memberHeaders,
      ).expect(200);
      const response = await search({
        value: '',
        severity: ['low', 'low'],
        page,
        limit: 1,
      }).expect(200);
      expect(metadata(response.body)).toEqual(metadata(base.body));
      expect(response.body.data.targets).toEqual(base.body.data.targets);
      expect(response.body.data.assets).toEqual(base.body.data.assets);
      expect(
        response.body.data.vulnerabilities.map((row: { id: string }) => row.id),
      ).toEqual(capIds.slice(0, 5));
      expect(base.body.data.vulnerabilities).toEqual([]);
    }
    const empty = await search({
      value: 'cap-' + marker,
      severity: ['critical', 'high'],
    }).expect(200);
    expect(empty.body.data.vulnerabilities).toEqual([]);
    expect(
      (await search({ value: '' }).expect(200)).body.data.vulnerabilities,
    ).toEqual([]);
  });

  it.each(['read', 'write'])(
    'honors effective finding %s and independently redacts readers without it',
    async (mode) => {
      await grant(basePermissions);
      const base = await search(
        { value: 'login-' + marker },
        memberHeaders,
      ).expect(200);
      expect(base.body.data.vulnerabilities).toEqual([]);
      await search(
        { value: 'login-' + marker, severity: 'critical' },
        memberHeaders,
      ).expect(403);
      await grant([...basePermissions, 'vulnerability.' + mode]);
      const allowed = await search(
        { value: 'login-' + marker, severity: 'critical' },
        memberHeaders,
      ).expect(200);
      expect(allowed.body.data.vulnerabilities[0].id).toBe(matches.name);
    },
  );

  it('requires authentication and both existing search permissions', async () => {
    await request(app.server)
      .get('/api/search')
      .query({ value: marker })
      .expect(401);
    for (const missing of basePermissions) {
      await grant([
        ...basePermissions.filter((p) => p !== missing),
        'vulnerability.read',
      ]);
      await search({ value: marker }, memberHeaders).expect(403);
    }
  });

  it.each([
    'bogus',
    '',
    ['critical', 'high', 'medium', 'low', 'info', 'critical'],
    { nested: 'critical' },
  ])('rejects an invalid severity filter %j', async (severity) => {
    await search({ value: marker, severity }).expect(400);
  });

  it('treats wildcard and quote characters as literal finding search text', async () => {
    for (const [value, id] of [
      ['%_\\', matches.literal],
      ["' OR 1=1 --", matches.quote],
    ]) {
      const response = await search({ value }).expect(200);
      expect(
        response.body.data.vulnerabilities.map((row: { id: string }) => row.id),
      ).toEqual([id]);
    }
  });

  it('keeps nonblank history user-owned and avoids empty severity-only history', async () => {
    await grant([...basePermissions, 'vulnerability.read']);
    const term = 'history-' + marker;
    for (const headers of [owner.headers, memberHeaders])
      await search({ value: term, isSaveHistory: true }, headers).expect(200);
    const histories = await app.dataSource.query<
      { id: string; userId: string }[]
    >('SELECT id,"userId" FROM search_histories WHERE query=$1', [term]);
    expect(histories).toHaveLength(2);
    await search({
      value: '',
      severity: 'critical',
      isSaveHistory: true,
    }).expect(200);
    const [empty] = await app.dataSource.query<{ count: number }[]>(
      'SELECT COUNT(*)::int AS count FROM search_histories WHERE "userId"=$1 AND btrim(query)=\'\'',
      [owner.user.userId],
    );
    expect(empty.count).toBe(0);
    const mine = histories.find((row) => row.userId === owner.user.userId)!;
    await request(app.server)
      .delete('/api/search/histories/' + mine.id)
      .set(memberHeaders)
      .expect(404);
    const history = await request(app.server)
      .get('/api/search/histories')
      .set(owner.headers)
      .expect(200);
    expect(
      history.body.data.some((row: { id: string }) => row.id === mine.id),
    ).toBe(true);
  });
});
