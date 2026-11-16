import { MigrationInterface, QueryRunner } from "typeorm";

export class AddFindingResolutionProvenance1794542982431 implements MigrationInterface {
    name = 'AddFindingResolutionProvenance1794542982431'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "vulnerabilities" ADD "lastSeenJobHistoryId" uuid`);
        await queryRunner.query(`ALTER TABLE "vulnerabilities" ADD "fixedByJobHistoryId" uuid`);
        await queryRunner.query(`ALTER TABLE "vulnerabilities" ADD "fixClaimedAt" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "vulnerabilities" ADD "fixClaimedById" uuid`);
        await queryRunner.query(`ALTER TABLE "vulnerabilities" ADD "dueAt" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "vulnerabilities" ADD CONSTRAINT "FK_226e5b9601745008d955dd38202" FOREIGN KEY ("lastSeenJobHistoryId") REFERENCES "job_histories"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "vulnerabilities" ADD CONSTRAINT "FK_7c604c5818ddc6ade14ce92913c" FOREIGN KEY ("fixedByJobHistoryId") REFERENCES "job_histories"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "vulnerabilities" ADD CONSTRAINT "FK_00bc829fe90ce4011038354af17" FOREIGN KEY ("fixClaimedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "vulnerabilities" DROP CONSTRAINT "FK_00bc829fe90ce4011038354af17"`);
        await queryRunner.query(`ALTER TABLE "vulnerabilities" DROP CONSTRAINT "FK_7c604c5818ddc6ade14ce92913c"`);
        await queryRunner.query(`ALTER TABLE "vulnerabilities" DROP CONSTRAINT "FK_226e5b9601745008d955dd38202"`);
        await queryRunner.query(`ALTER TABLE "vulnerabilities" DROP COLUMN "dueAt"`);
        await queryRunner.query(`ALTER TABLE "vulnerabilities" DROP COLUMN "fixClaimedById"`);
        await queryRunner.query(`ALTER TABLE "vulnerabilities" DROP COLUMN "fixClaimedAt"`);
        await queryRunner.query(`ALTER TABLE "vulnerabilities" DROP COLUMN "fixedByJobHistoryId"`);
        await queryRunner.query(`ALTER TABLE "vulnerabilities" DROP COLUMN "lastSeenJobHistoryId"`);
    }

}
