export const DETECTION_LABELS: Record<string, string> = {
  new: 'New', active: 'Active', fixed: 'Fixed', resurfaced: 'Resurfaced',
};
export function isOpenFinding(finding: { detectionStatus?: string; isArchived?: boolean; vulnerabilityDismissal?: unknown; reviewStatus?: string }) {
  return (!finding.reviewStatus || finding.reviewStatus==='approved') && !finding.isArchived && !finding.vulnerabilityDismissal &&
    ['new', 'active', 'resurfaced'].includes(finding.detectionStatus ?? 'new');
}
