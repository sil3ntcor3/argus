import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFindingScannerSources1794254883974 implements MigrationInterface {
  name = 'AddFindingScannerSources1794254883974';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "vulnerability_sources" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "vulnerabilityId" uuid NOT NULL, "kind" character varying NOT NULL, "toolId" uuid, "jobHistoryId" uuid, CONSTRAINT "UQ_vuln_source_finding_kind_run" UNIQUE ("vulnerabilityId", "kind", "jobHistoryId"), CONSTRAINT "PK_e429138cfe9a03406ba73a613b8" PRIMARY KEY ("id"))`);
    await queryRunner.query(`CREATE INDEX "IDX_vuln_source_run" ON "vulnerability_sources" ("jobHistoryId") `);
    await queryRunner.query(`ALTER TABLE "vulnerability_sources" ADD CONSTRAINT "FK_686e47977fe16591f5949aefafb" FOREIGN KEY ("vulnerabilityId") REFERENCES "vulnerabilities"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    await queryRunner.query(`ALTER TABLE "vulnerability_sources" ADD CONSTRAINT "FK_2ffaff92f3f49626c8bfb1317bb" FOREIGN KEY ("toolId") REFERENCES "tools"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    await queryRunner.query(`ALTER TABLE "vulnerability_sources" ADD CONSTRAINT "FK_df4104fbefc793f1a4feb3707b9" FOREIGN KEY ("jobHistoryId") REFERENCES "job_histories"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);

    // Keep the scanner attribution, but attach a run only when the finding
    // and the run's workflow resolve to the same workspace.
    await queryRunner.query(`
      INSERT INTO "vulnerability_sources"
        ("vulnerabilityId", "kind", "toolId", "jobHistoryId", "createdAt")
      SELECT finding.id,
             'tool',
             tool.id,
             CASE WHEN workflow."workspaceId" = target."workspaceId" THEN history.id END,
             finding."createdAt"
      FROM "vulnerabilities" finding
      INNER JOIN "tools" tool ON tool.id = finding."toolId"
      LEFT JOIN "assets" asset ON asset.id = finding."assetId"
      LEFT JOIN "targets" target ON target.id = asset."targetId"
      LEFT JOIN "job_histories" history ON history.id = finding."jobHistoryId"
      LEFT JOIN "workflows" workflow ON workflow.id = history."workflowId"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vulnerability_sources" DROP CONSTRAINT "FK_df4104fbefc793f1a4feb3707b9"`);
    await queryRunner.query(`ALTER TABLE "vulnerability_sources" DROP CONSTRAINT "FK_2ffaff92f3f49626c8bfb1317bb"`);
    await queryRunner.query(`ALTER TABLE "vulnerability_sources" DROP CONSTRAINT "FK_686e47977fe16591f5949aefafb"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_vuln_source_run"`);
    await queryRunner.query(`DROP TABLE "vulnerability_sources"`);
  }
}
