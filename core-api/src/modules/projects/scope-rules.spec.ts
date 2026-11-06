import {
  ProjectScopeRuleMode,
  ProjectScopeRuleType,
} from '@/common/enums/enum';
import {
  hostnamePatternToLike,
  normalizeScopeRuleValue,
  scopeRuleMatchSql,
  scopeRulesSql,
  SqlParams,
} from './scope-rules';
const { INCLUDE, EXCLUDE } = ProjectScopeRuleMode;
const ID = '3F1C2A8E-6C1B-4D5E-9F00-0A1B2C3D4E5F';
const { TARGET, HOSTNAME, CIDR, ASSET } = ProjectScopeRuleType;

describe('normalizeScopeRuleValue', () => {
  it.each([
    [TARGET, ID, ID.toLowerCase()],
    [ASSET, ` ${ID} `, ID.toLowerCase()],
    [HOSTNAME, '*.Example.COM', '*.example.com'],
    [HOSTNAME, 'api-1.example.com', 'api-1.example.com'],
    [CIDR, '10.0.0.0/8', '10.0.0.0/8'],
    [CIDR, '203.0.113.7', '203.0.113.7/32'],
    [CIDR, '2001:db8::/32', '2001:db8::/32'],
    [CIDR, '2001:db8::1', '2001:db8::1/128'],
  ])('%s %j → %j', (type, value, expected) => {
    expect(normalizeScopeRuleValue(type, value)).toBe(expected);
  });

  it.each([
    [TARGET, 'acme.io'],
    [HOSTNAME, '*'],
    [HOSTNAME, '*.*'],
    [HOSTNAME, 'acme io'],
    [HOSTNAME, "acme.io'; drop table"],
    [CIDR, '10.0.0.0/33'],
    [CIDR, '10.0.0.0/8/1'],
    [CIDR, 'fe80::1%eth0'],
    [CIDR, 'example.com'],
    [CIDR, '010.0.0.1'],
    [CIDR, '10.0.0.0/-1'],
    [CIDR, '10.0.0.0/x'],
    [CIDR, '2001:db8::/129'],
    [CIDR, '2001:db8::/32/1'],
    [HOSTNAME, 'argus%example.test'],
    [HOSTNAME, ''],
  ])('rejects %s %j', (type, value) => {
    expect(() => normalizeScopeRuleValue(type, value)).toThrow();
  });
});

describe('hostnamePatternToLike', () => {
  it('turns * into % and escapes LIKE metacharacters', () => {
    expect(hostnamePatternToLike('*.acme_1.io')).toBe('%.acme\\_1.io');
    expect(hostnamePatternToLike('a%b')).toBe('a\\%b');
    expect(hostnamePatternToLike('a\\b.argus.test')).toBe('a\\\\b.argus.test');
  });
});

describe('scopeRuleMatchSql', () => {
  it('binds every value as a parameter', () => {
    const params = new SqlParams(['project', 'workspace']);
    const sql = scopeRuleMatchSql(
      { mode: INCLUDE, type: HOSTNAME, value: '*.acme.io' },
      params,
    );
    expect(sql).toBe(`a.value ILIKE $3 ESCAPE '\\'`);
    expect(params.values).toEqual(['project', 'workspace', '%.acme.io']);
  });

  it('matches a CIDR on the asset value and its observed addresses', () => {
    const params = new SqlParams();
    const sql = scopeRuleMatchSql(
      { mode: INCLUDE, type: CIDR, value: '10.0.0.0/8' },
      params,
    );
    // The inet cast is guarded: a hostname value must not raise.
    expect(sql).toContain(`CASE WHEN pg_input_is_valid(a.value, 'inet')`);
    expect(sql).toContain('FROM ip_observations io');
    expect(params.values).toEqual(['10.0.0.0/8']);
  });
});

describe('scopeRulesSql', () => {
  it('binds lazy rule ids only once when the projection is reused', () => {
    const params = new SqlParams();
    const built = scopeRulesSql(
      [{ id: ID, mode: INCLUDE, type: ASSET, value: ID }],
      params,
    )!;
    const first = built.ruleIdSql();
    expect(built.ruleIdSql()).toBe(first);
    expect(params.values).toEqual([ID, ID]);
  });

  it('selects nothing without an include rule', () => {
    expect(
      scopeRulesSql(
        [{ mode: EXCLUDE, type: HOSTNAME, value: 'dev.acme.io' }],
        new SqlParams(),
      ),
    ).toBeNull();
  });

  it('ORs the includes, subtracts the excludes, and records the first include that matched', () => {
    const params = new SqlParams();
    const built = scopeRulesSql(
      [
        { id: 'r1', mode: INCLUDE, type: TARGET, value: 't-1' },
        { id: 'r2', mode: INCLUDE, type: HOSTNAME, value: '*.acme.io' },
        { id: 'r3', mode: EXCLUDE, type: ASSET, value: 'a-9' },
      ],
      params,
    )!;
    expect(built.where).toBe(
      `(a."targetId" = $1 OR a.value ILIKE $2 ESCAPE '\\') AND NOT (a.id = CAST($3 AS uuid))`,
    );
    // A filter-only query must not bind the rule ids: Postgres refuses a
    // parameter the statement never uses.
    expect(params.values).toEqual(['t-1', '%.acme.io', 'a-9']);
    expect(built.ruleIdSql()).toBe(
      `CASE WHEN a."targetId" = $1 THEN CAST($4 AS uuid) WHEN a.value ILIKE $2 ESCAPE '\\' THEN CAST($5 AS uuid) END`,
    );
    expect(params.values).toEqual(['t-1', '%.acme.io', 'a-9', 'r1', 'r2']);
  });
});

it('keeps prefix bindings independent and never interpolates untrusted patterns', () => {
  const prefix = ['workspace'],
    params = new SqlParams(prefix);
  const value = "x%' OR true --";
  const sql = scopeRuleMatchSql(
    { mode: INCLUDE, type: HOSTNAME, value },
    params,
  );
  expect(prefix).toEqual(['workspace']);
  expect(sql).not.toContain(value);
  expect(params.values).toEqual(['workspace', "x\\%' OR true --"]);
});

it('bounds bindings and SQL size for large asset exclusions alongside other rule kinds', () => {
  const excluded = Array.from({ length: 65_536 }, (_, i) => ({
    mode: EXCLUDE,
    type: ASSET,
    value: '00000000-0000-4000-8000-' + i.toString(16).padStart(12, '0'),
  }));
  const params = new SqlParams(['workspace']);
  const built = scopeRulesSql(
    [
      { id: ID, mode: INCLUDE, type: HOSTNAME, value: '*.argus.test' },
      { mode: EXCLUDE, type: HOSTNAME, value: 'manual.argus.test' },
      ...excluded,
    ],
    params,
  )!;
  expect(params.values.length).toBe(4);
  expect((params.values[3] as string[]).length).toBe(65_536);
  expect(built.where.includes('a.value ILIKE $3')).toBe(true);
  expect(built.where.includes('a.id = ANY($4::uuid[])')).toBe(true);
  expect(built.where.length).toBeLessThan(200);
  const projection = built.ruleIdSql();
  expect(params.values.length).toBe(5);
  expect(params.values[4]).toBe(ID);
  expect(built.ruleIdSql()).toBe(projection);
  expect(params.values.length).toBe(5);
});
