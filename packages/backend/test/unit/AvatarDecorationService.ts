/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import type * as Redis from 'ioredis';
import type { Config } from '@/config.js';
import type { AvatarDecorationsRepository, MiAvatarDecoration } from '@/models/_.js';
import type { IdService } from '@/core/IdService.js';
import type { ModerationLogService } from '@/core/ModerationLogService.js';
import type { GlobalEventService } from '@/core/GlobalEventService.js';
import type { RoleService } from '@/core/RoleService.js';
import { AvatarDecorationService } from '@/core/AvatarDecorationService.js';
import GetAvatarDecorationsEndpoint from '@/server/api/endpoints/get-avatar-decorations.js';

describe('AvatarDecorationService', () => {
	let find: ReturnType<typeof vi.fn>;
	let onMessage: (channel: string, data: string) => Promise<void>;
	let service: AvatarDecorationService;

	beforeEach(() => {
		find = vi.fn(async () => []);
		onMessage = async () => {};

		service = new AvatarDecorationService(
			{ url: 'https://local.example', host: 'local.example' } as unknown as Config,
			{
				on: (_event: string, listener: (channel: string, data: string) => Promise<void>) => {
					onMessage = listener;
				},
				off: vi.fn(),
			} as unknown as Redis.Redis,
			{
				find,
			} as unknown as AvatarDecorationsRepository,
			{} as IdService,
			{} as ModerationLogService,
			{} as GlobalEventService,
		);
	});

	test('the public endpoint reuses the local decoration cache until a change is published', async () => {
		find.mockResolvedValueOnce([{
			id: 'local1',
			name: 'Frame',
			description: '',
			url: 'https://local.example/frame.png',
			roleIdsThatCanBeUsedThisDecoration: ['public', 'private'],
		}]).mockResolvedValueOnce([]);
		const endpoint = new GetAvatarDecorationsEndpoint(service, {
			getRoles: async () => [{ id: 'public', isPublic: true }, { id: 'private', isPublic: false }],
		} as unknown as RoleService);

		const first = await endpoint.exec({}, null, null);
		const second = await endpoint.exec({}, null, null);

		expect(first[0].roleIdsThatCanBeUsedThisDecoration).toEqual(['public']);
		expect(second).toEqual(first);
		expect(find).toHaveBeenCalledTimes(1);

		await onMessage('', JSON.stringify({
			channel: 'internal',
			message: { type: 'avatarDecorationDeleted', body: { id: 'local1' } },
		}));

		expect(await endpoint.exec({}, null, null)).toEqual([]);
		expect(find).toHaveBeenCalledTimes(2);
	});

	test('does not cache an in-flight list after a change', async () => {
		const read = Promise.withResolvers<Partial<MiAvatarDecoration>[]>();
		find.mockReturnValueOnce(read.promise);
		const pending = service.getAll(false);

		await onMessage('', JSON.stringify({
			channel: 'internal',
			message: { type: 'avatarDecorationDeleted', body: { id: 'local1' } },
		}));
		read.resolve([{ id: 'local1' }]);
		await pending;

		expect(await service.getAll(false)).toEqual([]);
		expect(find).toHaveBeenCalledTimes(2);
	});
});
