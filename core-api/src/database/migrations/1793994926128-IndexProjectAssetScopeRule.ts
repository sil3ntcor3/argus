import { MigrationInterface, QueryRunner } from 'typeorm';

export class IndexProjectAssetScopeRule1793994926128 implements MigrationInterface {
  name = 'IndexProjectAssetScopeRule1793994926128';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "IDX_pa_scopeRuleId" ON "project_assets" ("scopeRuleId") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_pa_scopeRuleId"`);
  }
}
