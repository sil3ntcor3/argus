import { isGroupOwnedWorkflow } from './workflow-ownership';

describe('group workflow ownership', () => {
  it.each([
    ['group-p1.yaml', true],
    ['group-workflow---p1.yaml', true],
    ['project-p1-abc.yaml', true],
    ['group-p10.yaml', false],
    ['group-workflow---p10.yaml', false],
    ['project-p10-abc.yaml', false],
    ['domain_discovery.yaml', false],
    ['shared.yaml', false],
    ['', false],
    [undefined, false],
    [null, false],
  ])('classifies %s conservatively', (filePath, owned) => {
    expect(isGroupOwnedWorkflow({ filePath }, 'p1')).toBe(owned);
  });

  it('preserves protected generated workflows and missing relations', () => {
    expect(isGroupOwnedWorkflow({ filePath: 'group-p1.yaml', isCanDelete: false }, 'p1')).toBe(false);
    expect(isGroupOwnedWorkflow(undefined, 'p1')).toBe(false);
  });
});
