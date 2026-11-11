import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProjectMetadata1793970489894 implements MigrationInterface {
  name = 'AddProjectMetadata1793970489894';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "projects" ADD "description" text`);
    await queryRunner.query(
      `ALTER TABLE "projects" ADD "autoAddAssets" boolean NOT NULL DEFAULT true`,
    );
    await queryRunner.query(
      `ALTER TABLE "projects" ADD "archivedAt" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN "archivedAt"`);
    await queryRunner.query(
      `ALTER TABLE "projects" DROP COLUMN "autoAddAssets"`,
    );
    await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN "description"`);
  }
}
