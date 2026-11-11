/** The shared staleness criterion for the target list and workspace summary. */
export const staleTargetCondition = (alias: string): string =>
  `(${alias}."lastDiscoveredAt" IS NULL
    OR ${alias}."lastDiscoveredAt" < LOCALTIMESTAMP - INTERVAL '30 days')`;
