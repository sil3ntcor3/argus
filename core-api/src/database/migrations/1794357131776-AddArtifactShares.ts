import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddArtifactShares1794357131776 implements MigrationInterface {
    name = 'AddArtifactShares1794357131776'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "artifact_shares" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "artifactId" uuid NOT NULL, "userId" uuid NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_artifact_shares_artifact_user" UNIQUE ("artifactId", "userId"), CONSTRAINT "PK_artifact_shares_id" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_artifact_shares_user" ON "artifact_shares" ("userId") `);
        await queryRunner.query(`ALTER TABLE "artifact_shares" ADD CONSTRAINT "FK_artifact_shares_artifact" FOREIGN KEY ("artifactId") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "artifact_shares" ADD CONSTRAINT "FK_artifact_shares_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "artifact_shares" DROP CONSTRAINT "FK_artifact_shares_user"`);
        await queryRunner.query(`ALTER TABLE "artifact_shares" DROP CONSTRAINT "FK_artifact_shares_artifact"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_artifact_shares_user"`);
        await queryRunner.query(`DROP TABLE "artifact_shares"`);
    }

}
