import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import type { TargetInsightDto } from '@/services/apis/gen/queries';
import { Link } from '@tanstack/react-router';

const actions: Partial<
  Record<
    TargetInsightDto['kind'],
    { tab: 'assets' | 'settings'; label: string }
  >
> = {
  stale_scan: { tab: 'settings', label: 'Open discovery settings' },
  new_assets: { tab: 'assets', label: 'See assets' },
  no_schedule: { tab: 'settings', label: 'Configure schedule' },
};
const formatCount = new Intl.NumberFormat();

/** Describes the discovery record without assuming a successful scan. */
function describeInsight({ kind, count, days }: TargetInsightDto) {
  switch (kind) {
    case 'stale_scan':
      return days === undefined
        ? 'No discovery date recorded.'
        : `The recorded discovery date is ${formatCount.format(days)} days old.`;
    case 'new_assets': {
      if (count === undefined) return 'New assets discovered.';
      const assets = `${formatCount.format(count)} new ${count === 1 ? 'asset' : 'assets'}`;
      return days === undefined
        ? `${assets} discovered.`
        : `${assets} in the last ${formatCount.format(days)} days.`;
    }
    case 'no_schedule':
      return 'No discovery schedule.';
    default:
      return undefined;
  }
}

/** Shows discovery insights and links to existing, permission-gated controls. */
export function TargetInsightsPanel({
  insights,
  targetId,
  canManageDiscovery,
  onKeyboardNavigate,
}: {
  insights: TargetInsightDto[];
  targetId: string;
  canManageDiscovery: boolean;
  onKeyboardNavigate: (tab: 'assets' | 'settings') => void;
}) {
  const rows = insights.flatMap((insight) => {
    const description = describeInsight(insight);
    const action = actions[insight.kind];
    return description && action ? [{ insight, description, action }] : [];
  });
  if (!rows.length) return null;

  return (
    <section aria-label="Discovery insights">
      <Card className="gap-3 p-4">
        <h2 className="text-base font-semibold">Discovery insights</h2>
        <ul role="list" className="divide-y">
          {rows.map(({ insight, description, action }) => (
            <li
              key={insight.kind}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
                {insight.level === 'warning' && (
                  <Badge variant="outline">Warning</Badge>
                )}
                <p>{description}</p>
              </div>
              {(action.tab === 'assets' || canManageDiscovery) && (
                <Button variant="outline" size="sm" asChild>
                  <Link
                    to="/targets/$id/$tab"
                    params={{ id: targetId, tab: action.tab }}
                    onClick={(event) => {
                      if (
                        event.detail === 0 &&
                        !event.defaultPrevented &&
                        !event.altKey &&
                        !event.ctrlKey &&
                        !event.metaKey &&
                        !event.shiftKey
                      ) {
                        onKeyboardNavigate(action.tab);
                      }
                    }}
                  >
                    {action.label}
                  </Link>
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}
