import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { differenceInCalendarDays } from 'date-fns';
import { DETECTION_LABELS } from './lifecycle';

const tones: Record<string, string> = {
  new: 'text-primary', active: 'text-cyan-700 dark:text-cyan-300',
  fixed: 'text-green-700 dark:text-green-300', resurfaced: 'text-pink-700 dark:text-pink-300',
};
export function DetectionStatusBadge({ status }: { status?: string }) {
  const recognized = status && DETECTION_LABELS[status] ? status : 'new';
  return <Badge variant="outline" className={tones[recognized]}>{DETECTION_LABELS[recognized]}</Badge>;
}
export function SlaDue({ dueAt, status, paused = false }: { dueAt?: string | null; status?: string; paused?: boolean }) {
  if (status === 'fixed') return <span className="text-muted-foreground">—</span>;
  if (paused) return <span className="text-xs text-muted-foreground">Paused</span>;
  const due = dueAt ? new Date(dueAt) : null;
  if (!due || !Number.isFinite(due.getTime())) return <span className="text-muted-foreground">No SLA</span>;
  const now = new Date();
  const days = differenceInCalendarDays(due, now);
  const overdue = due < now;
  const label = days < 0 ? `${-days} day${days === -1 ? '' : 's'} overdue`
    : days === 0 ? overdue ? 'Overdue today' : 'Due today' : `Due in ${days} day${days === 1 ? '' : 's'}`;
  return <time dateTime={dueAt!} title={due.toLocaleString()}
    className={cn('text-xs', overdue ? 'font-medium text-destructive' : 'text-muted-foreground')}>{label}</time>;
}
