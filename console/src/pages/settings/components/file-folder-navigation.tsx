import { Button } from '@/components/ui/button';
import type {
  ArtifactFolderDto,
  ArtifactFolderPathItemDto,
} from '@/services/apis/gen/queries';
import { ChevronRight, Folder } from 'lucide-react';

/** Show the current folder path and direct child folders above file results. */
export function FileFolderNavigation({
  folderId,
  path,
  folders,
  failed,
  onOpen,
  onRetry,
}: {
  folderId?: string;
  path?: ArtifactFolderPathItemDto[];
  folders?: ArtifactFolderDto[];
  failed: boolean;
  onOpen: (id?: string) => void;
  onRetry: () => void;
}) {
  return (
    <>
      {folderId ? (
        <nav aria-label="Folder path">
          <ol className="flex flex-wrap items-center gap-1 text-sm">
            <li>
              <Button
                variant="ghost"
                size="sm"
                aria-label="Root folder"
                onClick={() => onOpen()}
              >
                Root
              </Button>
            </li>
            {path?.map(({ id, name }) => (
              <li key={id} className="flex min-w-0 items-center gap-1">
                <ChevronRight aria-hidden="true" className="size-4 shrink-0" />
                {id === folderId ? (
                  <span aria-current="location" className="break-all">
                    {name}
                  </span>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="whitespace-normal break-all"
                    onClick={() => onOpen(id)}
                  >
                    {name}
                  </Button>
                )}
              </li>
            ))}
          </ol>
        </nav>
      ) : null}
      {failed ? (
        <div className="flex items-center gap-3 rounded-md border p-4 text-sm">
          <p>Could not load folders.</p>
          <Button variant="outline" size="sm" onClick={onRetry}>
            Retry folders
          </Button>
        </div>
      ) : !folders ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading folders…
        </p>
      ) : folders.length ? (
        <div role="group" aria-label="Folders" className="flex flex-wrap gap-2">
          {folders.map(({ id, name }) => (
            <Button
              key={id}
              variant="outline"
              size="sm"
              className="h-auto max-w-full justify-start whitespace-normal break-all"
              onClick={() => onOpen(id)}
            >
              <Folder
                aria-hidden="true"
                className="size-4 shrink-0 fill-amber-400 text-amber-500"
              />
              {name}
            </Button>
          ))}
        </div>
      ) : null}
    </>
  );
}
