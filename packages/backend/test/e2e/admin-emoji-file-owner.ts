/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'assert';
import { describe, beforeAll, test } from 'vitest';
import { api, signup, uploadFile } from '../utils.js';
import type * as Misskey from 'misskey-js';

describe('커스텀 이모지 등록·수정의 파일 소유자', () => {
	let root: Misskey.entities.SignupResponse;
	let alice: Misskey.entities.SignupResponse;
	let bob: Misskey.entities.SignupResponse;

	const upload = async (user: Misskey.entities.SignupResponse, name: string): Promise<Misskey.entities.DriveFile> => {
		const res = await uploadFile(user, { name });
		assert.strictEqual(res.status, 200);
		assert.ok(res.body);
		return res.body;
	};

	const fileExists = async (user: Misskey.entities.SignupResponse, fileId: string): Promise<boolean> => {
		const res = await api('drive/files/show', { fileId }, user);
		return res.status === 200;
	};

	beforeAll(async () => {
		root = await signup({ username: 'root' });
		alice = await signup({ username: 'alice' });
		bob = await signup({ username: 'bob' });
	});

	test('다른 사용자가 올린 파일로 관리자가 이모지를 등록할 수 있고 원본 파일은 남는다', async () => {
		const file = await upload(alice, 'owner-add.jpg');

		const res = await api('admin/emoji/add', { name: 'owner_add', fileId: file.id }, root);
		assert.strictEqual(res.status, 200, JSON.stringify(res.body));

		const list = await api('admin/emoji/list', { query: 'owner_add' }, root);
		assert.strictEqual(list.status, 200);
		const emoji = list.body.find(e => e.name === 'owner_add');
		assert.ok(emoji);
		// CT의 CustomEmojiService는 원본 파일을 재업로드하지 않고 URL을 그대로 사용한다
		assert.strictEqual(emoji.url, file.url);

		assert.strictEqual(await fileExists(alice, file.id), true);
	});

	test('이모지의 파일을 다른 사용자 소유 파일로 바꿀 수 있고 원본 파일은 남는다', async () => {
		const first = await upload(root, 'owner-update-1.jpg');
		const added = await api('admin/emoji/add', { name: 'owner_update', fileId: first.id }, root);
		assert.strictEqual(added.status, 200, JSON.stringify(added.body));

		const list = await api('admin/emoji/list', { query: 'owner_update' }, root);
		assert.strictEqual(list.status, 200);
		const emoji = list.body.find(e => e.name === 'owner_update');
		assert.ok(emoji);
		assert.strictEqual(emoji.url, first.url);
		// CT의 CustomEmojiService는 등록 시 원본 파일을 삭제하지 않는다
		assert.strictEqual(await fileExists(root, first.id), true);

		const second = await upload(bob, 'owner-update-2.jpg');
		const res = await api('admin/emoji/update', { id: emoji.id, name: 'owner_update', fileId: second.id }, root);
		assert.strictEqual(res.status, 204, JSON.stringify(res.body));

		const after = await api('admin/emoji/list', { query: 'owner_update' }, root);
		assert.strictEqual(after.status, 200);
		const updated = after.body.find(e => e.id === emoji.id);
		assert.ok(updated);
		assert.notStrictEqual(updated.url, emoji.url);
		assert.strictEqual(updated.url, second.url);
		assert.strictEqual(await fileExists(bob, second.id), true);
	});
});
