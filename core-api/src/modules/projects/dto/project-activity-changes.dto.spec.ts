import { projectActivityChanges } from './project-activity-changes.dto';

describe('projectActivityChanges', () => {
  it('retains only typed public before/after values and preserves explicit false/null', () => {
    expect(projectActivityChanges({ name: { after: 'Argus', private: 'secret' }, description: { before: null, after: '' },
      hexColor: { after: '#Ab1234' }, autoAddAssets: { before: true, after: false }, instruction: { after: 'secret' } }))
      .toEqual({ name: { after: 'Argus' }, description: { before: null, after: '' }, hexColor: { after: '#Ab1234' }, autoAddAssets: { before: true, after: false } });
  });
  it.each([null, undefined, [], 'text', { name: [] }, { name: { after: 'x'.repeat(121) } },
    { description: { after: 'x'.repeat(2001) } }, { hexColor: { after: 'red' } }, { autoAddAssets: { after: 'true' } },
    { password: { after: 'secret' } }])('omits malformed, oversized and unknown data', value => {
    expect(projectActivityChanges(value)).toBeUndefined();
  });
});
