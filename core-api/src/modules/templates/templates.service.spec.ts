import { BadRequestException } from '@nestjs/common';
import { TemplatesService } from './templates.service';

describe('TemplatesService run boundaries', () => {
  const service = new TemplatesService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  it.each([
    {}, { targetIds: [], assetIds: [] },
    { targetIds: ['target'], assetIds: ['asset'] },
    { targetIds: ['target'], projectIds: ['project'] },
  ])('rejects empty or ambiguous scan scopes before querying (case %#)', async scope => {
    await expect(service.run('workspace', 'user', { templateIds: ['template'], ...scope })).rejects.toBeInstanceOf(BadRequestException);
  });
});
