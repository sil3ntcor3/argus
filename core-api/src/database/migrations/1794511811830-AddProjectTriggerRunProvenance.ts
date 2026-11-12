import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProjectTriggerRunProvenance1794511811830 implements MigrationInterface {
  name = 'AddProjectTriggerRunProvenance1794511811830';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "job_histories" ADD "triggerId" uuid`);
    await queryRunner.query(
      `ALTER TABLE "job_histories" ADD "causedByRunId" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "job_histories" ADD "chainDepth" integer NOT NULL DEFAULT '0'`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_job_histories_causedByRunId" ON "job_histories" ("causedByRunId") `,
    );
    await queryRunner.query(
      `ALTER TABLE "job_histories" ADD CONSTRAINT "FK_2a60e270a2ff0703122b74d4497" FOREIGN KEY ("triggerId") REFERENCES "project_workflow_triggers"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "job_histories" ADD CONSTRAINT "FK_a1aed19786717aa1c4d4fcfb7b7" FOREIGN KEY ("causedByRunId") REFERENCES "job_histories"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "job_histories" DROP CONSTRAINT "FK_a1aed19786717aa1c4d4fcfb7b7"`,
    );
    await queryRunner.query(
      `ALTER TABLE "job_histories" DROP CONSTRAINT "FK_2a60e270a2ff0703122b74d4497"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_job_histories_causedByRunId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "job_histories" DROP COLUMN "chainDepth"`,
    );
    await queryRunner.query(
      `ALTER TABLE "job_histories" DROP COLUMN "causedByRunId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "job_histories" DROP COLUMN "triggerId"`,
    );
  }
}
