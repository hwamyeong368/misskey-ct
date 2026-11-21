/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/vue';
import type * as Misskey from 'misskey-js';
import { preferState } from '../setup.unit.js';
import MkDriveFileThumbnail from '@/components/MkDriveFileThumbnail.vue';

vi.mock('@/components/MkImgWithBlurhash.vue', () => ({
	default: { props: ['src', 'forceBlurhash'], template: '<img :src="src ?? undefined" />' },
}));

const video = {
	id: 'video', name: 'video.mp4', type: 'video/mp4', isSensitive: false,
	url: 'https://example.com/video.mp4',
	thumbnailUrl: 'https://example.com/thumbnail.webp',
} as Misskey.entities.DriveFile;

const remoteVideo = { ...video, thumbnailUrl: null } as Misskey.entities.DriveFile;

beforeEach(() => {
	Object.assign(preferState, {
		enableHighQualityImagePlaceholders: true,
	});
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

test.each([true, false])('video previews render their thumbnail (blurhash: %s)', (enableHighQualityImagePlaceholders) => {
	preferState.enableHighQualityImagePlaceholders = enableHighQualityImagePlaceholders;
	const { container } = render(MkDriveFileThumbnail, {
		props: { file: video, fit: 'cover' }, global: { directives: { panel: {} } },
	});
	expect(container.querySelector('img')?.getAttribute('src')).toBe(video.thumbnailUrl);
});

test.each([true, false])('videos without a thumbnail fall back to the video icon (blurhash: %s)', (enableHighQualityImagePlaceholders) => {
	preferState.enableHighQualityImagePlaceholders = enableHighQualityImagePlaceholders;
	const { container } = render(MkDriveFileThumbnail, {
		props: { file: remoteVideo, fit: 'cover' }, global: { directives: { panel: {} } },
	});
	expect(container.querySelector('img[src], video[src]')).toBeNull();
	expect(container.querySelector('.ti-video')).not.toBeNull();
});

test.each([true, false])('covered thumbnails have no image source (blurhash: %s)', (enableHighQualityImagePlaceholders) => {
	preferState.enableHighQualityImagePlaceholders = enableHighQualityImagePlaceholders;
	const file = { ...video, isSensitive: true };
	const { container } = render(MkDriveFileThumbnail, {
		props: { file, fit: 'cover', forceBlurhash: true }, global: { directives: { panel: {} } },
	});

	expect(container.querySelector('img[src], video[src]')).toBeNull();
});
