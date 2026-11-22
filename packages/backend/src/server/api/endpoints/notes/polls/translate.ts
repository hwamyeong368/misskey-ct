/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { URLSearchParams } from 'node:url';
import { Inject, Injectable } from '@nestjs/common';
import ms from 'ms';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { HttpRequestService } from '@/core/HttpRequestService.js';
import { RoleService } from '@/core/RoleService.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { GetterService } from '@/server/api/GetterService.js';
import { MiMeta } from '@/models/_.js';
import type { PollsRepository } from '@/models/_.js';
import { DI } from '@/di-symbols.js';
import { ApiError } from '../../../error.js';

export const meta = {
	tags: ['notes'],

	requireCredential: true,
	kind: 'read:account',

	limit: {
		duration: ms('1minute'),
		max: 60,
	},

	res: {
		type: 'object',
		optional: true, nullable: false,
		properties: {
			sourceLang: { type: 'string' },
			text: {
				type: 'array',
				optional: true, nullable: false,
				items: {
					type: 'string',
					optional: false, nullable: true,
				},
			},
		},
	},

	errors: {
		unavailable: {
			message: 'Translate of polls unavailable.',
			code: 'UNAVAILABLE',
			id: 'dc5ba5b7-0d50-4dcd-80f5-910f16a56b40',
		},
		noSuchNote: {
			message: 'No such note.',
			code: 'NO_SUCH_NOTE',
			id: 'bea9b03f-36e0-49c5-a4db-627a029f8971',
		},
		cannotTranslateInvisibleNote: {
			message: 'Cannot translate invisible note.',
			code: 'CANNOT_TRANSLATE_INVISIBLE_NOTE',
			id: 'ea29f2ca-c368-43b3-aaf1-5ac3e74bbe5d',
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
		noteId: { type: 'string', format: 'misskey:id' },
		targetLang: { type: 'string' },
	},
	required: ['noteId', 'targetLang'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.meta)
		private serverSettings: MiMeta,

		@Inject(DI.pollsRepository)
		private pollsRepository: PollsRepository,

		private httpRequestService: HttpRequestService,
		private roleService: RoleService,
		private getterService: GetterService,
		private noteEntityService: NoteEntityService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const policies = await this.roleService.getUserPolicies(me.id);
			if (!policies.canUseTranslator) {
				throw new ApiError(meta.errors.unavailable);
			}

			const note = await this.getterService.getNote(ps.noteId).catch(err => {
				if (err.id === '9725d0ce-ba28-4dde-95a7-2cbb2c15de24') throw new ApiError(meta.errors.noSuchNote);
				throw err;
			});

			if (!(await this.noteEntityService.isVisibleForMe(note, me.id))) {
				throw new ApiError(meta.errors.cannotTranslateInvisibleNote);
			}

			// makeNotesHiddenBefore などで中身が隠されるノート
			const packedNote = await this.noteEntityService.pack(note, me);
			if (packedNote.isHidden) {
				throw new ApiError(meta.errors.cannotTranslateInvisibleNote);
			}

			const poll = await this.pollsRepository.findOneBy({ noteId: note.id });
			if (poll == null) {
				throw new ApiError(meta.errors.noSuchNote);
			}

			if (poll.choices == null || poll.choices.length === 0) {
				return;
			}

			if (this.serverSettings.deeplAuthKey == null || this.serverSettings.deeplAuthKey === '') {
				throw new ApiError(meta.errors.unavailable);
			}

			let targetLang = ps.targetLang;
			if (targetLang.includes('-')) targetLang = targetLang.split('-')[0];

			const endpoint = this.serverSettings.deeplIsPro ? 'https://api.deepl.com/v2/translate' : 'https://api-free.deepl.com/v2/translate';
			const translations: { sourceLang: string; text: string }[] = [];

			for (const choice of poll.choices) {
				if (choice.trim() === '') {
					translations.push({ sourceLang: '', text: choice });
					continue;
				}

				const params = new URLSearchParams();
				params.append('text', choice);
				params.append('target_lang', targetLang);

				const res = await this.httpRequestService.send(endpoint, {
					method: 'POST',
					headers: {
						'Authorization': `DeepL-Auth-Key ${this.serverSettings.deeplAuthKey}`,
						'Content-Type': 'application/x-www-form-urlencoded',
						Accept: 'application/json, */*',
					},
					body: params.toString(),
				});

				const json = (await res.json()) as {
					translations: {
						detected_source_language: string;
						text: string;
					}[];
				};

				translations.push({
					sourceLang: json.translations[0]?.detected_source_language ?? '',
					text: json.translations[0]?.text ?? '',
				});
			}

			return {
				sourceLang: translations.find(t => t.sourceLang !== '')?.sourceLang ?? '',
				text: translations.map(t => t.text),
			};
		});
	}
}
