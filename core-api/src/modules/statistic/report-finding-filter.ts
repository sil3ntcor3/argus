import { findingDetectedAt } from '@/modules/vulnerabilities/open-vulnerability';
import { Severity } from '@/common/enums/enum';
import type { ObjectLiteral, SelectQueryBuilder } from 'typeorm';

export interface ReportFindingFilter {
  startDate?: Date;
  endDate?: Date;
  targetIds?: string[];
  vulnIds?: string[];
  minSeverity?: Uppercase<Severity>;
}

const severityOrder = [
  Severity.INFO, Severity.LOW, Severity.MEDIUM, Severity.HIGH, Severity.CRITICAL,
];

/** Keep all report sections inside the same explicit selection. */
export function applyReportFindingFilter<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  options?: ReportFindingFilter,
  targetAlias: 'target' | 't' = 'target',
): void {
  if (options?.startDate) {
    qb.andWhere(`${findingDetectedAt('v')} >= :reportStartDate`, { reportStartDate: options.startDate });
  }
  if (options?.endDate) {
    qb.andWhere(`${findingDetectedAt('v')} <= :reportEndDate`, { reportEndDate: options.endDate });
  }
  if (options?.targetIds?.length) {
    qb.andWhere(`${targetAlias}.id IN (:...targetIds)`, { targetIds: options.targetIds });
  }
  if (options?.vulnIds?.length) {
    qb.andWhere('v.id IN (:...vulnIds)', { vulnIds: options.vulnIds });
  }
  if (options?.minSeverity) {
    const min = severityOrder.findIndex((severity) => severity.toUpperCase() === options.minSeverity);
    if (min >= 0) {
      qb.andWhere('v.severity IN (:...allowedSeverities)', {
        allowedSeverities: severityOrder.slice(min),
      });
    }
  }
}
