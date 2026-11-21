/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, assert, describe, test, vi, type MockInstance } from 'vitest';
import { cleanup, fireEvent, render, waitFor, type RenderResult } from '@testing-library/vue';
import { nextTick } from 'vue';
import * as Misskey from 'misskey-js';
import { directives } from '@/directives/index.js';
import { components } from '@/components/index.js';
import { prefer } from '@/preferences.js';
import { store } from '@/store.js';
import * as os from '@/os.js';
import * as accounts from '@/accounts.js';
import { i18n } from '@/i18n.js';
import * as sound from '@/utility/sound.js';

const { fakeMe } = vi.hoisted(() => ({
	fakeMe: {
		id: 'me',
		username: 'me',
		host: null,
		avatarUrl: 'https://example.com/avatar.png',
		isSilenced: false,
		isAdmin: false,
		isModerator: false,
		notesCount: 0,
		policies: {
			scheduledNoteLimit: 0,
			noteDraftLimit: 0,
		},
	},
}));

vi.mock('@/i.js', () => ({
	$i: fakeMe,
	iAmModerator: false,
	iAmAdmin: false,
	ensureSignin: () => fakeMe,
	notesCount: 0,
	incNotesCount: () => {},
}));

vi.mock('@/instance.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/instance.js')>()),
	instance: { maxNoteTextLength: 3000 },
}));

vi.mock('@/utility/misskey-api.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/utility/misskey-api.js')>()),
	// API応答が不要な呼び出しは、解決も拒否もしないPromiseを返す
	misskeyApi: vi.fn(() => new Promise(() => {})),
}));

vi.mock('@/utility/drive.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/utility/drive.js')>()),
	chooseDriveFile: vi.fn(),
	uploadFile: vi.fn(),
}));

const { chooseDriveFile, uploadFile } = await import('@/utility/drive.js');
const { misskeyApi } = await import('@/utility/misskey-api.js');
const { default: MkPostForm } = await import('@/components/MkPostForm.vue');

