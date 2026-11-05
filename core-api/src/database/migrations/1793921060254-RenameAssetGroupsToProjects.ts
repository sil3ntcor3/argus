import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Data-preserving persistence rename from upstream #819. The task-generated
 * file proposed empty new tables and unrelated schema drift; its up/down are
 * narrowed to in-place renames so IDs, timestamps, workflow schedules, and
 * foreign-key semantics survive. Existing workflow FK nullability is retained.
 * Public group properties, permissions, event names and queue names stay put.
 * Provenance storage and permission backfills belong to later batches.
 */
export class RenameAssetGroupsToProjects1793921060254 implements MigrationInterface {
  name = 'RenameAssetGroupsToProjects1793921060254';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Tables and columns.
    await queryRunner.query(`ALTER TABLE "asset_groups" RENAME TO "projects"`);
    await queryRunner.query(
      `ALTER TABLE "assets_group_assets" RENAME TO "project_assets"`,
    );
    await queryRunner.query(
      `ALTER TABLE "asset_group_workflows" RENAME TO "project_workflows"`,
    );
    await queryRunner.query(
      `ALTER TABLE "project_assets" RENAME COLUMN "assetGroupId" TO "projectId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "project_workflows" RENAME COLUMN "assetGroupId" TO "projectId"`,
    );

    // Constraints (renaming a PK/UQ renames its index too) and indexes.
    for (const [table, from, to] of CONSTRAINT_RENAMES) {
      await queryRunner.query(
        `ALTER TABLE "${table}" RENAME CONSTRAINT "${from}" TO "${to}"`,
      );
    }
    for (const [from, to] of INDEX_RENAMES) {
      await queryRunner.query(`ALTER INDEX "${from}" RENAME TO "${to}"`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 1. Indexes, constraints, columns, tables.
    for (const [from, to] of INDEX_RENAMES) {
      await queryRunner.query(`ALTER INDEX "${to}" RENAME TO "${from}"`);
    }
    for (const [table, from, to] of CONSTRAINT_RENAMES) {
      await queryRunner.query(
        `ALTER TABLE "${table}" RENAME CONSTRAINT "${to}" TO "${from}"`,
      );
    }
    await queryRunner.query(
      `ALTER TABLE "project_workflows" RENAME COLUMN "projectId" TO "assetGroupId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "project_assets" RENAME COLUMN "projectId" TO "assetGroupId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "project_workflows" RENAME TO "asset_group_workflows"`,
    );
    await queryRunner.query(
      `ALTER TABLE "project_assets" RENAME TO "assets_group_assets"`,
    );
    await queryRunner.query(`ALTER TABLE "projects" RENAME TO "asset_groups"`);
  }
}

/** [table (new name), old constraint, new constraint] */
const CONSTRAINT_RENAMES: ReadonlyArray<[string, string, string]> = [
  ['projects', 'PK_1e8f37dccf890f00482ac0bb1ab', 'PK_6271df0a7aed1d6c0691ce6ac50'],
  ['projects', 'UQ_d1c6dfd6a740b46f543fe0a721c', 'UQ_8dda42e217868233acdfd77f170'],
  // workspaceId
  ['projects', 'FK_54ff1d9c294707e71753fec2b18', 'FK_108ff8a2d40c2b294511c92a7c8'],
  ['project_assets', 'PK_491c815ecb7be371fd5abe9effb', 'PK_7b9fd4c5f92d38acb7e270e0cce'],
  // projectId
  ['project_assets', 'FK_6fa72968a572d63e85086b58aec', 'FK_5529071de26d3313ac9759259ae'],
  // assetId
  ['project_assets', 'FK_05289fd83f48eeae11d258143af', 'FK_327cd55257e3260f823d29f8daf'],
  ['project_workflows', 'PK_bcacdb266f0a7df6e9d9733d00e', 'PK_90915ae85d062ee141add6aaa1e'],
  // projectId
  ['project_workflows', 'FK_b49dbca7f4cf406bd42786f3f0a', 'FK_5919bc91763db92759c619c851b'],
  // workflowId
  ['project_workflows', 'FK_1d91e7329d311307ee7d72a213d', 'FK_c2e12d06fb0b8b93707c0b14356'],
];

/** [old index, new index] */
const INDEX_RENAMES: ReadonlyArray<[string, string]> = [
  ['IDX_aga_assetGroupId', 'IDX_pa_projectId'],
  ['IDX_aga_assetId', 'IDX_pa_assetId'],
  ['IDX_agw_assetGroupId', 'IDX_pw_projectId'],
  ['IDX_agw_workflowId', 'IDX_pw_workflowId'],
  ['IDX_agw_assetGroupId_workflowId', 'IDX_pw_projectId_workflowId'],
];
