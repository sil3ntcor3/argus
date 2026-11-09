import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddJobFindingScanScopeKey1794251812574 implements MigrationInterface {
  name = 'AddJobFindingScanScopeKey1794251812574';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "jobs" ADD "findingScanScopeKey" character varying`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "findingScanScopeKey"`);
  }
}
