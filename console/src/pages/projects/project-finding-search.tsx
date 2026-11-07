import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { type RefObject, useEffect, useRef } from 'react';
import { z } from 'zod';

const maxSearchLength = 200;
export const projectFindingSearchTerm = z
  .string()
  .max(maxSearchLength)
  .refine((term) => !term.includes('\u0000'))
  .transform((term) => term || undefined);

export function ProjectFindingSearch({
  inputRef,
  term,
  onChange,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  term?: string;
  onChange: (term?: string) => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);

  // Sync copied links and browser history without replacing the focused input.
  useEffect(() => {
    formRef.current?.reset();
  }, [term]);

  return (
    <form
      ref={formRef}
      role="search"
      aria-label="Project findings search"
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const value = new FormData(event.currentTarget).get('term');
        const parsed = projectFindingSearchTerm.safeParse(value);
        if (parsed.success) onChange(parsed.data);
      }}
    >
      <label className="flex min-w-0 max-w-full flex-1 flex-col gap-1 text-sm sm:max-w-xs">
        Search findings
        <Input
          ref={inputRef}
          name="term"
          type="search"
          defaultValue={term}
          maxLength={maxSearchLength}
          className="focus-visible:ring-2 focus-visible:ring-ring"
          placeholder="Finding, asset, or CVE"
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
            inputRef.current?.focus();
            onChange(undefined);
          }}
        >
          Clear search
        </Button>
      )}
    </form>
  );
}
