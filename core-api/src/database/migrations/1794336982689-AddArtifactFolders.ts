import { MigrationInterface, QueryRunner } from "typeorm";

export class AddArtifactFolders1794336982689 implements MigrationInterface {
    name = 'AddArtifactFolders1794336982689'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "artifact_folders" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "workspaceId" uuid NOT NULL, "parentFolderId" uuid, "name" text NOT NULL, "createdByUserId" uuid, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_artifact_folders_workspace_id" UNIQUE ("workspaceId", "id"), CONSTRAINT "PK_artifact_folders_id" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_artifact_folders_creator" ON "artifact_folders" ("createdByUserId")`);
        await queryRunner.query(`CREATE INDEX "IDX_artifact_folders_workspace_parent" ON "artifact_folders" ("workspaceId", "parentFolderId")`);
        await queryRunner.query(`ALTER TABLE "artifacts" ADD "parentFolderId" uuid`);
        await queryRunner.query(`CREATE INDEX "IDX_artifacts_workspace_folder" ON "artifacts" ("workspaceId", "parentFolderId")`);
        await queryRunner.query(`ALTER TABLE "artifact_folders" ADD CONSTRAINT "FK_artifact_folders_workspace" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "artifact_folders" ADD CONSTRAINT "FK_artifact_folders_creator" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "artifact_folders" ADD CONSTRAINT "FK_artifact_folders_parent" FOREIGN KEY ("workspaceId", "parentFolderId") REFERENCES "artifact_folders"("workspaceId","id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "artifacts" ADD CONSTRAINT "FK_artifacts_parent_folder" FOREIGN KEY ("workspaceId", "parentFolderId") REFERENCES "artifact_folders"("workspaceId","id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "artifacts" DROP CONSTRAINT "FK_artifacts_parent_folder"`);
        await queryRunner.query(`ALTER TABLE "artifact_folders" DROP CONSTRAINT "FK_artifact_folders_parent"`);
        await queryRunner.query(`ALTER TABLE "artifact_folders" DROP CONSTRAINT "FK_artifact_folders_creator"`);
        await queryRunner.query(`ALTER TABLE "artifact_folders" DROP CONSTRAINT "FK_artifact_folders_workspace"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_artifacts_workspace_folder"`);
        await queryRunner.query(`ALTER TABLE "artifacts" DROP COLUMN "parentFolderId"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_artifact_folders_workspace_parent"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_artifact_folders_creator"`);
        await queryRunner.query(`DROP TABLE "artifact_folders"`);
    }

}
