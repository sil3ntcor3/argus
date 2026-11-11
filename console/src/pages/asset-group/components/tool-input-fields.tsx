import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { DataKind, ToolCategorySpec } from '@/services/apis/gen/queries';
import { describeKinds, KIND_LABEL } from './tool-io';

/** Show ordered inputs and all outputs, retaining unknown versus explicit none. */
export function ToolIOInfo({
  capability,
  input,
}: {
  capability?: ToolCategorySpec;
  input?: DataKind[];
}) {
  const takes = input?.length ? input : capability?.inputs;
  const finds = capability?.produces;
  return (
    <div className="flex flex-col gap-1 text-xs text-muted-foreground">
      <p>Takes {takes?.length ? describeKinds(takes) : 'not declared'}</p>
      <p>
        Finds{' '}
        {finds === undefined
          ? 'not declared'
          : finds.length
            ? finds.map((kind) => KIND_LABEL[kind]).join(', ')
            : 'none'}
      </p>
    </div>
  );
}

/** Default follows catalog preferences; a saved custom order remains explicit. */
export function ToolInputSelect({
  id,
  accepted,
  value,
  disabled,
  onChange,
}: {
  id: string;
  accepted: DataKind[];
  value?: DataKind[];
  disabled?: boolean;
  onChange: (input: DataKind[] | undefined) => void;
}) {
  if (accepted.length < 2) return null;
  const custom = value && value.length > 1;
  const selected = custom ? '__custom__' : (value?.[0] ?? '__default__');
  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor={id}>Input preference</FieldLabel>
        <Select
          value={selected}
          disabled={disabled}
          onValueChange={(next) => {
            if (next !== '__custom__')
              onChange(next === '__default__' ? undefined : [next as DataKind]);
          }}
        >
          <SelectTrigger
            id={id}
            size="sm"
            className="w-full"
            title={custom ? describeKinds(value) : undefined}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__default__">
              Default: {describeKinds(accepted)}
            </SelectItem>
            {custom && (
              <SelectItem value="__custom__" disabled>
                Custom: {describeKinds(value)}
              </SelectItem>
            )}
            {accepted.map((kind) => (
              <SelectItem key={kind} value={kind}>
                Only {KIND_LABEL[kind]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </FieldGroup>
  );
}
