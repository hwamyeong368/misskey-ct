/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'assert';
import { beforeAll, describe, test } from 'vitest';
import { api, connectStream, createAppToken, signup, successfulApiCall } from '../utils.js';
import type { UserToken } from '../utils.js';

type User = Awaited<ReturnType<typeof signup>>;

const waitUntil = async <T>(fn: () => Promise<T | null | undefined | false>): Promise<T | null> => {
	for (let i = 0; i < 60; i++) {
		const v = await fn();
		if (v) return v;
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	return null;
};

describe('通知の取得', () => {
	let alice: User;
	let bob: User;
	let appToken: UserToken;

	const signin = async () => {
		const res = await api('signin-flow', { username: 'notifpackalice', password: 'test' } as any);
		assert.strictEqual(res.status, 200, JSON.stringify(res.body));
	};

	beforeAll(async () => {
		alice = await signup({ username: 'notifpackalice' });
		bob = await signup({ username: 'notifpackbob' });
		appToken = { token: await createAppToken(alice, ['read:notifications', 'read:account']), bearer: true } as UserToken;
	});

	describe('ログイン記録ストリーム', () => {
		test('ログイン記録のストリームイベントは本人のセッションだけに届く', async () => {
			const ownSignins: { ip: string; headers: Record<string, unknown> }[] = [];
			const appEvents: string[] = [];
			const ownSocket = await connectStream(alice, 'main', msg => {
				if (msg.type === 'signin') ownSignins.push(msg.body);
			});
			const appSocket = await connectStream(appToken, 'main', msg => { appEvents.push(msg.type); });
			try {
				await signin();
				const record = await waitUntil(async () => ownSignins[0]);
				assert.ok(record);
				assert.strictEqual(typeof record.ip, 'string');
				assert.strictEqual(record.headers['content-type'], 'application/json');

				await successfulApiCall({ endpoint: 'following/create', parameters: { userId: alice.id }, user: bob });
				assert.ok(await waitUntil(async () => appEvents.includes('followed')));
				assert.ok(!appEvents.includes('signin'));
			} finally {
				ownSocket.close();
				appSocket.close();
			}
		});
	});
});
