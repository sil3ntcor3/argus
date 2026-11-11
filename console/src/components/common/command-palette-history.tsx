import { useIsMutating, useQueryClient } from '@tanstack/react-query';
import { Pencil, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  getSearchControllerGetSearchHistoryQueryKey,
  useSearchControllerDeleteSearchHistory,
  useSearchControllerGetSearchHistory,
} from '@/services/apis/gen/queries';

const mutationFilter = { mutationKey: ['delete-recent-search'] };

export function CommandPaletteHistory({
  onRepeat,
  onFill,
  focusSearch,
}: {
  onRepeat: (query: string) => void;
  onFill: (query: string) => void;
  focusSearch: () => void;
}) {
  const queryClient = useQueryClient();
  const { data, isLoading, isError } = useSearchControllerGetSearchHistory({
    limit: 10,
  });
  const isDeleting = useIsMutating(mutationFilter) > 0;
  const { mutate } = useSearchControllerDeleteSearchHistory({
    mutation: {
      ...mutationFilter,
      onSuccess: () =>
        queryClient.invalidateQueries({
          queryKey: getSearchControllerGetSearchHistoryQueryKey(),
        }),
      onError: () => toast.error('Could not delete the recent search.'),
    },
  });
  const deleteEntry = (id: string) => {
    if (queryClient.isMutating(mutationFilter)) return;
    focusSearch();
    mutate({ id });
  };

  const entries = isError ? [] : (data?.data ?? []);
  let status = '';
  if (isLoading) status = 'Loading recent searches…';
  else if (isError) status = 'Recent searches are unavailable.';
  else if (!entries.length) status = 'No recent searches.';

  return (
    <section
      aria-label="Recent searches"
      aria-busy={isLoading || isDeleting}
      className="border-t px-2 py-2"
    >
      <h2 className="px-2 py-1 text-xs font-medium text-muted-foreground">
        Recent searches
      </h2>
      {status && (
        <p className="px-2 py-2 text-sm text-muted-foreground" role="status">
          {status}
        </p>
      )}
      {!!entries.length && (
        <ul className="max-h-44 overflow-y-auto">
          {entries.map((entry) => (
            <li key={entry.id} className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                className="min-w-0 flex-1 justify-start px-2 font-normal"
                onClick={() => onRepeat(entry.query)}
              >
                <span className="truncate">{entry.query}</span>
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Fill search from ${entry.query}`}
                onClick={() => onFill(entry.query)}
              >
                <Pencil className="size-4" aria-hidden />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Delete recent search ${entry.query}`}
                disabled={isDeleting}
                onClick={() => deleteEntry(entry.id)}
              >
                <X className="size-4" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
