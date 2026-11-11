import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProjectWorkflowTriggers1794429588085 implements MigrationInterface {
  name = 'AddProjectWorkflowTriggers1794429588085';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "project_workflow_triggers" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "projectWorkflowId" uuid NOT NULL, "type" character varying NOT NULL, "cron" character varying, "event" character varying, "config" jsonb NOT NULL DEFAULT '{}', "enabled" boolean NOT NULL DEFAULT true, "lastFiredAt" TIMESTAMP WITH TIME ZONE, "schedulerId" character varying, CONSTRAINT "PK_ae68fd543e8610ed1825e573d37" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_pwt_projectWorkflowId" ON "project_workflow_triggers" ("projectWorkflowId") `,
    );
    await queryRunner.query(
      `ALTER TABLE "project_workflow_triggers" ADD CONSTRAINT "FK_c60ef6ae846fec137f4cedca24e" FOREIGN KEY ("projectWorkflowId") REFERENCES "project_workflows"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "project_workflow_triggers" DROP CONSTRAINT "FK_c60ef6ae846fec137f4cedca24e"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_pwt_projectWorkflowId"`);
    await queryRunner.query(`DROP TABLE "project_workflow_triggers"`);
  }
}
