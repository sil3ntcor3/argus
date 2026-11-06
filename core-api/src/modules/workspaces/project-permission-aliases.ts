const aliases = new Map([
  ['group.read', 'project.read'],
  ['project.read', 'group.read'],
  ['group.write', 'project.write'],
  ['project.write', 'group.write'],
]);

/** Exact action aliases only; delegation still requires the same held action. */
export function withProjectPermissionAliases(keys: Iterable<string>): string[] {
  const resolved = new Set(keys);
  for (const [key, alias] of aliases) {
    if (resolved.has(key)) resolved.add(alias);
  }
  return [...resolved];
}
