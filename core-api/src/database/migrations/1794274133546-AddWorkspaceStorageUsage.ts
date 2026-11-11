import { MigrationInterface, QueryRunner } from "typeorm";

export class AddWorkspaceStorageUsage1794274133546 implements MigrationInterface {
    name = 'AddWorkspaceStorageUsage1794274133546'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "workspace_storage_usage" ("workspaceId" uuid NOT NULL, "quotaBytes" bigint, "usedBytes" bigint NOT NULL DEFAULT '0', "reservedBytes" bigint NOT NULL DEFAULT '0', "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_wsu_reserved_bytes" CHECK ("reservedBytes" BETWEEN 0 AND 9007199254740991), CONSTRAINT "CHK_wsu_used_bytes" CHECK ("usedBytes" BETWEEN 0 AND 9007199254740991), CONSTRAINT "CHK_wsu_quota_bytes" CHECK ("quotaBytes" IS NULL OR "quotaBytes" BETWEEN 0 AND 9007199254740991), CONSTRAINT "PK_wsu_workspace" PRIMARY KEY ("workspaceId"))`);
        await queryRunner.query(`ALTER TABLE "workspace_storage_usage" ADD CONSTRAINT "FK_wsu_workspace" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "workspace_storage_usage" DROP CONSTRAINT "FK_wsu_workspace"`);
        await queryRunner.query(`DROP TABLE "workspace_storage_usage"`);
    }

}
