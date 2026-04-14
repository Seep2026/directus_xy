import { createI18n, I18nOptions } from 'vue-i18n';
import availableLanguages from './available-languages.yaml';
import datetimeFormats from './date-formats.yaml';
import numberFormats from './number-formats.yaml';
import enUSBase from './translations/en-US.yaml';
import zhCNBase from './translations/zh-CN.yaml';
import zhCNNewMedia from '../../../scripts/new-media/i18n/zh-CN.json';
import { RequestError } from '@/api';

const zhCNMessages = {
	...zhCNBase,
	...zhCNNewMedia,
};

export const i18n = createI18n({
	legacy: false,
	locale: 'zh-CN',
	fallbackLocale: 'en-US',
	messages: {
		'en-US': enUSBase,
		'zh-CN': zhCNMessages,
	} as I18nOptions['messages'],
	silentTranslationWarn: true,
	datetimeFormats,
	numberFormats,
});

export type Language = keyof typeof availableLanguages;

export const loadedLanguages: Language[] = ['en-US', 'zh-CN'];

export function translateAPIError(error: RequestError | string): string {
	const defaultMsg = i18n.global.t('unexpected_error');

	let code = error;

	if (typeof error === 'object') {
		code = error?.response?.data?.errors?.[0]?.extensions?.code;
	}

	if (!error || !code) return defaultMsg;

	const key = `errors.${code}`;
	const exists = i18n.global.te(key);

	if (exists === false) return defaultMsg;

	return i18n.global.t(key);
}
