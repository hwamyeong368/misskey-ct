/*
 * SPDX-FileCopyrightText: syuilo and misskey-project & noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import ms from 'ms';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { GetterService } from '@/server/api/GetterService.js';
import { RoleService } from '@/core/RoleService.js';
import { KyunetTranslationSettingService } from '@/core/KyunetTranslationSettingService.js';
import { KyunetTranslationService } from '@/core/KyunetTranslationService.js';
import { DI } from '@/di-symbols.js';
import type { UserProfilesRepository } from '@/models/_.js';
import { ApiError } from '../../error.js';

export const meta = {
	tags: ['users'],

	requireCredential: true,
	kind: 'read:account',

	limit: {
		duration: ms('1minute'),
		max: 30,
	},

	res: {
		type: 'object',
		optional: true, nullable: false,
		properties: {
			sourceLang: { type: 'string' },
			text: { type: 'string' },
		},
	},

	errors: {
		unavailable: {
			message: 'Translate of description unavailable.',
			code: 'UNAVAILABLE',
			id: '50a70314-2d8a-431b-b433-efa5cc56444c',
		},
		noSuchDescription: {
			message: 'No such description.',
			code: 'NO_SUCH_DESCRIPTION',
			id: 'bea9b03f-36e0-49c5-a4db-627a029f8971',
		},
		noTranslateService: {
			message: 'Translate service is not available.',
			code: 'NO_TRANSLATE_SERVICE',
			id: 'bef6e895-c05d-4499-9815-035ed18b0e31',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		userId: { type: 'string', format: 'misskey:id' },
		targetLang: { type: 'string' },
	},
	required: ['userId', 'targetLang'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.userProfilesRepository)
		private userProfilesRepository: UserProfilesRepository,

		private getterService: GetterService,
		private roleService: RoleService,
		private kyunetTranslationSettingService: KyunetTranslationSettingService,
		private kyunetTranslationService: KyunetTranslationService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const policies = await this.roleService.getUserPolicies(me.id);
			if (!policies.canUseTranslator) {
				throw new ApiError(meta.errors.unavailable);
			}

			const targetUser = await this.getterService.getUser(ps.userId).catch(err => {
				if (err.id === '15348ddd-432d-49c2-8a5a-8069753becff') throw new ApiError(meta.errors.noSuchDescription);
				throw err;
			});

			if (targetUser.isDeleted || (targetUser.isSuspended && !(await this.roleService.isModerator(me)))) {
				throw new ApiError(meta.errors.noSuchDescription);
			}

			const profile = await this.userProfilesRepository.findOneBy({ userId: targetUser.id });
			if (profile == null || profile.description == null || profile.description.trim() === '') {
				throw new ApiError(meta.errors.noSuchDescription);
			}

			if (!this.kyunetTranslationSettingService.isAvailable()) {
				throw new ApiError(meta.errors.unavailable);
			}

			const [result] = await this.kyunetTranslationService.translate(
				[{ type: 'user_description', id: ps.userId }],
				ps.targetLang,
				me,
			);

			if (result == null || result.status !== 'ok') {
				throw new ApiError(meta.errors.unavailable);
			}

			return {
				sourceLang: result.sourceLangs[0] ?? '',
				text: result.text ?? profile.description,
			};
		});
	}
}
