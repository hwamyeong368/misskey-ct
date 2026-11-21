/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { ref } from 'vue';
import { describe, expect, test, vi } from 'vitest';
import { translateWithState } from '@/utility/translate-with-state.js';

describe('translation state', () => {
	test.each(['RATE_LIMIT_EXCEEDED', 'INTERNAL_ERROR'])('clears loading after %s and accepts a retry', async code => {
		const translation = ref<string | null>(null);
		const translating = ref(false);
		const request = vi.fn().mockRejectedValueOnce({ code }).mockResolvedValueOnce('Translated text');

		const pending = translateWithState(translation, translating, request);
		expect(translating.value).toBe(true);
		expect(await translateWithState(translation, translating, request)).toBe(false);
		expect(request).toHaveBeenCalledTimes(1);
		expect(await pending).toBe(false);
		expect(translating.value).toBe(false);
		expect(translation.value).toBeNull();

		expect(await translateWithState(translation, translating, request)).toBe(true);
		expect(translating.value).toBe(false);
		expect(translation.value).toBe('Translated text');
	});
});
