import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import type { JobHistoryDetailResponseDto } from '@/services/apis/gen/queries';

type RunProgressProps = Partial<
  Pick<
    JobHistoryDetailResponseDto,
    'steps' | 'tools' | 'activeJobsCount' | 'etaSeconds'
  >
>;

function formatEta(seconds: number): string {
  if (seconds === 0) return 'Less than 1 sec left';
  if (seconds < 60) return `About ${seconds} sec left`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60
    ? `About ${minutes} min left`
    : `About ${Math.floor(minutes / 60)} hr ${minutes % 60} min left`;
}

/** Shows settled steps using the run detail already loaded for the graph. */
export function RunProgress({
  steps = [],
  tools = [],
  activeJobsCount = 0,
  etaSeconds,
}: RunProgressProps) {
  const hasSteps = steps.length > 0;
  const total = hasSteps ? steps.length : tools.length;
  if (total === 0) return null;

  const settled = hasSteps
    ? steps.filter(
        ({ status }) =>
          status === 'done' || status === 'failed' || status === 'skipped',
      ).length
    : tools.filter(
        ({ status }) =>
          status === 'completed' ||
          status === 'failed' ||
          status === 'cancelled' ||
          status === 'skipped',
      ).length;
  const noun = hasSteps ? 'workflow step' : 'tool';
  const unit = total === 1 ? noun : `${noun}s`;
  const progress = Math.min(
    settled === total ? 100 : 99,
    Math.round((settled / total) * 100),
  );

  return (
    <Card className="mb-4 py-2">
      <CardContent className="space-y-2 px-2 py-2 md:px-4">
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">
              {settled}/{total} {unit} settled
            </span>
            <span className="tabular-nums text-muted-foreground">
              {progress}%
            </span>
            {activeJobsCount > 0 && etaSeconds != null && (
              <span className="text-xs text-muted-foreground">
                {formatEta(etaSeconds)}
              </span>
            )}
          </div>
          {activeJobsCount > 0 && (
            <span className="text-xs text-muted-foreground">
              {activeJobsCount} active {activeJobsCount === 1 ? 'job' : 'jobs'}
            </span>
          )}
        </div>
        <Progress
          value={progress}
          aria-label="Run progress"
          aria-valuenow={progress}
          aria-valuetext={`${settled} of ${total} ${unit} settled`}
        />
      </CardContent>
    </Card>
  );
}
