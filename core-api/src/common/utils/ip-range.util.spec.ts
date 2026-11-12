import { ipType, isIpInRanges, isIpOrCidr, toBlockList } from './ip-range.util';

describe('IP range validation', () => {
  it.each([
    ['203.0.113.7', 'ipv4'],
    ['2001:db8::7', 'ipv6'],
    ['::ffff:203.0.113.7', 'ipv6'],
    ['example.com', null],
    ['203.0.113.7/32', null],
  ] as const)('identifies the family of %s', (ip, family) => {
    expect(ipType(ip)).toBe(family);
  });

  it.each([
    '10.0.0.1',
    '10.0.0.0/8',
    '0.0.0.0/0',
    '203.0.113.7/32',
    '2001:db8::1',
    '2001:db8::/32',
    '::/0',
    '2001:db8::1/128',
    '::ffff:203.0.113.7',
    'fe80::1%en0',
  ])('accepts %s', (entry) => {
    expect(isIpOrCidr(entry)).toBe(true);
  });

  it.each([
    '',
    'example.com',
    '10.0.0.256',
    '010.0.0.1',
    '10.0.0.1:443',
    '[2001:db8::1]',
    ' 10.0.0.1',
    '10.0.0.0/',
    '10.0.0.0/8/1',
    '2001:db8::/32/1',
    '10.0.0.0/33',
    '2001:db8::/129',
    '10.0.0.0/-1',
    '10.0.0.0/+8',
    '10.0.0.0/1.5',
    '10.0.0.0/1e1',
    '10.0.0.0/ 8',
    '10.0.0.0/Infinity',
  ])('rejects %s', (entry) => {
    expect(isIpOrCidr(entry)).toBe(false);
  });
});

describe('IP range matching', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7', true],
    ['203.0.113.8', '203.0.113.7', false],
    ['10.255.255.255', '10.0.0.0/8', true],
    ['11.0.0.0', '10.0.0.0/8', false],
    ['198.51.100.7', '0.0.0.0/0', true],
    ['203.0.113.7', '203.0.113.7/32', true],
    ['203.0.113.8', '203.0.113.7/32', false],
    ['2001:db8::7', '2001:db8::/32', true],
    ['2001:db9::7', '2001:db8::/32', false],
    ['2001:db8::1', '::/0', true],
    ['2001:db8::1', '2001:db8::1/128', true],
    ['2001:db8::2', '2001:db8::1/128', false],
    ['::ffff:203.0.113.7', '203.0.113.7', true],
    ['::ffff:10.1.2.3', '10.0.0.0/8', true],
    ['::ffff:11.1.2.3', '10.0.0.0/8', false],
    ['fe80::1%en0', 'fe80::1%en0', true],
  ] as const)('matches %s against %s as %s', (ip, entry, expected) => {
    expect(isIpInRanges(ip, [entry])).toBe(expected);
  });

  it('does not match a missing, malformed or subnet peer', () => {
    for (const ip of [undefined, '', 'not-an-ip', '10.0.0.0/8']) {
      expect(isIpInRanges(ip, ['0.0.0.0/0', '::/0'])).toBe(false);
    }
  });

  it('skips malformed rules without widening trust or losing valid rules', () => {
    const entries = Object.freeze([
      '10.0.0.0/8/1',
      'not-an-ip',
      '2001:db8::/32',
    ]);
    const list = toBlockList(entries);
    expect(list.check('10.1.2.3')).toBe(false);
    expect(list.check('2001:db8::5', 'ipv6')).toBe(true);
    expect(entries).toEqual(['10.0.0.0/8/1', 'not-an-ip', '2001:db8::/32']);
    expect(isIpInRanges('203.0.113.7', [])).toBe(false);
  });
});
