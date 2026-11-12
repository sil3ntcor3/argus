import { Checkbox } from '@/components/ui/checkbox';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import {
  Severity,
  type ProjectTriggerConfigDto,
  type ProjectTriggerEvent,
  type TargetType,
} from '@/services/apis/gen/queries';
import { useId } from 'react';
import { cn } from '@/lib/utils';

const targetTypes: [TargetType, string][] = [
  ['DOMAIN', 'Domains'],
  ['IP', 'IPs'],
  ['CIDR', 'CIDR ranges'],
  ['GIT_ORG', 'Repositories'],
];
const outcomes = [
  ['success', 'Succeeded'],
  ['failure', 'Failed'],
] as const;
const severities = Object.values(Severity)
  .reverse()
  .map((value) => [value, value[0].toUpperCase() + value.slice(1)] as const);

/** Label a bounded, keyboard-accessible set of independent filter choices. */
function Choices<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled,
  hint,
  required = false,
  fullWidth = false,
}: {
  label: string;
  options: readonly (readonly [T, string])[];
  value: T[];
  onChange: (value: T[]) => void;
  disabled: boolean;
  hint: string;
  required?: boolean;
  fullWidth?: boolean;
}) {
  const id = useId();
  return (
    <FieldSet
      disabled={disabled}
      aria-describedby={id + '-hint'}
      aria-invalid={required && !value.length}
    >
      <FieldLegend variant="label">{label}</FieldLegend>
      <FieldGroup
        className={cn(
          'grid max-h-44 gap-2 overflow-y-auto',
          fullWidth ? 'grid-cols-1' : 'grid-cols-2',
        )}
      >
        {options.map(([option, text], index) => (
          <Field key={option} orientation="horizontal">
            <Checkbox
              id={id + index}
              checked={value.includes(option)}
              disabled={disabled}
              onCheckedChange={(checked) =>
                onChange(
                  checked === true
                    ? [...value, option]
                    : value.filter((v) => v !== option),
                )
              }
            />
            <FieldLabel htmlFor={id + index}>{text}</FieldLabel>
          </Field>
        ))}
      </FieldGroup>
      <FieldDescription id={id + '-hint'}>{hint}</FieldDescription>
    </FieldSet>
  );
}

/** Keep optional drafts separate while exposing only the selected event's fields. */
export function ProjectTriggerFilters({
  event,
  value,
  onChange,
  disabled,
  otherWorkflows,
}: {
  event: ProjectTriggerEvent;
  value: ProjectTriggerConfigDto;
  onChange: (patch: ProjectTriggerConfigDto) => void;
  disabled: boolean;
  otherWorkflows: string[];
}) {
  const followed = [
    ...new Set([...otherWorkflows, ...(value.workflows ?? [])]),
  ];
  return (
    <FieldGroup>
      <Choices
        label="Target types"
        options={targetTypes}
        value={value.targetTypes ?? []}
        onChange={(targetTypes) => onChange({ targetTypes })}
        disabled={disabled}
        hint="None checked means every target type."
      />
      {event === 'project.run.completed' && (
        <>
          <Choices
            label="After workflows"
            fullWidth
            options={followed.map((name) => [name, name] as const)}
            value={value.workflows ?? []}
            onChange={(workflows) => onChange({ workflows })}
            disabled={disabled}
            hint="None checked means any other project workflow. Choose up to 20 names."
          />
          <Choices
            label="Run outcomes"
            options={outcomes}
            value={value.status ?? ['success']}
            onChange={(status) => onChange({ status })}
            disabled={disabled}
            required
            hint="Select at least one run outcome."
          />
        </>
      )}
      {event === 'vulnerability.detected' && (
        <Choices
          label="Finding severities"
          options={severities}
          value={value.severity ?? ['critical', 'high']}
          onChange={(severity) => onChange({ severity })}
          disabled={disabled}
          required
          hint="Select at least one severity. This workflow’s own findings are excluded."
        />
      )}
    </FieldGroup>
  );
}
