import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSystemConfigSettings1793772490708 implements MigrationInterface {
  name = 'AddSystemConfigSettings1793772490708';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "workspaces" ADD "settings" jsonb NOT NULL DEFAULT '{}'`,
    );
    await queryRunner.query(
      `ALTER TABLE "system_configs" ADD "settings" jsonb NOT NULL DEFAULT '{}'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "system_configs" DROP COLUMN "settings"`,
    );
    await queryRunner.query(`ALTER TABLE "workspaces" DROP COLUMN "settings"`);
  }
}
