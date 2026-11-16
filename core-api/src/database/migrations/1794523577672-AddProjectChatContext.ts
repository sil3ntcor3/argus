import { MigrationInterface, QueryRunner } from "typeorm";

export class AddProjectChatContext1794523577672 implements MigrationInterface {
    name = 'AddProjectChatContext1794523577672'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "project_artifacts" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "projectId" uuid NOT NULL, "artifactId" uuid NOT NULL, CONSTRAINT "UQ_project_artifacts_projectId_artifactId" UNIQUE ("projectId", "artifactId"), CONSTRAINT "PK_bf8e108132fdb9323183cea0ced" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_project_artifacts_artifactId" ON "project_artifacts" ("artifactId") `);
        await queryRunner.query(`ALTER TABLE "projects" ADD "instruction" character varying(2000)`);
        await queryRunner.query(`ALTER TABLE "agent_conversations" ADD "projectId" uuid`);
        await queryRunner.query(`ALTER TABLE "agent_llm_configs" ADD "reasoningEffort" character varying(20)`);
        await queryRunner.query(`ALTER TABLE "agent_configs" ADD "defaultReasoningEffort" character varying(20)`);
        await queryRunner.query(`CREATE INDEX "IDX_agent_conv_projectId" ON "agent_conversations" ("projectId") `);
        await queryRunner.query(`ALTER TABLE "project_artifacts" ADD CONSTRAINT "FK_5de27cb7b729f9aaec396a768ee" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "project_artifacts" ADD CONSTRAINT "FK_c04b1cf08eec361deff4388c04c" FOREIGN KEY ("artifactId") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "agent_conversations" ADD CONSTRAINT "FK_b21bc8d32df378732c6c7d00463" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "agent_conversations" DROP CONSTRAINT "FK_b21bc8d32df378732c6c7d00463"`);
        await queryRunner.query(`ALTER TABLE "project_artifacts" DROP CONSTRAINT "FK_c04b1cf08eec361deff4388c04c"`);
        await queryRunner.query(`ALTER TABLE "project_artifacts" DROP CONSTRAINT "FK_5de27cb7b729f9aaec396a768ee"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_agent_conv_projectId"`);
        await queryRunner.query(`ALTER TABLE "agent_configs" DROP COLUMN "defaultReasoningEffort"`);
        await queryRunner.query(`ALTER TABLE "agent_llm_configs" DROP COLUMN "reasoningEffort"`);
        await queryRunner.query(`ALTER TABLE "agent_conversations" DROP COLUMN "projectId"`);
        await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN "instruction"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_project_artifacts_artifactId"`);
        await queryRunner.query(`DROP TABLE "project_artifacts"`);
    }

}
