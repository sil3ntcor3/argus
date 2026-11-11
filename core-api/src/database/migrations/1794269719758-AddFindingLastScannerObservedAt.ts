import { MigrationInterface, QueryRunner } from "typeorm";

export class AddFindingLastScannerObservedAt1794269719758 implements MigrationInterface {
    name = 'AddFindingLastScannerObservedAt1794269719758'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "vulnerabilities" ADD "lastScannerObservedAt" TIMESTAMP WITH TIME ZONE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "vulnerabilities" DROP COLUMN "lastScannerObservedAt"`);
    }

}
