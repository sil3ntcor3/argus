import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProjectAssetUniqueness1793977167934 implements MigrationInterface {
  name = 'AddProjectAssetUniqueness1793977167934';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_pa_projectId_assetId" ON "project_assets" ("projectId", "assetId") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."UQ_pa_projectId_assetId"`);
  }
}
