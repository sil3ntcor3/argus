import { BlockList, isIP } from 'node:net';

/** Identify a literal address; hostnames and CIDR strings are not peers. */
export function ipType(ip: string): 'ipv4' | 'ipv6' | null {
  const family = isIP(ip);
  return family === 4 ? 'ipv4' : family === 6 ? 'ipv6' : null;
}

/** Parse a single address or CIDR, rejecting additional slash segments. */
function parseEntry(
  entry: string,
): { address: string; type: 'ipv4' | 'ipv6'; bits?: number } | null {
  const parts = entry.split('/');
  if (parts.length > 2) return null;
  const [address, prefix] = parts;
  const type = ipType(address);
  if (!type) return null;
  if (prefix === undefined) return { address, type };

  const bits = Number(prefix);
  const maxBits = type === 'ipv4' ? 32 : 128;
  if (!/^\d+$/.test(prefix) || bits > maxBits) return null;
  return { address, type, bits };
}

/** Whether an entry is a literal IP address or a valid CIDR range. */
export function isIpOrCidr(entry: string): boolean {
  return parseEntry(entry) !== null;
}

/** Build native address rules, skipping malformed entries without widening them. */
export function toBlockList(entries: readonly string[]): BlockList {
  const list = new BlockList();
  for (const entry of entries) {
    const parsed = parseEntry(entry);
    if (!parsed) continue;
    if (parsed.bits === undefined) {
      list.addAddress(parsed.address, parsed.type);
    } else {
      list.addSubnet(parsed.address, parsed.bits, parsed.type);
    }
  }
  return list;
}

/** Missing or malformed peers never match; IPv4-mapped IPv6 uses native matching. */
export function isIpInRanges(
  ip: string | undefined,
  entries: readonly string[],
): boolean {
  if (!ip) return false;
  const type = ipType(ip);
  return type !== null && toBlockList(entries).check(ip, type);
}
