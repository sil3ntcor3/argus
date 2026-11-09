import { Card } from '@/components/ui/card';
import type { TargetExposureDto } from '@/services/apis/gen/queries';

const groups = [
  { key: 'ports', title: 'Ports', empty: 'No ports discovered.' },
  {
    key: 'technologies',
    title: 'Technologies',
    empty: 'No technologies detected.',
  },
  {
    key: 'statusCodes',
    title: 'Primary HTTP status codes',
    empty: 'No HTTP status codes recorded.',
  },
] as const;
const formatCount = new Intl.NumberFormat();

/** Displays the most frequently observed service exposures for the target. */
export function TargetExposurePanel({
  exposure,
}: {
  exposure: TargetExposureDto;
}) {
  return (
    <section aria-label="Target exposure" className="space-y-3">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">Exposure</h2>
        <p className="text-sm text-muted-foreground">
          Top six in each group by service count.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {groups.map(({ key, title, empty }) => {
          const entries = exposure[key];
          const highest = entries[0]?.count ?? 1;
          return (
            <Card key={key} className="min-w-0 gap-3 p-4">
              <h3 className="text-sm font-semibold">{title}</h3>
              {entries.length ? (
                <ul role="list" aria-label={title} className="space-y-3">
                  {entries.map(({ name, count }) => (
                    <li key={name} className="space-y-1.5">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 text-sm">
                        <span className="min-w-0 break-words">{name}</span>
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {formatCount.format(count)}{' '}
                          {count === 1 ? 'service' : 'services'}
                        </span>
                      </div>
                      <div aria-hidden className="h-1 rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary"
                          style={{ width: `${(100 * count) / highest}%` }}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">{empty}</p>
              )}
            </Card>
          );
        })}
      </div>
    </section>
  );
}
