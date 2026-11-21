/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import detectLanguage, { isForeignNoteLanguage } from '@/utility/detect-language.js';

describe('detect-language', () => {
	const korean = '오늘은 날씨가 아주 좋아서 친구와 산책을 했어요. 다음 주에도 함께 공원에 가기로 했습니다.';
	const english = 'The weather is nice today, so I went for a walk with a friend in the park.';

	test('detects language from plain text and strips non-text MFM nodes', () => {
		expect(detectLanguage(korean)).toBe('ko');
		expect(detectLanguage(english)).toBe('en');
		expect(detectLanguage(`@alice@example.com ${korean} https://example.com #tag :emoji:`)).toBe('ko');
		expect(detectLanguage(`> ${english}`)).toBe('en');
		expect(detectLanguage('1234')).toBe('');
	});

	test('uses the body language for a note without a poll', () => {
		expect(isForeignNoteLanguage({ text: korean, poll: undefined }, 'ko')).toBe(false);
		expect(isForeignNoteLanguage({ text: korean, poll: undefined }, 'en')).toBe(true);
		expect(isForeignNoteLanguage({ text: '1234', poll: undefined }, 'ko')).toBe(false);
		expect(isForeignNoteLanguage({ text: null, poll: undefined }, 'ko')).toBe(false);
	});

	test('detects a foreign language in the choices of a real poll', () => {
		expect(isForeignNoteLanguage({
			text: korean,
			poll: { multiple: false, expiresAt: null, choices: [{ text: english, votes: 0, isVoted: false }] },
		}, 'ko')).toBe(true);
	});
});
