import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ScopePreviewDto } from './project-scope-preview.dto';

const rule = { mode: 'include', type: 'hostname', value: '*.argus.test' };
const errors = (input: object) =>
  validateSync(plainToInstance(ScopePreviewDto, input), { whitelist: true });

describe('ScopePreviewDto', () => {
  it('accepts empty rules and optional project UUIDs', () => {
    expect(errors({ rules: [] })).toEqual([]);
    expect(
      errors({
        rules: [rule],
        projectId: '3f1c2a8e-6c1b-4d5e-9f00-0a1b2c3d4e5f',
      }),
    ).toEqual([]);
  });
  it('accepts exactly 100 nested rules', () => {
    expect(errors({ rules: Array.from({ length: 100 }, () => rule) })).toEqual(
      [],
    );
  });
  it.each([
    {},
    { rules: null },
    { rules: 'invalid' },
    { rules: {} },
    { rules: [null] },
    { rules: ['invalid'] },
    { rules: [{}] },
    { rules: [{ ...rule, mode: 'unknown' }] },
    { rules: [{ ...rule, type: 'unknown' }] },
    { rules: [{ ...rule, value: 123 }] },
    { rules: [{ ...rule, value: null }] },
    { rules: [{ ...rule, value: 'x'.repeat(256) }] },
    { rules: Array.from({ length: 101 }, () => rule) },
    { rules: [], projectId: null },
    { rules: [], projectId: 'invalid' },
  ])('rejects malformed or oversized input %#', (input) => {
    expect(errors(input).length).toBeGreaterThan(0);
  });
});
