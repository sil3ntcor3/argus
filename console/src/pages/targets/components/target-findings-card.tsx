import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import type { SeverityCountsDto } from '@/services/apis/gen/queries';
import { Link } from '@tanstack/react-router';

const severities = ['critical', 'high', 'medium', 'low', 'info'] as const;
const formatCount = new Intl.NumberFormat();

/** Summarizes open findings and links to the selected target's findings list. */
export function TargetFindingsCard({
  targetId,
  counts,
  newCount,
  onKeyboardNavigate,
}: {
  targetId: string;
  counts: SeverityCountsDto;
  newCount: number;
  onKeyboardNavigate: () => void;
}) {
  const total = severities.reduce((sum, severity) => sum + counts[severity], 0);
  return (
    <section aria-label="Open vulnerabilities">
      <Card className="gap-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Open vulnerabilities</h2>
            <p className="text-2xl font-semibold tabular-nums">
              {formatCount.format(total)}
            </p>
            <p className="text-sm text-muted-foreground">
              {formatCount.format(newCount)} new in the last 7 days
            </p>
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link
              to="/targets/$id/$tab"
              params={{ id: targetId, tab: 'vulnerabilities' }}
              onClick={(event) => {
                if (
                  event.detail === 0 &&
                  !event.defaultPrevented &&
                  !event.altKey &&
                  !event.ctrlKey &&
                  !event.metaKey &&
                  !event.shiftKey
                ) {
                  onKeyboardNavigate();
                }
              }}
            >
              See vulnerabilities
            </Link>
          </Button>
        </div>
        <dl className="flex flex-wrap gap-x-4 gap-y-2">
          {severities.map((severity) => (
            <div key={severity} className="flex items-center gap-2">
              <dt className="text-sm capitalize">{severity}</dt>
              <dd className="text-sm font-medium tabular-nums">
                {formatCount.format(counts[severity])}
              </dd>
            </div>
          ))}
        </dl>
      </Card>
    </section>
  );
}
