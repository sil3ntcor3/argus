import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFindingDetectionLifecycle1794250845874 implements MigrationInterface {
  name = 'AddFindingDetectionLifecycle1794250845874';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vulnerabilities" ADD "detectionStatus" character varying NOT NULL DEFAULT 'new'`);
    await queryRunner.query(`ALTER TABLE "vulnerabilities" ADD "timesDetected" integer NOT NULL DEFAULT '1'`);
    await queryRunner.query(`ALTER TABLE "vulnerabilities" ADD "resurfacedCount" integer NOT NULL DEFAULT '0'`);
    await queryRunner.query(`ALTER TABLE "vulnerabilities" ADD "missedScans" integer NOT NULL DEFAULT '0'`);
    await queryRunner.query(`ALTER TABLE "vulnerabilities" ADD "scanScopeKey" character varying`);
    await queryRunner.query(`ALTER TABLE "vulnerabilities" ADD "fixedAt" TIMESTAMP WITH TIME ZONE`);

    // Projects can share a finding. The largest recorded count is a lower
    // bound that avoids double-counting a run observed through several links.
    // Legacy updatedAt can reflect rescans, so leave fixedAt unknown.
    await queryRunner.query(`
      WITH project_detections AS (
        SELECT "vulnerabilityId", MAX("timesSeen") AS count
        FROM "project_vulnerabilities"
        WHERE "timesSeen" > 1
        GROUP BY "vulnerabilityId"
      )
      UPDATE "vulnerabilities" v
      SET "timesDetected" = COALESCE(p.count, 1),
          "detectionStatus" = CASE WHEN v."isArchived" THEN 'fixed' ELSE 'active' END
      FROM "vulnerabilities" previous
      LEFT JOIN project_detections p ON p."vulnerabilityId" = previous.id
      WHERE v.id = previous.id
        AND (
          previous."isArchived"
          OR p.count IS NOT NULL
          OR previous."lastSeenDate" > previous."firstDetectedDate"
        )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vulnerabilities" DROP COLUMN "fixedAt"`);
    await queryRunner.query(`ALTER TABLE "vulnerabilities" DROP COLUMN "scanScopeKey"`);
    await queryRunner.query(`ALTER TABLE "vulnerabilities" DROP COLUMN "missedScans"`);
    await queryRunner.query(`ALTER TABLE "vulnerabilities" DROP COLUMN "resurfacedCount"`);
    await queryRunner.query(`ALTER TABLE "vulnerabilities" DROP COLUMN "timesDetected"`);
    await queryRunner.query(`ALTER TABLE "vulnerabilities" DROP COLUMN "detectionStatus"`);
  }
}
