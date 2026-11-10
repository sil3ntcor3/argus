import { MigrationInterface, QueryRunner } from "typeorm";

export class AddWorkspaceArtifacts1794275938648 implements MigrationInterface {
    name = 'AddWorkspaceArtifacts1794275938648'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "artifacts" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "workspaceId" uuid NOT NULL, "createdByUserId" uuid, "name" text NOT NULL, "mimeType" character varying(255) NOT NULL, "objectKey" text NOT NULL, "sizeBytes" bigint NOT NULL, "source" character varying NOT NULL DEFAULT 'upload', "status" character varying NOT NULL DEFAULT 'pending', "metadata" jsonb NOT NULL DEFAULT '{}', "expiresAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_artifacts_object_key" UNIQUE ("objectKey"), CONSTRAINT "CHK_artifacts_object_key" CHECK ("objectKey" = ('workspaces/' || "workspaceId"::text || '/' || "id"::text || '/file')), CONSTRAINT "CHK_artifacts_metadata" CHECK (jsonb_typeof("metadata") = 'object'), CONSTRAINT "CHK_artifacts_pending_expiry" CHECK ("status" <> 'pending' OR "expiresAt" IS NOT NULL), CONSTRAINT "CHK_artifacts_status" CHECK ("status" IN ('pending', 'ready', 'deleted')), CONSTRAINT "CHK_artifacts_source" CHECK ("source" IN ('upload', 'agent')), CONSTRAINT "CHK_artifacts_size_bytes" CHECK ("sizeBytes" BETWEEN 0 AND 9007199254740991), CONSTRAINT "PK_artifacts_id" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_artifacts_status_expires" ON "artifacts" ("status", "expiresAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_artifacts_creator" ON "artifacts" ("createdByUserId") `);
        await queryRunner.query(`CREATE INDEX "IDX_artifacts_workspace_created" ON "artifacts" ("workspaceId", "createdAt") `);
        await queryRunner.query(`ALTER TABLE "artifacts" ADD CONSTRAINT "FK_artifacts_workspace" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "artifacts" ADD CONSTRAINT "FK_artifacts_creator" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "artifacts" DROP CONSTRAINT "FK_artifacts_creator"`);
        await queryRunner.query(`ALTER TABLE "artifacts" DROP CONSTRAINT "FK_artifacts_workspace"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_artifacts_workspace_created"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_artifacts_creator"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_artifacts_status_expires"`);
        await queryRunner.query(`DROP TABLE "artifacts"`);
    }

}
