import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { CloudCheck, Search, Target } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import useDebounce from '@/hooks/use-debounce';
import { usePermission } from '@/hooks/usePermission';
import { useSearchControllerSearchAssetsTargets } from '@/services/apis/gen/queries';
import { useSession } from '@/utils/authClient';
import { getVisibleNavGroups, menu } from './layout/menu-bar';

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const returnFocus = useRef<HTMLElement | null>(null);
  const navigate = useNavigate();
  const { data: session } = useSession();
  const {
    hasPermission,
    isLoading: permissionsLoading,
    error: permissionsError,
  } = usePermission();
  const canSearch =
    !permissionsError &&
    hasPermission('asset.read') &&
    hasPermission('target.read');

  const changeOpen = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) setQuery('');
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        event.altKey ||
        event.shiftKey ||
        event.key.toLowerCase() !== 'k' ||
        (!event.ctrlKey && !event.metaKey)
      ) {
        return;
      }
      event.preventDefault();
      if (!open && document.activeElement instanceof HTMLElement) {
        returnFocus.current = document.activeElement;
      }
      changeOpen(!open);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, changeOpen]);

  const term = query.trim();
  const debounced = useDebounce(term, 250);
  const searchReady =
    open && canSearch && term.length > 0 && term === debounced;
  const { data, isError, isFetching } = useSearchControllerSearchAssetsTargets(
    { value: debounced, isSaveHistory: false },
    { query: { enabled: searchReady } },
  );
  const results = searchReady && !isError ? data?.data : undefined;

  const pages = getVisibleNavGroups(
    menu,
    (permission) => !permissionsError && hasPermission(permission),
    session?.user.role,
  )
    .flatMap((group) => group.items)
    .filter((item) => item.title.toLowerCase().includes(term.toLowerCase()))
    .slice(0, 6);

  let status: string | undefined;
  if (term) {
    if (permissionsError) status = 'Workspace access could not be verified.';
    else if (permissionsLoading) status = 'Checking workspace access…';
    else if (!canSearch)
      status = 'Search requires target and asset read access.';
    else if (!searchReady || isFetching) status = 'Searching…';
    else if (isError) status = 'Search is unavailable. Try again.';
    else if (data?.total === 0) status = 'No preview matches.';
  }

  const choose = (go: () => Promise<void>) => {
    changeOpen(false);
    void go();
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Open command palette"
          aria-keyshortcuts="Control+K Meta+K"
          className="size-9 lg:h-8 lg:w-auto lg:px-2"
        >
          <Search className="size-4 lg:hidden" aria-hidden />
          <kbd className="hidden text-xs text-muted-foreground lg:inline">
            Ctrl / ⌘ K
          </kbd>
        </Button>
      </DialogTrigger>
      <DialogContent
        className="gap-0 overflow-hidden p-0 sm:p-0"
        onCloseAutoFocus={(event) => {
          const previous = returnFocus.current;
          returnFocus.current = null;
          if (
            previous?.isConnected &&
            previous !== document.body &&
            previous.getClientRects().length
          ) {
            event.preventDefault();
            previous.focus({ preventScroll: true });
          }
        }}
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">
          Jump to a page or search this workspace for targets and assets.
        </DialogDescription>
        <Command shouldFilter={false} label="Search targets, assets, or pages">
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Search or jump to a page…"
            className="pr-9"
          />
          <CommandList>
            {status && (
              <p
                className="px-3 py-2 text-sm text-muted-foreground"
                role="status"
              >
                {status}
              </p>
            )}
            {!status && <CommandEmpty>No results found.</CommandEmpty>}
            {!!pages.length && (
              <CommandGroup heading="Pages">
                {pages.map((item) => (
                  <CommandItem
                    key={item.url}
                    value={`page ${item.url}`}
                    onSelect={() => choose(() => navigate({ to: item.url }))}
                  >
                    <span className="size-4 [&>svg]:size-4" aria-hidden>
                      {item.icon}
                    </span>
                    {item.title}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {!!results?.targets.length && (
              <CommandGroup heading="Targets">
                {results.targets.slice(0, 5).map((target) => (
                  <CommandItem
                    key={target.id}
                    value={`target ${target.id}`}
                    onSelect={() =>
                      choose(() =>
                        navigate({
                          to: '/targets/$id/$tab',
                          params: { id: target.id, tab: 'inventory' },
                        }),
                      )
                    }
                  >
                    <Target className="size-4" aria-hidden />
                    <span className="truncate">{target.value}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {!!results?.assets.length && (
              <CommandGroup heading="Assets">
                {results.assets.slice(0, 5).map((asset) => (
                  <CommandItem
                    key={asset.id}
                    value={`asset ${asset.id}`}
                    onSelect={() =>
                      choose(() =>
                        navigate({
                          to: '/assets/services/$id',
                          params: { id: asset.id },
                        }),
                      )
                    }
                  >
                    <CloudCheck className="size-4" aria-hidden />
                    <span className="truncate">{asset.value}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {canSearch && term && (
              <CommandGroup>
                <CommandItem
                  value="search all"
                  onSelect={() =>
                    choose(() =>
                      navigate({
                        to: '/search',
                        search: { query: term },
                      }),
                    )
                  }
                >
                  <Search className="size-4" aria-hidden />
                  Search all targets and assets
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
