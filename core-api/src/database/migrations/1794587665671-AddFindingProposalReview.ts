import { MigrationInterface, QueryRunner } from "typeorm";

export class AddFindingProposalReview1794587665671 implements MigrationInterface {
    name = 'AddFindingProposalReview1794587665671'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "vulnerabilities" ADD "reviewStatus" character varying NOT NULL DEFAULT 'approved'`);
        await queryRunner.query(`ALTER TABLE "vulnerabilities" ADD "discoveredBy" character varying NOT NULL DEFAULT 'tool'`);
        await queryRunner.query(`ALTER TABLE "vulnerabilities" ADD "reviewedById" uuid`);
        await queryRunner.query(`ALTER TABLE "vulnerabilities" ADD "reviewedAt" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "vulnerabilities" ADD "reviewNote" text`);
        await queryRunner.query(`ALTER TABLE "vulnerability_sources" ADD "agentConversationId" uuid`);
        await queryRunner.query(`ALTER TABLE "vulnerability_sources" ADD "agentName" character varying`);
        await queryRunner.query(`ALTER TABLE "vulnerability_sources" ADD "toolCallIds" text array`);
        await queryRunner.query(`ALTER TABLE "vulnerability_sources" ADD "evidence" jsonb`);
        await queryRunner.query(`ALTER TABLE "vulnerability_sources" ADD "createdById" uuid`);
        await queryRunner.query(`CREATE INDEX "IDX_vuln_reviewStatus" ON "vulnerabilities" ("reviewStatus") `);
        await queryRunner.query(`ALTER TABLE "vulnerabilities" ADD CONSTRAINT "FK_d27c5219b22b775ca5de8f0bbfb" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "vulnerability_sources" ADD CONSTRAINT "FK_c92c5368a1453674cfb33054277" FOREIGN KEY ("agentConversationId") REFERENCES "agent_conversations"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "vulnerability_sources" ADD CONSTRAINT "FK_011a770dbbbdec1e221fb3cab12" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Prevent concurrent writers from passing the preservation check during downgrade.
        await queryRunner.query(`LOCK TABLE vulnerabilities, vulnerability_sources IN ACCESS EXCLUSIVE MODE`);
        const [state] = await queryRunner.query(`SELECT
          EXISTS(SELECT 1 FROM vulnerabilities WHERE "reviewStatus" <> 'approved'
            OR "discoveredBy" <> 'tool' OR "reviewedById" IS NOT NULL
            OR "reviewedAt" IS NOT NULL OR "reviewNote" IS NOT NULL)
          OR EXISTS(SELECT 1 FROM vulnerability_sources WHERE kind <> 'tool'
            OR "agentConversationId" IS NOT NULL OR "agentName" IS NOT NULL
            OR "toolCallIds" IS NOT NULL OR evidence IS NOT NULL OR "createdById" IS NOT NULL)
          OR EXISTS(SELECT 1 FROM vulnerability_events WHERE type IN
            ('proposed','approved','rejected','merged','verified_by_ai')) AS protected`);
        if (state.protected) throw new Error('Preserve proposal/review data before downgrading; stop writers and back up the database');

        await queryRunner.query(`ALTER TABLE "vulnerability_sources" DROP CONSTRAINT "FK_011a770dbbbdec1e221fb3cab12"`);
        await queryRunner.query(`ALTER TABLE "vulnerability_sources" DROP CONSTRAINT "FK_c92c5368a1453674cfb33054277"`);
        await queryRunner.query(`ALTER TABLE "vulnerabilities" DROP CONSTRAINT "FK_d27c5219b22b775ca5de8f0bbfb"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_vuln_reviewStatus"`);
        await queryRunner.query(`ALTER TABLE "vulnerability_sources" DROP COLUMN "createdById"`);
        await queryRunner.query(`ALTER TABLE "vulnerability_sources" DROP COLUMN "evidence"`);
        await queryRunner.query(`ALTER TABLE "vulnerability_sources" DROP COLUMN "toolCallIds"`);
        await queryRunner.query(`ALTER TABLE "vulnerability_sources" DROP COLUMN "agentName"`);
        await queryRunner.query(`ALTER TABLE "vulnerability_sources" DROP COLUMN "agentConversationId"`);
        await queryRunner.query(`ALTER TABLE "vulnerabilities" DROP COLUMN "reviewNote"`);
        await queryRunner.query(`ALTER TABLE "vulnerabilities" DROP COLUMN "reviewedAt"`);
        await queryRunner.query(`ALTER TABLE "vulnerabilities" DROP COLUMN "reviewedById"`);
        await queryRunner.query(`ALTER TABLE "vulnerabilities" DROP COLUMN "discoveredBy"`);
        await queryRunner.query(`ALTER TABLE "vulnerabilities" DROP COLUMN "reviewStatus"`);
    }

}
