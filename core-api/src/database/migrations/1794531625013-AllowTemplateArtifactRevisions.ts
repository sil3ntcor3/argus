import type { MigrationInterface, QueryRunner } from "typeorm";

export class AllowTemplateArtifactRevisions1794531625013 implements MigrationInterface {
    name = 'AllowTemplateArtifactRevisions1794531625013'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "artifacts" DROP CONSTRAINT "CHK_artifacts_object_key"`);
        await queryRunner.query(`ALTER TABLE "artifacts" DROP CONSTRAINT "CHK_artifacts_source"`);
        await queryRunner.query(`ALTER TABLE "artifacts" ADD CONSTRAINT "CHK_artifacts_object_key_revisions" CHECK ("objectKey" = ('workspaces/' || "workspaceId"::text || '/' || "id"::text || '/file') OR
   ("source" = 'template' AND "objectKey" ~ ('^workspaces/' || "workspaceId"::text || '/' || "id"::text ||
    '/revisions/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$')))`);
        await queryRunner.query(`ALTER TABLE "artifacts" ADD CONSTRAINT "CHK_artifacts_source_templates" CHECK ("source" IN ('upload', 'agent', 'template'))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "artifacts" DROP CONSTRAINT "CHK_artifacts_source_templates"`);
        await queryRunner.query(`ALTER TABLE "artifacts" DROP CONSTRAINT "CHK_artifacts_object_key_revisions"`);
        await queryRunner.query(`ALTER TABLE "artifacts" ADD CONSTRAINT "CHK_artifacts_source" CHECK (((source)::text = ANY ((ARRAY['upload'::character varying, 'agent'::character varying])::text[])))`);
        await queryRunner.query(`ALTER TABLE "artifacts" ADD CONSTRAINT "CHK_artifacts_object_key" CHECK (("objectKey" = (((('workspaces/'::text || ("workspaceId")::text) || '/'::text) || (id)::text) || '/file'::text)))`);
    }

}
