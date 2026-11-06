import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddJobInputs1793935884086 implements MigrationInterface {
  name = 'AddJobInputs1793935884086';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "jobs" ADD "inputs" jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "inputs"`);
  }
}
