import { ProjectScopeRuleType } from '@/common/enums/enum';
import { hostnamePatternToLike, normalizeScopeRuleValue } from './scope-rules';
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
