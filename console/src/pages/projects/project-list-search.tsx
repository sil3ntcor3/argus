import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { type RefObject, useEffect, useRef } from 'react';
import { z } from 'zod';

function searchTerm(maxLength: number) {
  return z
    .string()
    .max(maxLength)
    .refine((term) => !term.includes('\u0000'))
    .transform((term) => term || undefined);
}

// Direct URL search values can be parsed as primitives by the router.
export function projectListQueryParam(maxLength: number) {
  return z
    .preprocess(
      (value) =>
        typeof value === 'number' || typeof value === 'boolean'
          ? String(value)
          : value,
      searchTerm(maxLength).optional(),
    )
    .catch(undefined);
}

export function ProjectListSearch({
  inputRef,
  label,
  regionLabel,
  placeholder,
  maxLength,
  term,
  onChange,
}: {
  inputRef?: RefObject<HTMLInputElement | null>;
  label: string;
  regionLabel: string;
  placeholder: string;
  maxLength: number;
  term?: string;
  onChange: (term?: string) => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const fallbackInput = useRef<HTMLInputElement>(null);
  const input = inputRef ?? fallbackInput;

  // Sync copied links and browser history without replacing the focused input.
  useEffect(() => {
    formRef.current?.reset();
  }, [term]);

  return (
    <form
      ref={formRef}
      role="search"
      aria-label={regionLabel}
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const value = new FormData(event.currentTarget).get('term');
        const parsed = searchTerm(maxLength).safeParse(value);
        if (parsed.success) onChange(parsed.data);
      }}
    >
      <label className="flex min-w-0 max-w-full flex-1 flex-col gap-1 text-sm sm:max-w-xs">
        {label}
        <Input
          ref={input}
          name="term"
          type="search"
          defaultValue={term}
          maxLength={maxLength}
          className="focus-visible:ring-2 focus-visible:ring-ring"
          placeholder={placeholder}
        />
      </label>
      <Button type="submit" variant="outline">
        Search
      </Button>
      {term && (
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            input.current?.focus();
            onChange(undefined);
          }}
        >
          Clear search
        </Button>
      )}
    </form>
  );
}
