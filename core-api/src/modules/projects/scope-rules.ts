import { ProjectScopeRuleType } from '@/common/enums/enum';
import { isUUID } from 'class-validator';
import { isIP } from 'node:net';

const HOSTNAME_RE = /^[a-z0-9*_.-]+$/;

/**
 * Validates a rule value for its type and returns the stored form, or throws
 * an Error whose message is safe to show (the service turns it into a 400).
 *
 * - target, asset: a UUID.
 * - hostname: letters, digits, `-`, `_`, `.` and `*` wildcards; lowercased.
 *   A bare `*` would match every hostname in the workspace and is refused.
 * - cidr: an IPv4/IPv6 network; a single address becomes /32 or /128.
 */
export function normalizeScopeRuleValue(
  type: ProjectScopeRuleType,
  value: string,
): string {
  const raw = (value ?? '').trim();
  switch (type) {
    case ProjectScopeRuleType.TARGET:
    case ProjectScopeRuleType.ASSET:
      if (!isUUID(raw)) throw new Error(`"${raw}" is not a valid ${type} id`);
      return raw.toLowerCase();
    case ProjectScopeRuleType.HOSTNAME: {
      const host = raw.toLowerCase();
      if (!host || !HOSTNAME_RE.test(host) || /^[*.]+$/.test(host)) {
        throw new Error(`"${raw}" is not a valid hostname pattern`);
      }
      return host;
    }
    case ProjectScopeRuleType.CIDR: {
      const [addr, prefix, extra] = raw.split('/');
      const version = isIP(addr);
      const max = version === 4 ? 32 : version === 6 ? 128 : 0;
      if (!max || extra !== undefined || addr.includes('%')) {
        throw new Error(`"${raw}" is not a valid CIDR`);
      }
      if (prefix === undefined) return `${addr}/${max}`;
      if (!/^\d{1,3}$/.test(prefix) || Number(prefix) > max) {
        throw new Error(`"${raw}" is not a valid CIDR`);
      }
      return `${addr}/${Number(prefix)}`;
    }
    default:
      throw new Error(`Unknown scope rule type "${String(type)}"`);
  }
}

/** `*.acme.io` → `%.acme.io` for ILIKE, with `%`, `_` and `\` escaped. */
export function hostnamePatternToLike(pattern: string): string {
  return pattern.replace(/[\\%_]/g, (c) => `\\${c}`).replace(/\*/g, '%');
}
