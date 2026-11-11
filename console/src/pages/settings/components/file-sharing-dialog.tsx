import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { handleServerError } from '@/lib/handle-server-error';
import {
  artifactsControllerAddShares,
  artifactsControllerRemoveShare,
  artifactsControllerUpdateAccess,
  getArtifactsControllerGetByIdQueryKey,
  getArtifactsControllerGetManyQueryKey,
  getArtifactsControllerGetSharesQueryKey,
  useArtifactsControllerGetById,
  useArtifactsControllerGetShares,
  type ArtifactListItemDto,
} from '@/services/apis/gen/queries';
import {
  getGlobalWorkspaceId,
  subscribeGlobalWorkspaceId,
} from '@/utils/workspaceState';
import { useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { Copy, X } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { toast } from 'sonner';

const ACCESS_OPTIONS = [
  { value: 'private', label: 'Private' },
  { value: 'shared', label: 'Selected members' },
  { value: 'public', label: 'Public link' },
] as const;
const freshRead = {
  staleTime: 0,
  refetchOnMount: 'always' as const,
  retry: false,
};

interface FileSharingDialogProps {
  file: ArtifactListItemDto;
  workspaceId: string;
  focusAfterClose: RefObject<HTMLElement | null>;
  onClose: () => void;
  onAccessDenied: () => void;
}

/** Manage one owned file after fresh workspace-scoped ownership and recipient reads. */
export function FileSharingDialog({
  file,
  workspaceId,
  focusAfterClose,
  onClose,
  onAccessDenied,
}: FileSharingDialogProps) {
  const client = useQueryClient();
  const mounted = useRef(false);
  const request = useRef<AbortController | null>(null);
  const recipientsRegion = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState(false);
  const [emails, setEmails] = useState('');
  const [inputError, setInputError] = useState('');
  const [notice, setNotice] = useState('');
  const metadata = useArtifactsControllerGetById(file.id, {
    query: { ...freshRead, meta: { workspaceId } },
  });
  const owned =
    metadata.isFetchedAfterMount &&
    !metadata.isError &&
    metadata.data?.isOwner === true;
  const shares = useArtifactsControllerGetShares(file.id, {
    query: { ...freshRead, meta: { workspaceId }, enabled: owned },
  });
  const recipients =
    shares.isFetchedAfterMount && !shares.isError ? shares.data : undefined;
  const access = owned ? metadata.data?.shareType : undefined;
  const publicUrl = `${window.location.origin}/api/public/artifacts/${file.id}`;
  const denied = [metadata.error, shares.error].some(
    (error) =>
      isAxiosError(error) &&
      (error.response?.status === 401 || error.response?.status === 403),
  );

  useEffect(() => {
    mounted.current = true;
    const abort = () => request.current?.abort();
    const unsubscribe = subscribeGlobalWorkspaceId(abort);
    return () => {
      mounted.current = false;
      unsubscribe();
      abort();
    };
  }, []);
  useEffect(() => {
    if (denied) onAccessDenied();
  }, [denied, onAccessDenied]);

  /** Prevent updates from a closed dialog or a different selected workspace. */
  function isCurrent() {
    return mounted.current && getGlobalWorkspaceId() === workspaceId;
  }

  /** Serialize writes, cancel on context changes, and refresh even after partial failures. */
  async function change<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    done: (result: T) => void,
  ) {
    if (request.current || !isCurrent()) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setNotice('');
    try {
      const result = await operation(controller.signal);
      if (isCurrent() && !controller.signal.aborted) done(result);
    } catch (error) {
      if (isCurrent() && !controller.signal.aborted) {
        if (
          isAxiosError(error) &&
          [401, 403].includes(error.response?.status ?? 0)
        )
          onAccessDenied();
        handleServerError(error);
      }
    } finally {
      await Promise.allSettled(
        [
          getArtifactsControllerGetManyQueryKey(),
          getArtifactsControllerGetByIdQueryKey(file.id),
          getArtifactsControllerGetSharesQueryKey(file.id),
        ].map((queryKey) =>
          client.invalidateQueries({
            queryKey,
            predicate: (cached) => cached.meta?.workspaceId === workspaceId,
            refetchType:
              getGlobalWorkspaceId() === workspaceId ? 'active' : 'none',
          }),
        ),
      );
      request.current = null;
      if (isCurrent()) setBusy(false);
    }
  }

  /** Save the selected mode and use the server's returned metadata. */
  function changeAccess(shareType: ArtifactListItemDto['shareType']) {
    return change(
      (signal) =>
        artifactsControllerUpdateAccess(
          file.id,
          { shareType },
          undefined,
          signal,
        ),
      (result) => {
        client.setQueryData(
          getArtifactsControllerGetByIdQueryKey(file.id),
          result,
        );
        toast.success('File access updated');
      },
    );
  }

  /** Save normalized recipients and enable named access for a private file. */
  function addPeople() {
    const addresses = [
      ...new Set(
        emails
          .split(/[\s,;]+/)
          .filter(Boolean)
          .map((email) => email.toLowerCase()),
      ),
    ];
    if (addresses.length < 1 || addresses.length > 50) {
      setInputError('Enter between 1 and 50 email addresses.');
      return;
    }
    setInputError('');
    return change(
      async (signal) => {
        const result = await artifactsControllerAddShares(
          file.id,
          { emails: addresses },
          undefined,
          signal,
        ).catch((error: unknown) => {
          if (
            isCurrent() &&
            !signal.aborted &&
            isAxiosError(error) &&
            error.response?.status === 400
          ) {
            setInputError('Check each email address and try again.');
          }
          throw error;
        });
        let updated: ArtifactListItemDto | undefined;
        if (result.shared && access === 'private') {
          try {
            updated = await artifactsControllerUpdateAccess(
              file.id,
              { shareType: 'shared' },
              undefined,
              signal,
            );
          } catch (error) {
            if (isCurrent() && !signal.aborted)
              setNotice(
                'Recipients were saved. Set General access to Selected members to allow downloads.',
              );
            throw error;
          }
        }
        return { ...result, updated };
      },
      (result) => {
        if (result.updated)
          client.setQueryData(
            getArtifactsControllerGetByIdQueryKey(file.id),
            result.updated,
          );
        setEmails('');
        if (result.shared) toast.success('Recipients saved');
        if (result.skipped)
          toast.warning(
            result.skipped === 1
              ? 'One email address was skipped'
              : `${result.skipped} email addresses were skipped`,
          );
      },
    );
  }

  /** Revoke one recipient and leave keyboard focus on the recipient section. */
  function removePerson(id: string) {
    return change(
      (signal) =>
        artifactsControllerRemoveShare(file.id, id, undefined, signal),
      () => {
        recipientsRegion.current?.focus();
        toast.success('Recipient removed');
      },
    );
  }

  /** Copy a public link only while the current file is confirmed public. */
  async function copyLink() {
    if (!isCurrent() || busy || access !== 'public') return;
    try {
      await navigator.clipboard.writeText(publicUrl);
      if (isCurrent()) toast.success('Link copied');
    } catch (error) {
      if (isCurrent()) handleServerError(error);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="max-h-[85dvh] overflow-y-auto"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          focusAfterClose.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle className="break-all pr-6">
            Share {file.name}
          </DialogTitle>
          <DialogDescription>
            Choose file access and manage recipients in this workspace.
          </DialogDescription>
        </DialogHeader>
        {metadata.isError ? (
          <div role="alert" className="space-y-2">
            <p>Could not verify file ownership.</p>
            <Button variant="outline" onClick={() => void metadata.refetch()}>
              Retry file access
            </Button>
          </div>
        ) : !metadata.isFetchedAfterMount ? (
          <p role="status">Loading file access…</p>
        ) : !owned ? (
          <p role="alert">This file is no longer owned by you.</p>
        ) : (
          <>
            <div className="space-y-2">
              <Label htmlFor="file-access-mode">General access</Label>
              <Select
                value={access}
                disabled={busy || denied}
                onValueChange={(value) => {
                  const mode = ACCESS_OPTIONS.find(
                    (option) => option.value === value,
                  );
                  if (mode) void changeAccess(mode.value);
                }}
              >
                <SelectTrigger id="file-access-mode" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ACCESS_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {access === 'public' && (
              <div className="space-y-2">
                <Label htmlFor="file-public-link">Public link</Label>
                <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                  <Input id="file-public-link" readOnly value={publicUrl} />
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="Copy public link"
                    disabled={busy}
                    onClick={() => void copyLink()}
                  >
                    <Copy aria-hidden="true" className="size-4" />
                  </Button>
                </div>
                <p className="text-sm text-muted-foreground">
                  Anyone with the link can download this file. Download URLs
                  expire after five minutes.
                </p>
              </div>
            )}
            <section
              ref={recipientsRegion}
              tabIndex={-1}
              aria-label="Recipients"
              className="space-y-2"
            >
              <h4 className="text-sm font-medium">Recipients</h4>
              {shares.isError ? (
                <div role="alert" className="space-y-2">
                  <p>Could not load recipients.</p>
                  <Button
                    variant="outline"
                    onClick={() => void shares.refetch()}
                  >
                    Retry recipients
                  </Button>
                </div>
              ) : recipients === undefined ? (
                <p role="status">Loading recipients…</p>
              ) : recipients.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No recipients added.
                </p>
              ) : (
                <ul className="space-y-2">
                  {recipients.map((recipient) => (
                    <li key={recipient.id} className="flex items-center gap-2">
                      <Avatar>
                        <AvatarImage
                          src={recipient.image ?? undefined}
                          alt=""
                        />
                        <AvatarFallback>
                          {recipient.name.slice(0, 2).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <span className="min-w-0 flex-1 break-all text-sm">
                        {recipient.name}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove ${recipient.name}`}
                        disabled={busy || denied}
                        onClick={() => void removePerson(recipient.id)}
                      >
                        <X aria-hidden="true" className="size-4" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                void addPeople();
              }}
            >
              <Label htmlFor="file-share-emails">Add people</Label>
              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                <Input
                  id="file-share-emails"
                  value={emails}
                  disabled={busy || denied || recipients === undefined}
                  aria-invalid={!!inputError}
                  aria-describedby={
                    inputError
                      ? 'file-share-email-help file-share-email-error'
                      : 'file-share-email-help'
                  }
                  autoComplete="off"
                  onChange={(event) => {
                    setEmails(event.target.value);
                    setInputError('');
                  }}
                />
                <Button
                  type="submit"
                  disabled={busy || denied || recipients === undefined}
                >
                  Add
                </Button>
              </div>
              <p
                id="file-share-email-help"
                className="text-sm text-muted-foreground"
              >
                Separate workspace member emails with spaces or commas.
              </p>
              {access === 'private' && (
                <p className="text-sm text-muted-foreground">
                  Adding people switches access to Selected members.
                </p>
              )}
              {inputError && (
                <p
                  id="file-share-email-error"
                  role="alert"
                  className="text-sm text-destructive"
                >
                  {inputError}
                </p>
              )}
            </form>
            {notice && (
              <p role="status" className="text-sm">
                {notice}
              </p>
            )}
            {busy && (
              <p role="status" className="text-sm">
                Saving sharing changes…
              </p>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
