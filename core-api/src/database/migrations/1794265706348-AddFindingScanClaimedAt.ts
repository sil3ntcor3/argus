import { MigrationInterface, QueryRunner } from "typeorm";

export class AddFindingScanClaimedAt1794265706348 implements MigrationInterface {
    name = 'AddFindingScanClaimedAt1794265706348'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "jobs" ADD "findingScanClaimedAt" TIMESTAMP WITH TIME ZONE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "findingScanClaimedAt"`);
    }

}
