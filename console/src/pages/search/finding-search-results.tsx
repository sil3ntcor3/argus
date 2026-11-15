import { SeverityBadge } from '@/components/ui/severity-badge';
import type { FindingSearchResultDto } from '@/services/apis/gen/queries';
import { Link } from '@tanstack/react-router';

/** A bounded preview is not a paginated total of all matching findings. */
export function FindingSearchResults({
  findings,
}: {
  findings: FindingSearchResultDto[];
}) {
  return (
    <section
      aria-label="Finding previews"
      className="min-w-0 overflow-hidden rounded-lg border"
    >
      <h2 className="border-b px-4 py-3 font-medium sm:px-6">
        Findings · up to 5 newest matches
      </h2>
      <ul className="divide-y">
        {findings.slice(0, 5).map((finding) => (
          <li key={finding.id}>
            <Link
              to="/vulnerabilities/$id"
              params={{ id: finding.id }}
              className="flex min-w-0 flex-wrap items-center gap-3 px-4 py-3 hover:bg-muted focus-visible:bg-muted sm:px-6"
            >
              <SeverityBadge severity={finding.severity} />
              <span className="min-w-0 flex-1 basis-40">
                <span className="block break-words font-medium">
                  {finding.name}
                </span>
                <span className="block break-all text-sm text-muted-foreground">
                  {finding.affectedUrl || finding.asset.value}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
