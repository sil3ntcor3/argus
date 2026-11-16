import type { VulnerabilitySettingsDto, UpdateVulnerabilitySettingsDto } from "@/services/apis/gen/queries";

export const severities = ['critical', 'high', 'medium', 'low', 'info'] as const;
const integer = (value: number, max: number) => Number.isInteger(value) && value >= 1 && value <= max;
export function validFindingPolicy(value: VulnerabilitySettingsDto) {
  return severities.every(key => value.slaDays[key] === null || integer(value.slaDays[key], 3650)) &&
    integer(value.autoCloseMissedScans, 10) && integer(value.riskAcceptMaxDays, 3650);
}
export function findingPolicyChanges(saved: VulnerabilitySettingsDto, draft: VulnerabilitySettingsDto): UpdateVulnerabilitySettingsDto {
  const changed: UpdateVulnerabilitySettingsDto = {};
  for (const key of ['slaRestartOnResurface', 'autoCloseEnabled', 'autoCloseMissedScans', 'riskAcceptMaxDays'] as const)
    if (draft[key] !== saved[key]) Object.assign(changed, { [key]: draft[key] });
  const sla = Object.fromEntries(severities.filter(key => saved.slaDays[key] !== draft.slaDays[key])
    .map(key => [key, draft.slaDays[key]]));
  if (Object.keys(sla).length) changed.slaDays = sla;
  return changed;
}
