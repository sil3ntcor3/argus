import { Card } from '@/components/ui/card';
import type { TargetProjectRefDto } from '@/services/apis/gen/queries';
import { Link } from '@tanstack/react-router';
import { useId } from 'react';

const formatCount = new Intl.NumberFormat();

/** Links to the highest-ranked projects that contain this target's assets. */
export function TargetProjectsPanel({
  projects,
}: {
  projects: TargetProjectRefDto[];
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="min-w-0">
      <Card className="gap-2 p-4">
        <h2 id={headingId} className="text-base font-semibold">
          Projects containing target assets
        </h2>
        {projects.length > 0 ? (
          <ul role="list" className="divide-y">
            {projects.map(({ id, name, hexColor, assets }) => (
              <li key={id}>
                <Link
                  to="/projects/$id"
                  params={{ id }}
                  className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-sm p-2 hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    {hexColor && (
                      <span
                        aria-hidden="true"
                        className="size-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: hexColor }}
                      />
                    )}
                    <span className="min-w-0 break-words text-sm font-medium">
                      {name}
                    </span>
                  </span>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {formatCount.format(assets)} target{' '}
                    {assets === 1 ? 'asset' : 'assets'}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            No projects contain assets from this target.
          </p>
        )}
      </Card>
    </section>
  );
}
