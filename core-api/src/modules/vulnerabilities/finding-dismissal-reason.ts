import { DismissReason } from '@/common/enums/enum';
export const RISK_ACCEPTED = 'risk_accepted' as const;
export const FINDING_DISMISS_REASONS = [
  ...Object.values(DismissReason),
  RISK_ACCEPTED,
];
export type FindingDismissalReason = (typeof FINDING_DISMISS_REASONS)[number];
