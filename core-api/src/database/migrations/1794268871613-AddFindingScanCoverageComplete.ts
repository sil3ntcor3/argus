import { MigrationInterface, QueryRunner } from "typeorm";

export class AddFindingScanCoverageComplete1794268871613 implements MigrationInterface {
    name = 'AddFindingScanCoverageComplete1794268871613'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "jobs" ADD "findingScanCoverageComplete" boolean`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "findingScanCoverageComplete"`);
    }

}
