import { randomUUID } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { TargetRunHistoryService } from './target-run-history.service';

describe('TargetRunHistoryService', () => {
  const id = randomUUID();
  const workspaceId = randomUUID();
  const query = jest.fn();
  const service = new TargetRunHistoryService({
    query,
  } as unknown as DataSource);

  beforeEach(() => {
    query.mockReset();
  });

  it.each([
    [0, 10],
    [1, 101],
    [Number.MAX_SAFE_INTEGER, 100],
  ])(
    'rejects unsafe page and limit (%d, %d) before querying',
    async (page, limit) => {
      await expect(
        service.list(id, workspaceId, { page, limit }),
      ).rejects.toThrow(BadRequestException);
      expect(query).not.toHaveBeenCalled();
    },
  );
});
