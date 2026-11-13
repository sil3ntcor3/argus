import { IssueLinkResourceType as Kind } from '@/common/enums/enum';
import { IssueLinksService } from './issue-links.service';

describe('Workspace issue resource links', () => {
  it.each(Object.values(Kind))('uses scoped, deduplicated lookups for %s', async kind => {
    const reader = { query: jest.fn().mockResolvedValue([{ id: 'owned', name: 'Name', value: 'Host', status: 'completed', severity: 'high', dismissed: false }]) };
    const service=new IssueLinksService(reader as never);
    const result=await service.findInWorkspace(kind,['owned','owned'],'workspace');
    expect(reader.query).toHaveBeenCalledWith(expect.any(String),[['owned'],'workspace']);
    expect(result.has('owned')).toBe(true);
    expect(JSON.stringify([...result.values()])).not.toContain('workspaceId');
  });
  it('refuses missing resources and projects missing summaries without crossing scope',async()=>{
    const reader={ query:jest.fn().mockResolvedValue([]) };const service=new IssueLinksService(reader as never);
    await expect(service.assertInWorkspace([{ resourceType:Kind.ASSET,resourceId:'foreign' }],'workspace')).rejects.toMatchObject({ status:404 });
    expect(await service.summarize([{ resourceType:Kind.ASSET,resourceId:'deleted' }],'workspace')).toEqual([{ missing:true }]);
    reader.query.mockClear();expect(await service.findInWorkspace(Kind.ASSET,[],'workspace')).toEqual(new Map());expect(reader.query).not.toHaveBeenCalled();
  });
  it('keeps a supplied transaction reader rather than opening another connection',async()=>{
    const outside={ query:jest.fn() },inside={ query:jest.fn().mockResolvedValue([{ id:'owned' }]) };
    await new IssueLinksService(outside as never).assertInWorkspace([{ resourceType:Kind.TARGET,resourceId:'owned' }],'workspace',inside);
    expect(outside.query).not.toHaveBeenCalled();expect(inside.query).toHaveBeenCalledTimes(1);
  });
});
