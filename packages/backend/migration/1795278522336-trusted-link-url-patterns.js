/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class TrustedLinkUrlPatterns1795278522336 {
	name = 'TrustedLinkUrlPatterns1795278522336';

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "meta" ADD "trustedLinkUrlPatterns" character varying(3072) array NOT NULL DEFAULT '{}'`);
		await queryRunner.query(`COMMENT ON COLUMN "meta"."trustedLinkUrlPatterns" IS 'An array of URL strings or regex that can be used to omit warnings about redirects to external sites. Separate them with spaces to specify AND, and enclose them with slashes to specify regular expressions. Each item is regarded as an OR.'`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "trustedLinkUrlPatterns"`);
	}
}
