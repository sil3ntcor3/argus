import type { DataSource } from 'typeorm';
import { GetProjectsQueryDto } from './dto/project-list.dto';
import { ProjectListReadService } from './project-list-read.service';

describe('ProjectListReadService', () => {
  const db = { query: jest.fn() };
  const service = new ProjectListReadService(db as unknown as DataSource);
  beforeEach(() => jest.resetAllMocks());

  it.each([{ page: 0 }, { page: 1.5 }, { page: Number.MAX_SAFE_INTEGER, limit: 100 }, { limit: 101 }, { sortBy: 'missing' }])(
    'rejects unsupported pagination/sorts before touching persistence: %j', async patch => {
      await expect(service.list(Object.assign(new GetProjectsQueryDto(), patch), 'workspace', true)).rejects.toThrow();
      expect(db.query).not.toHaveBeenCalled();
    },
  );
  it('cannot sort by confidential finding counts without effective access', async () => {
    await expect(service.list(Object.assign(new GetProjectsQueryDto(), { sortBy: 'risk' }), 'workspace', false)).rejects.toThrow('Vulnerability read');
    expect(db.query).not.toHaveBeenCalled();
  });
  it('retains total/page metadata for a page beyond the end without returning its sentinel', async () => {
    db.query.mockResolvedValue([{ id: null, total: 12 }]);
    expect(await service.list(Object.assign(new GetProjectsQueryDto(), { page: 3 }), 'workspace', false))
      .toMatchObject({ data: [], total: 12, page: 3, pageCount: 2, hasNextPage: false });
  });
});
