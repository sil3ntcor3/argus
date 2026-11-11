import { MigrationInterface, QueryRunner } from "typeorm";

export class AddArtifactShareType1794360152913 implements MigrationInterface {
    name = 'AddArtifactShareType1794360152913'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "artifacts" ADD "shareType" character varying NOT NULL DEFAULT 'private'`);
        await queryRunner.query(`ALTER TABLE "artifacts" ADD CONSTRAINT "CHK_artifacts_share_type" CHECK ("shareType" IN ('private', 'shared', 'public'))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "artifacts" DROP CONSTRAINT "CHK_artifacts_share_type"`);
        await queryRunner.query(`ALTER TABLE "artifacts" DROP COLUMN "shareType"`);
    }

}
