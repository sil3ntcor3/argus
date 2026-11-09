import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { TargetChangeKind } from './dto/target-changes.dto';
import { TargetChangesService } from './target-changes.service';

describe('TargetChangesService', () => {
  const id = randomUUID();
  const workspaceId = randomUUID();
  const query = jest.fn();
  const service = new TargetChangesService({ query } as unknown as DataSource);

  beforeEach(() => query.mockReset());

  it.each([
    [0, 10],
    [1, 101],
    [Number.MAX_SAFE_INTEGER, 100],
  ])(
    'rejects unsafe pagination (%d, %d) before querying',
    async (page, limit) => {
      await expect(
        service.list(id, workspaceId, { page, limit }, false),
      ).rejects.toThrow(BadRequestException);
      expect(query).not.toHaveBeenCalled();
    },
  );

  it('returns a not-found error when the target is outside the workspace', async () => {
    query.mockResolvedValue([]);
    await expect(
      service.list(id, workspaceId, { page: 1, limit: 10 }, false),
    ).rejects.toThrow(NotFoundException);
  });

  it('rejects an explicit findings filter before querying without access', async () => {
    await expect(
      service.list(
        id,
        workspaceId,
        { page: 1, limit: 10, kind: TargetChangeKind.VULNERABILITY },
        false,
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(query).not.toHaveBeenCalled();
  });
});
