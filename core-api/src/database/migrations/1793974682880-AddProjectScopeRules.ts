import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProjectScopeRules1793974682880 implements MigrationInterface {
  name = 'AddProjectScopeRules1793974682880';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "project_scope_rules" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "projectId" uuid NOT NULL, "mode" character varying NOT NULL, "type" character varying NOT NULL, "value" character varying NOT NULL, CONSTRAINT "PK_8efa422646a6773472c7ccdea5a" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_psr_projectId" ON "project_scope_rules" ("projectId") `,
    );
    await queryRunner.query(
      `ALTER TABLE "project_scope_rules" ADD CONSTRAINT "FK_3d246c67d24df308b642d23c0cf" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "project_scope_rules" DROP CONSTRAINT "FK_3d246c67d24df308b642d23c0cf"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_psr_projectId"`);
    await queryRunner.query(`DROP TABLE "project_scope_rules"`);
  }
}
