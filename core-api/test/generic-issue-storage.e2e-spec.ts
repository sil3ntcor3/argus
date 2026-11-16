import { closeTestApp, createTestApp, type TestApp } from './helpers/app';

describe('Generic issue storage (Docker)', () => {
  let app: TestApp;
  beforeAll(async () => { app = await createTestApp(); });
  afterAll(async () => { await closeTestApp(app?.app); });

  it('stores generic issue fields without removing legacy source and comment data', async () => {
    const rows: { column_name: string }[] = await app.dataSource.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='issues'`,
    );
    expect(rows.map(row => row.column_name)).toEqual(expect.arrayContaining([
      'sourceType', 'sourceId', 'type', 'priority', 'resolution', 'resolvedAt',
      'dueAt', 'assigneeId', 'ruleId', 'groupKey', 'externalRef',
    ]));
  });

  it('provides persistent workspace numbering, unique resource links and rule storage', async () => {
    const rows: { table_name: string }[] = await app.dataSource.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public'`,
    );
    expect(rows.map(row => row.table_name)).toEqual(expect.arrayContaining([
      'issue_counters', 'issue_links', 'issue_rules', 'comments',
    ]));
  });
});
