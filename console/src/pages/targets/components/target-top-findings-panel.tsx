import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import type { TargetTopVulnerabilityDto } from '@/services/apis/gen/queries';
import { Link } from '@tanstack/react-router';

/** Shows the ranked open findings in the order provided by Overview. */
export function TargetTopFindingsPanel({
  findings,
}: {
  findings: TargetTopVulnerabilityDto[];
}) {
  return (
    <section aria-label="Top findings">
      <Card className="gap-2 p-4">
        <h2 className="text-base font-semibold">Top findings</h2>
        {findings.length ? (
          <ul role="list" className="divide-y">
            {findings.map((finding) => (
              <li key={finding.id}>
                <Link
                  to="/vulnerabilities/$id"
                  params={{ id: finding.id }}
                  className="flex flex-col gap-1 rounded-sm p-2 hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium break-all">
                      {finding.name}
                    </span>
                    <Badge variant="outline" className="capitalize">
                      {finding.severity}
                    </Badge>
                  </span>
                  <span className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                    <span className="break-all">{finding.assetValue}</span>
                    {finding.cveId?.[0] && (
                      <span className="break-all">{finding.cveId[0]}</span>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No findings to preview.</p>
        )}
      </Card>
    </section>
  );
}
