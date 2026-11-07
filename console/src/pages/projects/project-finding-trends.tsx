import type { ProjectOverviewWeekDto } from '@/services/apis/gen/queries';

const severities = [
  { key: 'critical', label: 'Critical', color: 'bg-red-500' },
  { key: 'high', label: 'High', color: 'bg-orange-500' },
  { key: 'medium', label: 'Medium', color: 'bg-yellow-500' },
  { key: 'low', label: 'Low', color: 'bg-blue-500' },
  { key: 'info', label: 'Info', color: 'bg-gray-500' },
] as const;
const shortDate = new Intl.DateTimeFormat(undefined, {
  month: 'numeric',
  day: 'numeric',
  timeZone: 'UTC',
});
const longDate = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeZone: 'UTC',
});
const countFormat = new Intl.NumberFormat();

/** Shows the eight UTC week buckets and exposes exact counts as a table. */
export function ProjectFindingTrends({
  weeks,
}: {
  weeks: ProjectOverviewWeekDto[];
}) {
  const totals = weeks.map((week) =>
    severities.reduce((sum, { key }) => sum + week[key], 0),
  );
  const max = Math.max(0, ...totals);

  return (
    <section
      aria-labelledby="project-finding-trends-heading"
      className="min-w-0 space-y-4 rounded-xl border bg-card p-4 text-card-foreground"
    >
      <div>
        <h2
          id="project-finding-trends-heading"
          className="text-base font-semibold"
        >
          New findings by week
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Eight weeks, starting on Monday in UTC.
        </p>
      </div>
      {max === 0 ? (
        <p className="text-sm text-muted-foreground">
          No new findings in these eight weeks.
        </p>
      ) : (
        <div aria-hidden="true" className="space-y-3">
          <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {severities.map(({ key, label, color }) => (
              <li key={key} className="flex items-center gap-1.5">
                <span className={`size-2.5 rounded-sm ${color}`} />
                {label}
              </li>
            ))}
          </ul>
          <div className="grid grid-cols-8 gap-1 sm:gap-2">
            {weeks.map((week, index) => (
              <div key={week.week} className="min-w-0 text-center">
                <div className="flex h-28 items-end justify-center border-b sm:h-36">
                  <div
                    className="flex w-full max-w-8 flex-col-reverse overflow-hidden rounded-t-sm"
                    style={{ height: `${(totals[index] / max) * 100}%` }}
                  >
                    {severities.map(
                      ({ key, color }) =>
                        week[key] > 0 && (
                          <span
                            key={key}
                            className={`basis-0 ${color}`}
                            style={{ flexGrow: week[key] }}
                          />
                        ),
                    )}
                  </div>
                </div>
                <time
                  dateTime={week.week}
                  className="mt-1 block text-[10px] tabular-nums text-muted-foreground sm:text-xs"
                >
                  {shortDate.format(new Date(week.week))}
                </time>
              </div>
            ))}
          </div>
        </div>
      )}
      {weeks.length > 0 && (
        <details>
          <summary className="w-fit cursor-pointer rounded-sm text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
            View weekly counts
          </summary>
          <div
            className="mt-2 overflow-x-auto"
            role="region"
            aria-label="Weekly counts table"
            tabIndex={0}
          >
            <table className="w-full text-right text-xs whitespace-nowrap tabular-nums sm:text-sm">
              <caption className="sr-only">
                New findings by week and severity
              </caption>
              <thead>
                <tr className="border-b text-[10px] text-muted-foreground sm:text-xs">
                  <th scope="col" className="py-2 pr-2 text-left">
                    Week of
                  </th>
                  {severities.map(({ key, label }) => (
                    <th key={key} scope="col" className="px-1 py-2">
                      {label}
                    </th>
                  ))}
                  <th scope="col" className="py-2 pl-1">
                    Total
                  </th>
                </tr>
              </thead>
              <tbody>
                {weeks.map((week, index) => (
                  <tr key={week.week} className="border-b last:border-b-0">
                    <th scope="row" className="py-2 pr-2 text-left font-normal">
                      <time dateTime={week.week}>
                        {longDate.format(new Date(week.week))}
                      </time>
                    </th>
                    {severities.map(({ key }) => (
                      <td key={key} className="px-1 py-2">
                        {countFormat.format(week[key])}
                      </td>
                    ))}
                    <td className="py-2 pl-1 font-medium">
                      {countFormat.format(totals[index])}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}
