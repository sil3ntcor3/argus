export const FINDING_SEARCH_SEVERITIES = [
  'critical',
  'high',
  'medium',
  'low',
  'info',
] as const;
export type FindingSearchSeverity = (typeof FINDING_SEARCH_SEVERITIES)[number];
const prefix = /^(severity|host|port|tech|status|tag|cve):/i;
const tokens = (raw: string) => raw.trim().split(/\s+/).filter(Boolean);
const isSeverity = (value: string): value is FindingSearchSeverity =>
  FINDING_SEARCH_SEVERITIES.some((severity) => severity === value);

/** Only severity is a facet; other release prefixes are ordinary text shortcuts. */
export function parseFindingSearch(raw: string) {
  const severity: FindingSearchSeverity[] = [],
    value: string[] = [];
  for (const token of tokens(raw)) {
    const match = token.match(prefix);
    if (!match) {
      value.push(token);
      continue;
    }
    const fieldValue = token.slice(match[0].length).replace(/^"|"$/g, '');
    if (match[1].toLowerCase() === 'severity') {
      const normalized = fieldValue.toLowerCase();
      if (isSeverity(normalized)) {
        if (!severity.includes(normalized)) severity.push(normalized);
      } else value.push(token);
    } else if (fieldValue) value.push(fieldValue);
  }
  return { value: value.join(' '), severity };
}

/** Replaces only recognized severity tokens, retaining the user's other text. */
export function withFindingSeverity(
  raw: string,
  severity: FindingSearchSeverity | 'all',
) {
  const rest = tokens(raw).filter(
    (token) => parseFindingSearch(token).severity.length === 0,
  );
  if (severity !== 'all') rest.push('severity:' + severity);
  return rest.join(' ');
}
