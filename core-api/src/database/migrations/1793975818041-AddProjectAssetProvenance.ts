import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProjectAssetProvenance1793975818041 implements MigrationInterface {
  name = 'AddProjectAssetProvenance1793975818041';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "project_assets" ADD "source" character varying NOT NULL DEFAULT 'manual'`,
    );
    await queryRunner.query(
      `ALTER TABLE "project_assets" ADD "scopeRuleId" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "project_assets" ADD CONSTRAINT "FK_ae4b4f0cb8271702a3fbec5d9c8" FOREIGN KEY ("scopeRuleId") REFERENCES "project_scope_rules"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "project_assets" DROP CONSTRAINT "FK_ae4b4f0cb8271702a3fbec5d9c8"`,
    );
    await queryRunner.query(
      `ALTER TABLE "project_assets" DROP COLUMN "scopeRuleId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "project_assets" DROP COLUMN "source"`,
    );
  }
}
