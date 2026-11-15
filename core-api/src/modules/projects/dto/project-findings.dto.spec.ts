import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { GetProjectFindingsQueryDto } from './project-findings.dto';

describe('Project finding query', () => {
  const check = async (query: Record<string, unknown>) => {
    const dto = plainToInstance(GetProjectFindingsQueryDto, query);
    return {
      dto,
      errors: await validate(dto, {
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    };
  };

  it('accepts and transforms the released lifecycle/date/tree/sort filters', async () => {
    const filter = {
      logic: 'and',
      items: [{ field: 'name', op: 'contains', value: 'TLS' }],
    };
    const { dto, errors } = await check({
      overdue: 'true',
      discoveredBy: 'ai',
      createdFrom: '2026-01-01',
      createdTo: '2026-01-31',
      filter: JSON.stringify(filter),
      sortBy: 'dueAt',
      sortOrder: 'ASC',
    });
    expect(errors).toEqual([]);
    expect(dto).toMatchObject({
      overdue: true,
      discoveredBy: ['ai'],
      filter,
      sortBy: 'dueAt',
    });
  });

  it.each([
    { overdue: 'yes' },
    { discoveredBy: ['unknown'] },
    { createdFrom: 'yesterday' },
    { createdTo: 'invalid' },
    { createdFrom: '2026-02-30' },
    { createdTo: '2026-02-29' },
    { sortBy: 'name DESC;--' },
    { sortBy: 'createdAt' },
    { sortOrder: 'sideways' },
    { filter: '{invalid' },
    {
      filter: JSON.stringify({
        logic: 'and',
        items: [{ field: 'scanScopeKey', op: 'eq', value: 'secret' }],
      }),
    },
  ])('rejects invalid query %j', async (query) => {
    expect((await check(query)).errors.length).toBeGreaterThan(0);
  });
});
