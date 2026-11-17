/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import type { Locale } from 'i18n';

function merge(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(overlay)) {
		const current = merged[key];
		merged[key] = value != null && typeof value === 'object' && !Array.isArray(value) && current != null && typeof current === 'object'
			? merge(current as Record<string, unknown>, value as Record<string, unknown>)
			: value;
	}
	return merged;
}

function read(path: string): Record<string, unknown> {
	return load(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

/** en-US as the note cleanup tests see it: ja-JP < locales/en-US.yml < the English cleanup fixture. */
export function loadNoteCleanupLocales(): Record<'en-US' | 'ko-KR' | 'ja-JP', Locale> {
	const ja = read('../../locales/ja-JP.yml');
	const ko = read('../../locales/ko-KR.yml');
	const en = merge(merge(ja, read('../../locales/en-US.yml')), read('./test/fixtures/note-cleanup.en-US.yml'));
	return { 'en-US': en as Locale, 'ko-KR': ko as Locale, 'ja-JP': ja as Locale };
}
