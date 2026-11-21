/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import pg from 'pg';
import { describe, expect, test, vi } from 'vitest';
import { loadConfig } from '@/config.js';
import { ModerationLogService } from '@/core/ModerationLogService.js';
import { ModerationLogEntityService } from '@/core/entities/ModerationLogEntityService.js';
import ShowModerationLogsEndpoint from '@/server/api/endpoints/admin/show-moderation-logs.js';
import type { ModerationLogsRepository } from '@/models/_.js';
import type { IdService } from '@/core/IdService.js';
import type { UserEntityService } from '@/core/entities/UserEntityService.js';
import type { ChatRoomIconEntityService } from '@/core/entities/ChatRoomIconEntityService.js';

const API_TOKEN = 'cf-turn-token-secret-value';
const NEW_API_TOKEN = 'cf-turn-token-replacement-value';

function createFixture() {
	const rows: Array<{ id: string; userId: string; type: string; info: Record<string, unknown> }> = [];
	const repository = {
		insert: vi.fn(async (row: { id: string; userId: string; type: string; info: Record<string, unknown> }) => {
			rows.push(row);
		}),
	} as unknown as ModerationLogsRepository;
	const idService = {
		gen: () => `log-${rows.length + 1}`,
		parse: () => ({ date: new Date('2026-11-01T00:00:00.000Z') }),
	} as unknown as IdService;
	const moderationLogService = new ModerationLogService(repository, idService);
	const entityService = new ModerationLogEntityService(
		repository,
		{ pack: async () => ({ id: 'admin' }) } as unknown as UserEntityService,
		idService,
		{ packDeletedRoom: (info: Record<string, unknown>) => info } as unknown as ChatRoomIconEntityService,
	);

	return { moderationLogService, entityService, rows };
}

describe('system webhook moderation logs', () => {
	test.each([
		['createSystemWebhook', { webhook: { name: 'Created', secret: API_TOKEN } }, { webhook: { name: 'Created' } }],
		['updateSystemWebhook', {
			before: { name: 'Before', secret: API_TOKEN },
			after: { name: 'After', secret: NEW_API_TOKEN },
		}, { before: { name: 'Before' }, after: { name: 'After' } }],
		['deleteSystemWebhook', { webhook: { name: 'Deleted', secret: API_TOKEN } }, { webhook: { name: 'Deleted' } }],
	] as const)('%s omits secrets when saving and reading', async (type, snapshots, expected) => {
		const { moderationLogService, entityService, rows } = createFixture();
		const info = { systemWebhookId: 'webhook1', ...snapshots };
		const redacted = { systemWebhookId: 'webhook1', ...expected };

		await moderationLogService.log({ id: 'admin' }, type, info as any);
		const stored = rows[0];
		const packed = await entityService.pack({ ...stored, user: null, info } as any);

		expect(stored.info).toEqual(redacted);
		expect(packed.info).toEqual(redacted);
		expect(JSON.stringify(info)).toContain(API_TOKEN);
	});
});

describe('searching moderation logs', () => {
	async function searchCondition(search: string): Promise<[string, Record<string, string>]> {
		const query: Record<string, any> = {
			andWhere: vi.fn((_sql: string, _parameters?: Record<string, string>) => query),
			limit: vi.fn(() => query),
			getMany: vi.fn(async () => []),
		};
		const endpoint = new (ShowModerationLogsEndpoint as any)(
			{ createQueryBuilder: () => query },
			{ packMany: async () => [] },
			{ makePaginationQuery: () => query },
		);

		await endpoint.exec({ search }, { id: 'admin' }, null);

		return (query.andWhere as ReturnType<typeof vi.fn>).mock.calls.find(([sql]) => String(sql).includes('ILIKE')) as [string, Record<string, string>];
	}

	test('excludes system webhook secrets from PostgreSQL search including non-object info shapes', async () => {
		const [where, parameters] = await searchCondition('needle');
		const config = loadConfig();
		const client = new pg.Client({ host: config.db.host, port: config.db.port, user: config.db.user, password: config.db.pass, database: config.db.db });
		await client.connect();
		try {
			const rows: [string, string, unknown][] = [
				['scalarInfo', 'updateSystemWebhook', 'needle'],
				['arrayInfo', 'updateSystemWebhook', ['needle']],
				['stringBefore', 'updateSystemWebhook', { before: 'needle', after: { name: 'hook' } }],
				['arrayBefore', 'updateSystemWebhook', { before: ['x'], after: { name: 'needle' } }],
				['webhookCreated', 'createSystemWebhook', { webhook: { name: 'created', secret: 'needle' } }],
				['webhookUpdated', 'updateSystemWebhook', { before: { name: 'before', secret: 'needle' }, after: { secret: 'needle' } }],
				['webhookDeleted', 'deleteSystemWebhook', { webhook: { name: 'deleted', secret: 'needle' } }],
				['webhookName', 'updateSystemWebhook', { before: null, after: { name: 'needle', secret: 'test' } }],
				['otherType', 'suspend', ['needle']],
			];
			const values = rows.map((_, i) => `($${i * 3 + 1}::varchar, $${i * 3 + 2}::varchar, $${i * 3 + 3}::jsonb)`).join(', ');
			const sql = `SELECT log.id FROM (VALUES ${values}) AS log(id, type, info) WHERE ${where.replace(':search', `$${rows.length * 3 + 1}`)} ORDER BY log.id`;

			const result = await client.query(sql, [...rows.flatMap(([id, type, info]) => [id, type, JSON.stringify(info)]), parameters.search]);

			expect(result.rows.map(row => row.id)).toEqual(['arrayBefore', 'arrayInfo', 'otherType', 'scalarInfo', 'stringBefore', 'webhookName']);
		} finally {
			await client.end();
		}
	});
});
