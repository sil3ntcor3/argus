import { UpdateTargetDtoScanSchedule } from '@/services/apis/gen/queries';

export const scanScheduleOptions = [
  {
    value: UpdateTargetDtoScanSchedule['disabled'],
    label: 'Disabled',
  },
  {
    value: UpdateTargetDtoScanSchedule['0_0_*_*_*'],
    label: 'Daily',
  },
  {
    value: UpdateTargetDtoScanSchedule['0_0_*/3_*_*'],
    label: 'Every 3 days',
  },
  {
    value: UpdateTargetDtoScanSchedule['0_0_*_*_0'],
    label: 'Weekly',
  },
  {
    value: UpdateTargetDtoScanSchedule['0_0_*/14_*_*'],
    label: 'Every 2 weeks',
  },
  {
    value: UpdateTargetDtoScanSchedule['0_0_1_*_*'],
    label: 'Monthly',
  },
];
