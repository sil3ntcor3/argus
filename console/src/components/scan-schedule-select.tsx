import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { UpdateTargetDtoScanSchedule } from '@/services/apis/gen/queries';
import { Clock, X } from 'lucide-react';
import { scanScheduleOptions } from './scan-schedule-options';

interface ScanScheduleSelectProps {
  value?: UpdateTargetDtoScanSchedule;
  onChange: (value: UpdateTargetDtoScanSchedule) => void;
  disabled?: boolean;
}

export const ScanScheduleSelect = ({
  value = UpdateTargetDtoScanSchedule.disabled,
  onChange,
  disabled,
}: ScanScheduleSelectProps) => {
  return (
    <Select disabled={disabled} value={value} onValueChange={onChange}>
      <SelectTrigger id="scan-frequency" className="w-[160px] h-9 text-sm">
        <SelectValue placeholder="Select frequency" />
      </SelectTrigger>
      <SelectContent>
        {scanScheduleOptions.map((option) => (
          <SelectItem
            className="cursor-pointer"
            key={option.value}
            value={option.value}
          >
            {option.value === UpdateTargetDtoScanSchedule.disabled ? (
              <X className="inline-block w-4 h-4 mr-2" />
            ) : (
              <Clock className="inline-block w-4 h-4 mr-2" />
            )}
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};
