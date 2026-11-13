import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { usePermission } from '@/hooks/usePermission';
import { useWorkspaceState } from '@/hooks/useWorkspaceSelector';
import { useSession } from '@/utils/authClient';
import { getGlobalWorkspaceId } from '@/utils/workspaceState';
import {
  commentsControllerListIssueComments, commentsControllerListVulnerabilityComments,
  commentsControllerCreateIssueComment, commentsControllerCreateVulnerabilityComment,
  commentsControllerUpdateComment, commentsControllerDeleteComment,
  type CommentAuthorDto, type CommentResponseDto,
} from '@/services/apis/gen/queries';
import { useInfiniteQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { Activity, MessageSquare, Pencil, Reply, Trash2, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { useCommentWrite } from './use-comment-write';

export interface CommentSubject { type: 'issue' | 'vulnerability'; id: string }
type Action = { type: 'create'; content: string; repCommentId?: string } |
  { type: 'edit'; id: string; content: string } | { type: 'delete'; id: string };
const MAX_LENGTH = 10_000;
const PAGE_SIZE = 100;

/** Explicit workspace scope also protects callers using a custom query-key hash. */
export const commentThreadQueryKey = (subject: CommentSubject, workspaceId: string) =>
  ['comments', workspaceId, subject.type, subject.id] as const;

/** Discussion authors expose only their public display identity. */
function UserAvatar({ user }: { user: CommentAuthorDto | null }) {
  const initials = user?.name.trim().split(/\s+/).map(part => part[0]).slice(0, 2).join('').toUpperCase() || '?';
  return <Avatar className="size-7 shrink-0">
    {user?.image && <AvatarImage src={user.image} alt={user.name} />}
    <AvatarFallback className="text-[10px]">{initials}</AvatarFallback>
  </Avatar>;
}

/** Reset drafts and dialogs when the selected workspace or subject changes. */
export function CommentThread({ subject }: { subject: CommentSubject }) {
  const { state: { selectedWorkspaceId } } = useWorkspaceState();
  const { hasPermission, isFetching, isLoading } = usePermission();
  const domain = subject.type === 'issue' ? 'workspace' : 'vulnerability';
  if (!selectedWorkspaceId) return <p className="text-sm text-muted-foreground">Select a workspace to view comments.</p>;
  if (isLoading) return <Skeleton className="h-24" aria-label="Loading discussion access" />;
  if (!hasPermission(domain + '.read')) return <p role="alert">You do not have access to this discussion.</p>;
  return <ScopedThread key={`${selectedWorkspaceId}:${subject.type}:${subject.id}`}
    subject={subject} workspaceId={selectedWorkspaceId} canWrite={!isFetching && hasPermission(domain + '.write')} />;
}

/** Keep query data, mutation outcomes and drafts attached to one workspace thread. */
function ScopedThread({ subject, workspaceId, canWrite }: { subject: CommentSubject; workspaceId: string; canWrite: boolean }) {
  const { data: session } = useSession();
  const queryKey = commentThreadQueryKey(subject, workspaceId);
  const query = useInfiniteQuery({
    queryKey, initialPageParam: 1, retry: false, refetchOnMount: 'always',
    queryFn: ({ pageParam, signal }) => {
      if (getGlobalWorkspaceId() !== workspaceId) throw new Error('Workspace changed');
      const params = { page: pageParam, limit: PAGE_SIZE };
      return subject.type === 'issue'
        ? commentsControllerListIssueComments(subject.id, params, undefined, signal)
        : commentsControllerListVulnerabilityComments(subject.id, params, undefined, signal);
    },
    getNextPageParam: last => last.hasNextPage ? last.page + 1 : undefined,
  });
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<CommentResponseDto | null>(null);
  const [editing, setEditing] = useState<CommentResponseDto | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [deleting, setDeleting] = useState<CommentResponseDto | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);
  const dialogTriggerRef = useRef<HTMLButtonElement>(null);
  const restoreDialogFocus = (event: Event) => {
    event.preventDefault();
    const trigger = dialogTriggerRef.current;
    if (trigger?.isConnected && !trigger.disabled) trigger.focus({ preventScroll: true });
    else threadRef.current?.focus({ preventScroll: true });
  };
  const clearAction = (action: Action) => {
    if (action.type === 'create') { setDraft(''); setReplyTo(null); }
    if (action.type === 'edit') setEditing(null);
    if (action.type === 'delete') {
      setDeleting(null);
      if (replyTo?.id === action.id) setReplyTo(null);
      if (editing?.id === action.id) setEditing(null);
    }
  };
  const write = useCommentWrite<Action>({
    workspaceId, queryKey, canWrite: canWrite && Boolean(session?.user?.id),
    perform: (action, request) => {
      if (action.type === 'delete') return commentsControllerDeleteComment(action.id, request);
      if (action.type === 'edit') return commentsControllerUpdateComment(action.id, { content: action.content }, request);
      const data = { content: action.content, ...(action.repCommentId ? { repCommentId: action.repCommentId } : {}) };
      return subject.type === 'issue' ? commentsControllerCreateIssueComment(subject.id, data, request)
        : commentsControllerCreateVulnerabilityComment(subject.id, data, request);
    },
    onSuccess: clearAction,
    onDiscard: actions => { actions.forEach(clearAction); setDiscarding(false); },
  });
  const ready = query.isFetchedAfterMount && !query.isError;
  const comments = ready ? query.data?.pages.flatMap(page => page.data) ?? [] : [];
  const locked = write.busy || write.uncertain || !ready || !canWrite || !session?.user?.id;
  const submit = () => {
    if (locked || !draft.trim() || draft.length > MAX_LENGTH) return;
    void write.run({ type: 'create', content: draft.trim(), repCommentId: replyTo?.id });
  };
  const reload = async () => { await query.refetch({ throwOnError: true }); };
  const timeAgo = (value: string) => {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? formatDistanceToNow(date, { addSuffix: true }) : '';
  };

  return <div ref={threadRef} tabIndex={-1} role="region" aria-label="Discussion thread"
    className="flex min-w-0 flex-col gap-4" data-testid="comment-thread" aria-busy={write.busy}>
    {!query.isFetchedAfterMount && !query.isError ? <div role="status" aria-label="Loading comments" className="space-y-3">
      {[0, 1, 2].map(id => <Skeleton key={id} className="h-14 w-full" />)}
    </div> : query.isError ? <div role="alert" className="space-y-2">
      <p>Unable to load comments.</p><Button variant="outline" size="sm" disabled={query.isFetching}
        onClick={() => void write.checkSaved(reload)}>Retry comments</Button>
    </div> : comments.length === 0 ? <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-8 text-sm text-muted-foreground">
      <MessageSquare className="size-5" /><p>No comments yet.</p>
    </div> : <ol className="flex min-w-0 flex-col gap-3" aria-label="Comments">
      {comments.map(comment => {
        if (comment.type !== 'content') return <li key={comment.id} className="flex gap-2 text-sm text-muted-foreground">
          <Activity className="mt-1 size-4 shrink-0" /><span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
            {comment.author && <span className="font-medium">{comment.author.name} </span>}{comment.content}
            <time dateTime={comment.createdAt}> · {timeAgo(comment.createdAt)}</time>
          </span>
        </li>;
        const own = Boolean(session?.user?.id) && comment.author?.id === session?.user?.id;
        const isEditing = editing?.id === comment.id && canWrite;
        return <li key={comment.id} className="flex min-w-0 gap-3" data-testid="comment-item">
          <UserAvatar user={comment.author} />
          <div className="min-w-0 flex-1 rounded-lg border bg-card px-3 py-2">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              <span className="font-medium [overflow-wrap:anywhere]">{comment.author?.name ?? 'Unknown user'}</span>
              <time dateTime={comment.createdAt} className="text-muted-foreground">{timeAgo(comment.createdAt)}
                {new Date(comment.updatedAt).getTime() - new Date(comment.createdAt).getTime() > 1000 ? ' · edited' : ''}</time>
              {canWrite && <div className="ml-auto flex shrink-0 items-center gap-1">
                <Button variant="ghost" size="icon" className="size-7" aria-label="Reply" disabled={locked}
                  onClick={() => setReplyTo(comment)}><Reply className="size-3.5" /></Button>
                {own && comment.isCanEdit && !isEditing && <Button variant="ghost" size="icon" className="size-7" aria-label="Edit comment" disabled={locked}
                  onClick={() => { setEditing(comment); setEditDraft(comment.content); }}><Pencil className="size-3.5" /></Button>}
                {own && comment.isCanDelete && <Button variant="ghost" size="icon" className="size-7" aria-label="Delete comment" disabled={locked}
                  onClick={event => { dialogTriggerRef.current = event.currentTarget; setDeleting(comment); }}><Trash2 className="size-3.5" /></Button>}
              </div>}
            </div>
            {comment.repComment && <blockquote className="mt-2 border-l-2 pl-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">
              {comment.repComment.deleted ? <em>Original comment deleted</em>
                : <><span className="font-medium">{comment.repComment.author?.name ?? 'Unknown user'}: </span>{comment.repComment.snippet}</>}
            </blockquote>}
            {isEditing ? <div className="mt-2 space-y-2">
              <Textarea aria-label="Edit comment text" value={editDraft} maxLength={MAX_LENGTH} rows={3} disabled={write.busy}
                onChange={event => setEditDraft(event.target.value)} />
              <div className="flex justify-end gap-2"><Button size="sm" variant="ghost" disabled={write.busy} onClick={() => setEditing(null)}>Cancel edit</Button>
                <Button size="sm" disabled={locked || !editDraft.trim() || editDraft.length > MAX_LENGTH}
                  onClick={() => void write.run({ type: 'edit', id: comment.id, content: editDraft.trim() })}>Save comment</Button></div>
            </div> : <p className="mt-1 whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{comment.content}</p>}
          </div>
        </li>;
      })}
    </ol>}
    {ready && query.hasNextPage && <Button variant="outline" size="sm" className="self-center" disabled={query.isFetching}
      onClick={() => void query.fetchNextPage()}>Load more comments</Button>}
    {write.error && <div role="alert" className="space-y-2 text-sm"><p>{write.error}</p>
      {write.uncertain && <Button variant="outline" size="sm" disabled={write.busy}
        onClick={() => void write.checkSaved(reload)}>Check saved comments</Button>}
      {write.uncertain && write.reviewed && <Button variant="outline" size="sm" disabled={write.busy}
        onClick={event => { dialogTriggerRef.current = event.currentTarget; setDiscarding(true); }}>Discard uncertain submission</Button>}
    </div>}
    {canWrite ? <div className="flex min-w-0 flex-col gap-2">
      {replyTo && <div className="flex items-center gap-2 rounded-md bg-muted px-2 py-1 text-xs">
        <Reply className="size-4 shrink-0" /><span className="min-w-0 flex-1 truncate">Replying to {replyTo.author?.name ?? 'comment'}: {replyTo.content}</span>
        <Button variant="ghost" size="icon" className="size-7" aria-label="Cancel reply" onClick={() => setReplyTo(null)} disabled={write.busy}><X className="size-3" /></Button>
      </div>}
      <Textarea aria-label="Comment" placeholder="Write a comment…" rows={3} value={draft} maxLength={MAX_LENGTH} disabled={locked}
        onChange={event => setDraft(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit(); } }} />
      <div className="flex justify-end"><Button size="sm" disabled={locked || !draft.trim() || draft.length > MAX_LENGTH} onClick={submit}>Comment</Button></div>
    </div> : <p className="text-sm text-muted-foreground">Read-only discussion.</p>}
    <ConfirmDialog open={Boolean(deleting) && canWrite} onOpenChange={open => { if (!open) setDeleting(null); }} title="Delete comment?"
      description="The comment is removed from the thread. Replies remain with a deleted-parent marker." confirmText="Delete"
      onCloseAutoFocus={restoreDialogFocus}
      disabled={locked} focusCancel onConfirm={() => { if (deleting && !locked) void write.run({ type: 'delete', id: deleting.id }); }} />
    <ConfirmDialog open={discarding} onOpenChange={setDiscarding} title="Discard uncertain submission?"
      onCloseAutoFocus={restoreDialogFocus}
      description="The request may already have succeeded, including on a later page. Review saved comments before starting again. This clears the submitted draft locally and never sends it again."
      confirmText="Discard submission" disabled={write.busy} focusCancel onConfirm={write.discard} />
  </div>;
}
