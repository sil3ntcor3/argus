import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFindingLifecycleEvents1794255863304 implements MigrationInterface {
  name = 'AddFindingLifecycleEvents1794255863304';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "vulnerability_events" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "vulnerabilityId" uuid NOT NULL, "workspaceId" uuid NOT NULL, "type" character varying NOT NULL, "fromStatus" character varying, "toStatus" character varying, "jobHistoryId" uuid, "actorId" uuid, "data" jsonb, "occurredAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_97f37f078a5b8ac1fc618041feb" PRIMARY KEY ("id"))`);
    await queryRunner.query(`CREATE INDEX "IDX_vuln_event_run" ON "vulnerability_events" ("jobHistoryId") `);
    await queryRunner.query(`CREATE INDEX "IDX_vuln_event_workspace_time" ON "vulnerability_events" ("workspaceId", "occurredAt") `);
    await queryRunner.query(`CREATE INDEX "IDX_vuln_event_finding_time" ON "vulnerability_events" ("vulnerabilityId", "occurredAt") `);
    await queryRunner.query(`ALTER TABLE "vulnerability_events" ADD CONSTRAINT "FK_41a254c3510e9d55364248640f2" FOREIGN KEY ("vulnerabilityId") REFERENCES "vulnerabilities"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    await queryRunner.query(`ALTER TABLE "vulnerability_events" ADD CONSTRAINT "FK_096c8946d10e796fce4e4919385" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    await queryRunner.query(`ALTER TABLE "vulnerability_events" ADD CONSTRAINT "FK_f1a18d749dd5b122e46034ea2bd" FOREIGN KEY ("jobHistoryId") REFERENCES "job_histories"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    await queryRunner.query(`ALTER TABLE "vulnerability_events" ADD CONSTRAINT "FK_caebeb14d1fd9f057980a3c5b05" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);

    // A known first detection can seed the timeline. Historical state
    // changes have no reliable timestamp, so leave them unrecorded.
    await queryRunner.query(`
      INSERT INTO "vulnerability_events"
        ("vulnerabilityId", "workspaceId", "type", "toStatus", "jobHistoryId", "occurredAt")
      SELECT finding.id,
             workspace.id,
             'detected',
             'new',
             CASE WHEN workflow."workspaceId" = workspace.id THEN history.id END,
             finding."firstDetectedDate"
      FROM "vulnerabilities" finding
      INNER JOIN "assets" asset ON asset.id = finding."assetId"
      INNER JOIN "targets" target ON target.id = asset."targetId"
      INNER JOIN "workspaces" workspace ON workspace.id = target."workspaceId"
      LEFT JOIN "job_histories" history ON history.id = finding."jobHistoryId"
      LEFT JOIN "workflows" workflow ON workflow.id = history."workflowId"
      WHERE finding."firstDetectedDate" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vulnerability_events" DROP CONSTRAINT "FK_caebeb14d1fd9f057980a3c5b05"`);
    await queryRunner.query(`ALTER TABLE "vulnerability_events" DROP CONSTRAINT "FK_f1a18d749dd5b122e46034ea2bd"`);
    await queryRunner.query(`ALTER TABLE "vulnerability_events" DROP CONSTRAINT "FK_096c8946d10e796fce4e4919385"`);
    await queryRunner.query(`ALTER TABLE "vulnerability_events" DROP CONSTRAINT "FK_41a254c3510e9d55364248640f2"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_vuln_event_finding_time"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_vuln_event_workspace_time"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_vuln_event_run"`);
    await queryRunner.query(`DROP TABLE "vulnerability_events"`);
  }
}