describe('MkPostForm', () => {
	const submitSelector = '[data-testid="post-form-submit"]';

	const driveFile = {
		id: 'drive-file-1',
		createdAt: '1970-01-01T00:00:00.000Z',
		name: 'photo.png',
		type: 'image/png',
		md5: '15eca7fba0480996e2245f5185bf39f2',
		size: 1,
		isSensitive: false,
		blurhash: null,
		properties: {},
		url: 'https://example.com/photo.png',
		thumbnailUrl: null,
		comment: null,
		folderId: null,
		folder: null,
		userId: 'me',
		user: null,
	} as unknown as Misskey.entities.DriveFile;

	const renderPostForm = (initialCw?: string): RenderResult => {
		return render(MkPostForm, {
			props: { autofocus: false, initialVisibility: 'public', initialLocalOnly: false, initialCw },
			global: {
				// v-panel はコンパイル済みテーマを前提とするので、テストでは no-op にする
				directives: { ...directives, panel: {} },
				components,
			},
		});
	};

	async function chooseAccountMenuItem(form: RenderResult, menu: MockInstance<typeof os.popupMenu>, text: string) {
		menu.mockClear();
		await fireEvent.click(form.container.querySelector('header button img')!.closest('button')!);
		await waitFor(() => assert.isNotEmpty(menu.mock.calls));
		const item = menu.mock.lastCall![0].find(item => item != null && 'text' in item && item.text === text);
		if (item == null || !('action' in item) || !item.action) assert.fail(`The account menu offers ${text}`);
		await item.action(new PointerEvent('click'));
	}

	async function chooseUploadMenuItem(form: RenderResult, menu: MockInstance<typeof os.popupMenu>, label: string, index = 0) {
		await fireEvent.click(form.container.querySelectorAll('[class*="itemActionWrapper"] button')[index]);
		const item = menu.mock.lastCall?.[0].find(item => item != null && 'text' in item && item.text === label);
		if (item == null || !('action' in item) || !item.action) assert.fail(`The upload menu offers ${label}`);
		void item.action(new PointerEvent('click'));
	}

	afterEach(() => {
		cleanup();
		localStorage.clear();
		fakeMe.isSilenced = false;
		fakeMe.policies.noteDraftLimit = 0;
		fakeMe.policies.scheduledNoteLimit = 0;
		prefer.s.keepCw = true;
		prefer.s.showPreview = false;
		vi.mocked(misskeyApi).mockReset();
		vi.mocked(misskeyApi).mockImplementation(() => new Promise(() => {}));
		vi.mocked(chooseDriveFile).mockReset();
		vi.mocked(uploadFile).mockReset();
		vi.restoreAllMocks();
	});

	test('uses the selected account for a menu upload and holds the account until it finishes', async () => {
		const alternate = { ...fakeMe, id: 'alternate', policies: { ...fakeMe.policies, maxFileSizeMb: 12 } } as unknown as Misskey.entities.MeDetailed;
		vi.spyOn(accounts, 'getAccounts').mockReturnValue([{ host: 'local.test', id: alternate.id, username: alternate.username, token: 'selected-session' }]);
		vi.spyOn(accounts, 'getAccountMenu').mockImplementation(async ({ onChoose }) => [{
			type: 'button', text: 'Alternate', action: () => onChoose?.(alternate),
		}]);
		const menu = vi.spyOn(os, 'popupMenu').mockResolvedValue();
		vi.spyOn(os, 'chooseFileFromPc').mockResolvedValue([new File(['contents'], 'attachment.txt', { type: 'text/plain' })]);
		let finish!: (file: Misskey.entities.DriveFile) => void;
		vi.mocked(uploadFile).mockReturnValue({ filePromise: new Promise(resolve => { finish = resolve; }), abort: vi.fn() });
		const form = renderPostForm();
		await fireEvent.click(form.container.querySelector('textarea')!);
		await chooseAccountMenuItem(form, menu, 'Alternate');
		await fireEvent.click(form.container.querySelector('.ti-photo-plus')!.closest('button')!);
		await waitFor(() => assert.exists(form.container.querySelector('[class*="itemThumbnail"]')));
		await chooseUploadMenuItem(form, menu, i18n.ts.upload);
		assert.propertyVal(vi.mocked(uploadFile).mock.lastCall?.[0], 'token', 'selected-session');
		assert.propertyVal(vi.mocked(uploadFile).mock.lastCall?.[0], 'maxSize', 12 * 1024 * 1024);
		await waitFor(() => assert.isTrue(form.container.querySelector('header button img')!.closest('button')!.disabled));
		finish(driveFile);
		await waitFor(() => assert.isFalse(form.container.querySelector('header button img')!.closest('button')!.disabled));
	});

	test('skips a removed waiting item and uploads the remaining item in order', async () => {
		const menu = vi.spyOn(os, 'popupMenu').mockResolvedValue();
		vi.spyOn(os, 'chooseFileFromPc').mockResolvedValue([
			new File(['first'], 'first.txt', { type: 'text/plain' }),
			new File(['second'], 'second.txt', { type: 'text/plain' }),
			new File(['third'], 'third.txt', { type: 'text/plain' }),
		]);
		let finishFirst!: (file: Misskey.entities.DriveFile) => void;
		let finishThird!: (file: Misskey.entities.DriveFile) => void;
		vi.mocked(uploadFile)
			.mockReturnValueOnce({ filePromise: new Promise(resolve => { finishFirst = resolve; }), abort: vi.fn() })
			.mockReturnValueOnce({ filePromise: new Promise(resolve => { finishThird = resolve; }), abort: vi.fn() });
		const form = renderPostForm();
		await fireEvent.click(form.container.querySelector('textarea')!);
		await fireEvent.click(form.container.querySelector('.ti-photo-plus')!.closest('button')!);
		await waitFor(() => assert.strictEqual(form.container.querySelectorAll('[class*="itemActionWrapper"] button').length, 3));
		await chooseUploadMenuItem(form, menu, i18n.ts.upload, 0);
		await chooseUploadMenuItem(form, menu, i18n.ts.upload, 1);
		await chooseUploadMenuItem(form, menu, i18n.ts.upload, 2);
		await chooseUploadMenuItem(form, menu, i18n.ts.cancel, 1);
		finishFirst(driveFile);
		await waitFor(() => assert.strictEqual(vi.mocked(uploadFile).mock.calls.length, 2));
		assert.strictEqual(vi.mocked(uploadFile).mock.calls[1][0].file.name, 'third.txt');
		finishThird({ ...driveFile, id: 'drive-file-3' });
		await waitFor(() => assert.isFalse(form.container.querySelector('header button img')!.closest('button')!.disabled));
	});

	test('opens a legacy local draft with its attachment account selected', async () => {
		const alternate = { ...fakeMe, id: 'alternate' } as unknown as Misskey.entities.MeDetailed;
		vi.spyOn(accounts, 'getAccounts').mockReturnValue([{ host: 'local.test', id: alternate.id, username: alternate.username, token: 'selected-session' }]);
		vi.mocked(misskeyApi).mockImplementation(endpoint => endpoint === 'i' ? Promise.resolve(alternate) : new Promise(() => {}));
		localStorage.setItem('drafts', JSON.stringify({
			'note:me': { data: { text: 'Local draft', visibility: 'public', files: [driveFile], attachmentAccountId: alternate.id } },
		}));
		const form = renderPostForm();
		const textarea = form.container.querySelector('textarea')!;
		await waitFor(() => assert.strictEqual(textarea.value, 'Local draft'));
		await fireEvent.click(textarea);
		await fireEvent.click(form.container.querySelector(submitSelector)!);
		await waitFor(() => {
			const call = vi.mocked(misskeyApi).mock.calls.find(([endpoint]) => endpoint === 'notes/create');
			assert.strictEqual(call?.[2], 'selected-session');
			assert.deepPropertyVal(call?.[1], 'fileIds', [driveFile.id]);
		});
	});

	test('explicit reset clears the CW title even when keepCw is enabled', async () => {
		prefer.s.keepCw = true;
		const form = renderPostForm('Initial CW');
		const cwInput = form.container.querySelector<HTMLInputElement>('input[name="search"]')!;
		const textarea = form.container.querySelector('textarea')!;
		assert.strictEqual(cwInput.value, 'Initial CW');
		await fireEvent.click(textarea);
		const menu = vi.spyOn(os, 'popupMenu').mockResolvedValue();
		await fireEvent.click(form.container.querySelector('.ti-dots')!.closest('button')!);
		await waitFor(() => assert.isNotEmpty(menu.mock.calls));
		const clearItem = menu.mock.lastCall![0].find(item => item != null && 'text' in item && item.text === i18n.ts.clear);
		if (clearItem == null || !('action' in clearItem) || !clearItem.action) assert.fail('clear option exists');
		await clearItem.action(new PointerEvent('click'));
		await nextTick();
		assert.strictEqual(cwInput.value, '');
	});

	test('attaches a file chosen from the drive', async () => {
		vi.mocked(chooseDriveFile).mockResolvedValue([driveFile]);
		vi.spyOn(sound, 'playMisskeySfx').mockImplementation(() => {});
		store.s.sound_masterVolume = 0;
		const form = renderPostForm();
		const textarea = form.container.querySelector('textarea')!;
		await fireEvent.click(textarea);
		await fireEvent.click(form.container.querySelector('.ti-cloud-download')!.closest('button')!);
		await waitFor(() => {
			assert.isFalse(form.container.querySelector<HTMLButtonElement>(submitSelector)!.disabled);
		});
		await fireEvent.click(form.container.querySelector(submitSelector)!);
		await waitFor(() => {
			const call = vi.mocked(misskeyApi).mock.calls.find(([endpoint]) => endpoint === 'notes/create');
			assert.exists(call);
			assert.deepPropertyVal(call?.[1], 'fileIds', [driveFile.id]);
		});
	});
});
