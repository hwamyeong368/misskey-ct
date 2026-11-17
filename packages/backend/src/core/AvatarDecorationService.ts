/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import * as Redis from 'ioredis';
import { In } from 'typeorm';
import type { AvatarDecorationsRepository, MiAvatarDecoration, MiUser } from '@/models/_.js';
import { IdService } from '@/core/IdService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import { MemorySingleCache } from '@/misc/cache.js';
import type { GlobalEvents } from '@/core/GlobalEventService.js';
import { ModerationLogService } from '@/core/ModerationLogService.js';
import { appendQuery, query } from '@/misc/prelude/url.js';
import type { Config } from '@/config.js';
import { normalizeAvatarDecoration } from '@/core/avatar-decoration.js';
import { checkHttps } from '@/misc/check-https.js';
import { isStorableText } from '@/core/chat-room-channels.js';

@Injectable()
export class AvatarDecorationService implements OnApplicationShutdown {
	public cache: MemorySingleCache<MiAvatarDecoration[]>;

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.redisForSub)
		private redisForSub: Redis.Redis,

		@Inject(DI.avatarDecorationsRepository)
		private avatarDecorationsRepository: AvatarDecorationsRepository,

		private idService: IdService,
		private moderationLogService: ModerationLogService,
		private globalEventService: GlobalEventService,
	) {
		this.cache = new MemorySingleCache<MiAvatarDecoration[]>(1000 * 60 * 30); // 30s

		this.redisForSub.on('message', this.onMessage);
	}

	@bindThis
	private async onMessage(_: string, data: string): Promise<void> {
		const obj = JSON.parse(data);

		if (obj.channel === 'internal') {
			const { type, body: _ } = obj.message as GlobalEvents['internal']['payload'];
			switch (type) {
				case 'avatarDecorationCreated':
				case 'avatarDecorationUpdated':
				case 'avatarDecorationDeleted': {
					this.cache.delete();
					break;
				}
				default:
					break;
			}
		}
	}

	@bindThis
	public async create(options: Partial<MiAvatarDecoration>, moderator?: MiUser): Promise<MiAvatarDecoration> {
		const created = await this.avatarDecorationsRepository.insertOne({
			id: this.idService.gen(),
			...options,
		});

		this.globalEventService.publishInternalEvent('avatarDecorationCreated', created);

		if (moderator) {
			this.moderationLogService.log(moderator, 'createAvatarDecoration', {
				avatarDecorationId: created.id,
				avatarDecoration: created,
			});
		}

		return created;
	}

	@bindThis
	public async update(id: MiAvatarDecoration['id'], params: Partial<MiAvatarDecoration>, moderator?: MiUser): Promise<void> {
		const avatarDecoration = await this.avatarDecorationsRepository.findOneByOrFail({ id });

		const date = new Date();
		await this.avatarDecorationsRepository.update(avatarDecoration.id, {
			updatedAt: date,
			...params,
		});

		const updated = await this.avatarDecorationsRepository.findOneByOrFail({ id: avatarDecoration.id });
		this.globalEventService.publishInternalEvent('avatarDecorationUpdated', updated);

		if (moderator) {
			this.moderationLogService.log(moderator, 'updateAvatarDecoration', {
				avatarDecorationId: avatarDecoration.id,
				before: avatarDecoration,
				after: updated,
			});
		}
	}

	@bindThis
	public getProxiedUrl(url: string, mode?: 'static' | 'avatar'): string {
		return appendQuery(
			`${this.config.mediaProxy}/${mode ?? 'image'}.webp`,
			query({
				url,
				...(mode ? { [mode]: '1' } : {}),
			}),
		);
	}

	/**
	 * 그룹처럼 방금 만든 장식을 바로 보여 주어야 하는 곳에서 쓴다.
	 * getAll의 캐시는 다른 프로세스가 만든 장식을 몰라서 캐시를 거치지 않고 id로 직접 읽는다.
	 */
	@bindThis
	public async findByIds(ids: MiAvatarDecoration['id'][]): Promise<MiAvatarDecoration[]> {
		if (ids.length === 0) return [];
		return this.avatarDecorationsRepository.findBy({ id: In(ids) });
	}

	/**
	 * CT: 다른 서버 장식은 RemoteAvatarDecorationService처럼 원본 주소(url)를 항목에 그대로 담아 두므로,
	 * url이 있는 항목은 프록시 주소로, 없는 항목은 이 서버의 장식으로 푼다.
	 */
	@bindThis
	public async pack(used: MiUser['avatarDecorations']) {
		if (used.length === 0) return [];
		const decorations = await this.findByIds(used.filter(d => d.url == null).map(d => d.id));
		return used.flatMap(d => {
			const url = d.url != null ? this.getProxiedUrl(d.url, 'avatar') : decorations.find(item => item.id === d.id)?.url;
			return url == null ? [] : [{
				id: d.id, angle: d.angle || undefined, flipH: d.flipH || undefined,
				offsetX: d.offsetX || undefined, offsetY: d.offsetY || undefined,
				scale: d.scale || undefined, opacity: d.opacity || undefined, url,
			}];
		});
	}

	/** CT: 다른 서버 그룹 아이콘의 장식은 DB에 등록하지 않고 원본 주소를 항목에 담아 둔다. */
	@bindThis
	public async resolveChatDecorations(host: string, value: unknown): Promise<MiUser['avatarDecorations'] | undefined> {
		if (!Array.isArray(value) || value.length > 16) return undefined;
		const result: MiUser['avatarDecorations'] = [];
		for (const item of value) {
			if (item == null || typeof item !== 'object' || typeof item.id !== 'string' || item.id.length === 0 || item.id.length > 32 || !isStorableText(item.id)) continue;
			if (typeof item.url !== 'string' || item.url.length > 4096 || !isStorableText(item.url) || !checkHttps(item.url)) continue;
			try {
				const url = new URL(item.url);
				if (url.username || url.password || this.getProxiedUrl(item.url, 'avatar').length > 1024) continue;
			} catch {
				continue;
			}
			if (item.flipH != null && typeof item.flipH !== 'boolean') continue;
			const ranges = { angle: [-0.5, 0.5], offsetX: [-0.25, 0.25], offsetY: [-0.25, 0.25], scale: [0.5, 1.5], opacity: [0.1, 1] };
			if (Object.entries(ranges).some(([key, [min, max]]) => item[key] != null && (typeof item[key] !== 'number' || !Number.isFinite(item[key]) || item[key] < min || item[key] > max))) continue;
			result.push({ ...normalizeAvatarDecoration({ id: item.id, angle: item.angle, flipH: item.flipH, offsetX: item.offsetX, offsetY: item.offsetY, scale: item.scale, opacity: item.opacity }), url: item.url });
		}
		return result;
	}

	@bindThis
	public async delete(id: MiAvatarDecoration['id'], moderator?: MiUser): Promise<void> {
		const avatarDecoration = await this.avatarDecorationsRepository.findOneByOrFail({ id });

		await this.avatarDecorationsRepository.delete({ id: avatarDecoration.id });
		this.globalEventService.publishInternalEvent('avatarDecorationDeleted', avatarDecoration);

		if (moderator) {
			this.moderationLogService.log(moderator, 'deleteAvatarDecoration', {
				avatarDecorationId: avatarDecoration.id,
				avatarDecoration: avatarDecoration,
			});
		}
	}

	@bindThis
	public async getAll(noCache = false): Promise<MiAvatarDecoration[]> {
		if (noCache) {
			this.cache.delete();
		}
		return this.cache.fetch(() => this.avatarDecorationsRepository.find());
	}

	@bindThis
	public dispose(): void {
		this.redisForSub.off('message', this.onMessage);
	}

	@bindThis
	public onApplicationShutdown(signal?: string | undefined): void {
		this.dispose();
	}
}
