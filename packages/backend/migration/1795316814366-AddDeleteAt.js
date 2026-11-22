/*
 * SPDX-FileCopyrightText: noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class AddDeleteAt1795316814366 {
	name = 'AddDeleteAt1795316814366';

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "note" ADD "deleteAt" TIMESTAMP WITH TIME ZONE`);
		await queryRunner.query(`COMMENT ON COLUMN "note"."deleteAt" IS 'The scheduled deletion date of the Note.'`);
		await queryRunner.query(`ALTER TABLE "note_draft" ADD "deleteAt" TIMESTAMP WITH TIME ZONE`);
		await queryRunner.query(`COMMENT ON COLUMN "note_draft"."deleteAt" IS 'The scheduled deletion date of the NoteDraft.'`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "note_draft" DROP COLUMN "deleteAt"`);
		await queryRunner.query(`ALTER TABLE "note" DROP COLUMN "deleteAt"`);
	}
}
