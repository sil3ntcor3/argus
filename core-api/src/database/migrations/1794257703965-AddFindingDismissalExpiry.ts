import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFindingDismissalExpiry1794257703965 implements MigrationInterface {
  name = 'AddFindingDismissalExpiry1794257703965';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vulnerability_dismissals" ADD "expiresAt" TIMESTAMP WITH TIME ZONE`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vulnerability_dismissals" DROP COLUMN "expiresAt"`);
  }
}
