import type { MigrationInterface, QueryRunner } from 'typeorm';

export class GeneralizeResourceComments1794579243161 implements MigrationInterface {
  name = 'GeneralizeResourceComments1794579243161';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "issue_comments" RENAME TO "comments"`);
    await queryRunner.query(`ALTER INDEX "IDX_issue_comments_issueId" RENAME TO "IDX_comments_issueId"`);
    await queryRunner.query(`ALTER TABLE "comments" RENAME CONSTRAINT "PK_c650a2d6817045a0c8ce74f09f4" TO "PK_8bf68bc960f2b69e818bdb90dcb"`);
    await queryRunner.query(`ALTER TABLE "comments" RENAME CONSTRAINT "FK_b4c4200d8d9e9954e867fe967ab" TO "FK_cd31cf1f563a06aeeaab821bd1c"`);
    await queryRunner.query(`ALTER TABLE "comments" RENAME CONSTRAINT "FK_94b28cbe4b8110d9fedcb44c489" TO "FK_87df5cc9d40c252f38b85618be1"`);
    await queryRunner.query(`ALTER TABLE "comments" RENAME CONSTRAINT "FK_4146db09b8fc3116c4940209438" TO "FK_5c61b17bafe3f12d447bd100e14"`);
    await queryRunner.query(`ALTER TABLE "comments" ALTER COLUMN "issueId" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "comments" ADD "vulnerabilityId" uuid`);
    await queryRunner.query(`ALTER TABLE "comments" ADD CONSTRAINT "FK_120ec346b8388a7cee98ce59738" FOREIGN KEY ("vulnerabilityId") REFERENCES "vulnerabilities"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    await queryRunner.query(`ALTER TABLE "comments" ADD CONSTRAINT "CHK_comments_one_subject" CHECK (("issueId" IS NOT NULL)::int + ("vulnerabilityId" IS NOT NULL)::int = 1)`);
    await queryRunner.query(`CREATE INDEX "IDX_comments_vulnerabilityId" ON "comments" ("vulnerabilityId", "createdAt")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Prevent a concurrent writer from adding finding comments after the guard.
    await queryRunner.query(`LOCK TABLE "comments" IN ACCESS EXCLUSIVE MODE`);
    const findingComments: { id: string }[] = await queryRunner.query(
      `SELECT id FROM "comments" WHERE "vulnerabilityId" IS NOT NULL LIMIT 1`,
    );
    if (findingComments.length) {
      throw new Error('Cannot revert resource comments while finding comments exist');
    }
    await queryRunner.query(`DROP INDEX "IDX_comments_vulnerabilityId"`);
    await queryRunner.query(`ALTER TABLE "comments" DROP CONSTRAINT "CHK_comments_one_subject"`);
    await queryRunner.query(`ALTER TABLE "comments" DROP CONSTRAINT "FK_120ec346b8388a7cee98ce59738"`);
    await queryRunner.query(`ALTER TABLE "comments" DROP COLUMN "vulnerabilityId"`);
    await queryRunner.query(`ALTER TABLE "comments" ALTER COLUMN "issueId" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "comments" RENAME CONSTRAINT "FK_5c61b17bafe3f12d447bd100e14" TO "FK_4146db09b8fc3116c4940209438"`);
    await queryRunner.query(`ALTER TABLE "comments" RENAME CONSTRAINT "FK_87df5cc9d40c252f38b85618be1" TO "FK_94b28cbe4b8110d9fedcb44c489"`);
    await queryRunner.query(`ALTER TABLE "comments" RENAME CONSTRAINT "FK_cd31cf1f563a06aeeaab821bd1c" TO "FK_b4c4200d8d9e9954e867fe967ab"`);
    await queryRunner.query(`ALTER TABLE "comments" RENAME CONSTRAINT "PK_8bf68bc960f2b69e818bdb90dcb" TO "PK_c650a2d6817045a0c8ce74f09f4"`);
    await queryRunner.query(`ALTER INDEX "IDX_comments_issueId" RENAME TO "IDX_issue_comments_issueId"`);
    await queryRunner.query(`ALTER TABLE "comments" RENAME TO "issue_comments"`);
  }
}
