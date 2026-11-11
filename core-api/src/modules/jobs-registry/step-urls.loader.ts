import type { DataSource } from 'typeorm';
import { isScopedHttpUrl, type ScopeAsset, type ScopeUrl } from './step-inputs';

export const URL_INPUTS_PER_HOST = 50;
export const URL_INPUT_PAGE_SIZE = 250;

interface Candidate extends ScopeUrl {
  cursorId: string;
  cursorCreatedAt: string;
}

/** Reads bounded pages until each host has its newest eligible URL inputs. */
export async function loadScopedUrls(
  source: DataSource,
  assets: readonly Pick<ScopeAsset, 'id' | 'value'>[],
  serviceIds: string[] = [],
): Promise<ScopeUrl[]> {
  const urls: ScopeUrl[] = [];
  for (const asset of assets) {
    let cursor: Candidate | undefined;
    let accepted = 0;
    while (accepted < URL_INPUTS_PER_HOST) {
      const params: unknown[] = [asset.id, serviceIds, URL_INPUT_PAGE_SIZE];
      const after = cursor
        ? 'AND (du."createdAt", du.id) < ($4::timestamp, $5::uuid)'
        : '';
      if (cursor) params.push(cursor.cursorCreatedAt, cursor.cursorId);
      const rows = await source.query<Candidate[]>(
        `SELECT du.url, s."assetId", s.id AS "serviceId", du.id AS "cursorId",
                du."createdAt"::text AS "cursorCreatedAt"
           FROM discovered_urls du JOIN asset_services s ON s.id = du."assetServiceId"
          WHERE s."assetId"::text = $1
            AND (cardinality($2::text[]) = 0 OR s.id::text = ANY($2::text[]))
            ${after}
          ORDER BY du."createdAt" DESC, du.id DESC LIMIT $3`,
        params,
      );
      for (const row of rows) {
        if (!isScopedHttpUrl(row.url, asset.value)) continue;
        urls.push({
          url: row.url,
          assetId: row.assetId,
          serviceId: row.serviceId,
        });
        if (++accepted === URL_INPUTS_PER_HOST) break;
      }
      if (rows.length < URL_INPUT_PAGE_SIZE || accepted === URL_INPUTS_PER_HOST)
        break;
      // Text retains PostgreSQL's microseconds; a JS Date would skip close rows.
      cursor = rows[rows.length - 1];
    }
  }
  return urls;
}
