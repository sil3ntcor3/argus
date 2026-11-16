import { MigrationInterface, QueryRunner } from "typeorm";

export class AddGenericIssueTracking1794593350346 implements MigrationInterface {
    name = 'AddGenericIssueTracking1794593350346'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`LOCK TABLE "issues" IN ACCESS EXCLUSIVE MODE`);
        await queryRunner.query(`CREATE TABLE "issue_rules" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "workspaceId" uuid NOT NULL, "name" character varying NOT NULL, "enabled" boolean NOT NULL DEFAULT true, "event" character varying NOT NULL, "conditions" jsonb NOT NULL DEFAULT '{}', "issueType" character varying NOT NULL, "groupBy" character varying NOT NULL DEFAULT 'vulnerability_name', "priority" character varying, "defaultAssigneeId" uuid, "createdById" uuid, CONSTRAINT "PK_f49495a6e450ef8534686579ddb" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_issue_rules_workspaceId_event" ON "issue_rules" ("workspaceId", "event") `);
        await queryRunner.query(`CREATE TABLE "issue_links" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "issueId" uuid NOT NULL, "resourceType" character varying NOT NULL, "resourceId" uuid NOT NULL, "addedById" uuid, CONSTRAINT "UQ_issue_links_issue_resource" UNIQUE ("issueId", "resourceType", "resourceId"), CONSTRAINT "PK_92c961bad3a83cebd040a61d87f" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_issue_links_resource" ON "issue_links" ("resourceType", "resourceId") `);
        await queryRunner.query(`CREATE TABLE "issue_counters" ("workspaceId" uuid NOT NULL, "lastNo" integer NOT NULL DEFAULT '0', CONSTRAINT "PK_e2a6baed5c897c16cfba4c3b8b6" PRIMARY KEY ("workspaceId"))`);
        await queryRunner.query(`ALTER TABLE "issues" ADD "type" character varying NOT NULL DEFAULT 'task'`);
        await queryRunner.query(`ALTER TABLE "issues" ADD "priority" character varying NOT NULL DEFAULT 'p3'`);
        await queryRunner.query(`ALTER TABLE "issues" ADD "resolution" character varying`);
        await queryRunner.query(`ALTER TABLE "issues" ADD "resolvedAt" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "issues" ADD "dueAt" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "issues" ADD "assigneeId" uuid`);
        await queryRunner.query(`ALTER TABLE "issues" ADD "ruleId" uuid`);
        await queryRunner.query(`ALTER TABLE "issues" ADD "groupKey" character varying`);
        await queryRunner.query(`ALTER TABLE "issues" ADD "externalRef" jsonb`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_issues_open_groupKey" ON "issues" ("workspaceId", "type", "groupKey") WHERE "groupKey" IS NOT NULL AND "status" IN ('open', 'in_progress')`);
        await queryRunner.query(`CREATE INDEX "IDX_issues_assigneeId" ON "issues" ("assigneeId") `);
        // Preserve every unique positive legacy number; repair ambiguous numbers
        // above the previous workspace maximum without changing issue identities.
        await queryRunner.query(`WITH ranked AS (
          SELECT id,"workspaceId",no,"createdAt",
            row_number() OVER (PARTITION BY "workspaceId",no ORDER BY "createdAt",id) AS duplicate_rank
          FROM issues WHERE "workspaceId" IS NOT NULL
        ), repairs AS (
          SELECT id,"workspaceId",row_number() OVER (PARTITION BY "workspaceId" ORDER BY "createdAt",id) AS offset_no
          FROM ranked WHERE no <= 0 OR duplicate_rank > 1
        ), maxima AS (
          SELECT "workspaceId",GREATEST(0,max(no)::bigint) AS max_no FROM issues GROUP BY "workspaceId"
        ) UPDATE issues i SET no=(m.max_no+r.offset_no)::integer
          FROM repairs r JOIN maxima m ON m."workspaceId"=r."workspaceId" WHERE i.id=r.id`);
        await queryRunner.query(`INSERT INTO issue_counters ("workspaceId","lastNo")
          SELECT "workspaceId",GREATEST(0,max(no)) FROM issues
          WHERE "workspaceId" IS NOT NULL GROUP BY "workspaceId"`);
        // sourceId is legacy text. CASE keeps malformed IDs from being cast,
        // and the full finding/asset/target join proves workspace ownership.
        await queryRunner.query(`INSERT INTO issue_links ("issueId","resourceType","resourceId","createdAt","updatedAt")
          SELECT i.id,'vulnerability',v.id,i."createdAt",i."updatedAt" FROM issues i
          JOIN vulnerabilities v ON v.id=CASE WHEN i."sourceId" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN i."sourceId"::uuid END
          JOIN assets a ON a.id=v."assetId" JOIN targets t ON t.id=a."targetId"
          WHERE i."sourceType"='vulnerability' AND t."workspaceId"=i."workspaceId"
          ON CONFLICT ("issueId","resourceType","resourceId") DO NOTHING`);
        await queryRunner.query(`UPDATE issues i SET type='vulnerability_remediation'
          WHERE EXISTS (SELECT 1 FROM issue_links l WHERE l."issueId"=i.id AND l."resourceType"='vulnerability')`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_issues_workspaceId_no" ON "issues" ("workspaceId", "no") `);
        await queryRunner.query(`ALTER TABLE "issue_rules" ADD CONSTRAINT "FK_e10f3f6b607f92219b01c75df56" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "issue_rules" ADD CONSTRAINT "FK_f9ea757bc5681d164fd097419da" FOREIGN KEY ("defaultAssigneeId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "issue_rules" ADD CONSTRAINT "FK_03ec48048aaaf03f10d9174224f" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "issue_links" ADD CONSTRAINT "FK_79e0d85dacd5bcc7a1b2076df1a" FOREIGN KEY ("issueId") REFERENCES "issues"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "issue_links" ADD CONSTRAINT "FK_a1d7420e823c9e77ba966169c9b" FOREIGN KEY ("addedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "issues" ADD CONSTRAINT "FK_9a9187fec2a363ed3bbea2a6b63" FOREIGN KEY ("assigneeId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "issues" ADD CONSTRAINT "FK_69936c2aff2be0aab32a457c77d" FOREIGN KEY ("ruleId") REFERENCES "issue_rules"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "issue_counters" ADD CONSTRAINT "FK_e2a6baed5c897c16cfba4c3b8b6" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`LOCK TABLE "issues","issue_links","issue_rules","issue_counters" IN ACCESS EXCLUSIVE MODE`);
        await queryRunner.query(`DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM issue_rules) OR EXISTS (SELECT 1 FROM issue_links)
            OR EXISTS (SELECT 1 FROM issue_counters WHERE "lastNo">0)
            OR EXISTS (SELECT 1 FROM issues WHERE type<>'task' OR priority<>'p3'
              OR resolution IS NOT NULL OR "resolvedAt" IS NOT NULL OR "dueAt" IS NOT NULL
              OR "assigneeId" IS NOT NULL OR "ruleId" IS NOT NULL OR "groupKey" IS NOT NULL
              OR "externalRef" IS NOT NULL OR status IN ('in_progress','resolved'))
            OR EXISTS (SELECT 1 FROM comments WHERE type='system') THEN
            RAISE EXCEPTION 'Cannot downgrade generic Issues while issue tracking data or reserved numbers remain; preserve and reconcile the data first';
          END IF;
        END $$`);
        await queryRunner.query(`ALTER TABLE "issue_counters" DROP CONSTRAINT "FK_e2a6baed5c897c16cfba4c3b8b6"`);
        await queryRunner.query(`ALTER TABLE "issues" DROP CONSTRAINT "FK_69936c2aff2be0aab32a457c77d"`);
        await queryRunner.query(`ALTER TABLE "issues" DROP CONSTRAINT "FK_9a9187fec2a363ed3bbea2a6b63"`);
        await queryRunner.query(`ALTER TABLE "issue_links" DROP CONSTRAINT "FK_a1d7420e823c9e77ba966169c9b"`);
        await queryRunner.query(`ALTER TABLE "issue_links" DROP CONSTRAINT "FK_79e0d85dacd5bcc7a1b2076df1a"`);
        await queryRunner.query(`ALTER TABLE "issue_rules" DROP CONSTRAINT "FK_03ec48048aaaf03f10d9174224f"`);
        await queryRunner.query(`ALTER TABLE "issue_rules" DROP CONSTRAINT "FK_f9ea757bc5681d164fd097419da"`);
        await queryRunner.query(`ALTER TABLE "issue_rules" DROP CONSTRAINT "FK_e10f3f6b607f92219b01c75df56"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_issues_workspaceId_no"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_issues_assigneeId"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_issues_open_groupKey"`);
        await queryRunner.query(`ALTER TABLE "issues" DROP COLUMN "externalRef"`);
        await queryRunner.query(`ALTER TABLE "issues" DROP COLUMN "groupKey"`);
        await queryRunner.query(`ALTER TABLE "issues" DROP COLUMN "ruleId"`);
        await queryRunner.query(`ALTER TABLE "issues" DROP COLUMN "assigneeId"`);
        await queryRunner.query(`ALTER TABLE "issues" DROP COLUMN "dueAt"`);
        await queryRunner.query(`ALTER TABLE "issues" DROP COLUMN "resolvedAt"`);
        await queryRunner.query(`ALTER TABLE "issues" DROP COLUMN "resolution"`);
        await queryRunner.query(`ALTER TABLE "issues" DROP COLUMN "priority"`);
        await queryRunner.query(`ALTER TABLE "issues" DROP COLUMN "type"`);
        await queryRunner.query(`DROP TABLE "issue_counters"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_issue_links_resource"`);
        await queryRunner.query(`DROP TABLE "issue_links"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_issue_rules_workspaceId_event"`);
        await queryRunner.query(`DROP TABLE "issue_rules"`);
    }

}
