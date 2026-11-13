export const DETECTION_LABELS: Record<string, string> = {
  new: 'New', active: 'Active', fixed: 'Fixed', resurfaced: 'Resurfaced',
};
export function isOpenFinding(finding: { detectionStatus?: string; isArchived?: boolean; vulnerabilityDismissal?: unknown }) {
  return !finding.isArchived && !finding.vulnerabilityDismissal &&
    ['new', 'active', 'resurfaced'].includes(finding.detectionStatus ?? 'new');
}
