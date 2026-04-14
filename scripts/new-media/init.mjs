#!/usr/bin/env node

import { readFile } from 'node:fs/promises';

const API_URL = process.env.DIRECTUS_URL ?? 'http://localhost:8055';
const ADMIN_EMAIL = process.env.DIRECTUS_ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.DIRECTUS_ADMIN_PASSWORD ?? 'admin12345678';
const DEFAULT_LANGUAGE = 'zh-CN';

const CREATOR_EMAIL = 'creator@example.com';
const REVIEWER_EMAIL = 'reviewer@example.com';
const DEMO_PASSWORD = process.env.NEW_MEDIA_DEMO_PASSWORD ?? 'Demo@123456';
const ENABLE_CONTENT_SAMPLE_DATA =
	parseBoolean(process.env.NEW_MEDIA_SEED_CONTENT_DEMO) || parseBoolean(process.env.NEW_MEDIA_SEED_DEMO_DATA);

const CREATOR_ROLE_NAME = '内容创作者';
const REVIEWER_ROLE_NAME = '审核者';
const DEFAULT_PRODUCT_NAME = '新媒体内容中台';
const DEFAULT_PRODUCT_VERSION = '1.3';

const COLLECTIONS = {
	signals: 'nm_signals',
	contentCards: 'nm_content_cards',
	versions: 'nm_content_versions',
	sources: 'nm_sources',
	assets: 'nm_assets',
};

const DEFAULT_COLLECTION_DISPLAY_ORDER = [
	COLLECTIONS.sources,
	COLLECTIONS.signals,
	COLLECTIONS.contentCards,
	COLLECTIONS.assets,
	COLLECTIONS.versions,
];

const STATUS = {
	draft: 'draft',
	inReview: 'in_review',
	approved: 'approved',
	archived: 'archived',
	watching: 'watching',
	pending: 'pending',
	adopted: 'adopted',
	rejected: 'rejected',
};
let accessToken = '';
let productInfo = {
	name: DEFAULT_PRODUCT_NAME,
	version: DEFAULT_PRODUCT_VERSION,
	fullTitle: `${DEFAULT_PRODUCT_NAME} ${DEFAULT_PRODUCT_VERSION}`,
	collectionOrder: DEFAULT_COLLECTION_DISPLAY_ORDER,
};

const state = {
	creatorRoleId: '',
	reviewerRoleId: '',
	creatorPolicyId: '',
	reviewerPolicyId: '',
	creatorUserId: '',
	reviewerUserId: '',
	adminUserId: '',
};

main().catch((error) => {
	console.error('\n[init:new-media] 初始化失败');
	console.error(error);
	process.exit(1);
});

async function main() {
	console.log('[init:new-media] 登录管理员账号...');
	await loginAsAdmin();
	productInfo = await loadProductInfo();

	await updateProjectName();
	await ensureCustomTranslations();
	await ensureCollections();
	await ensureCollectionDisplayOrder();
	await ensureFields();
	await ensureFieldTranslations();
	await ensureRelations();
	await ensureV11Compatibility();
	await ensureRolesAndPolicies();
	await ensureUsers();
	await ensurePermissions();
	await ensureDashboard();
	await maybeSeedContentSampleData();

	console.log('\n[init:new-media] 完成 ✅');
	console.log(`[init:new-media] 管理员: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
	console.log(`[init:new-media] 创作者: ${CREATOR_EMAIL} / ${DEMO_PASSWORD}`);
	console.log(`[init:new-media] 审核者: ${REVIEWER_EMAIL} / ${DEMO_PASSWORD}`);
}

async function loginAsAdmin() {
	const response = await api('POST', '/auth/login', {
		auth: false,
		body: {
			email: ADMIN_EMAIL,
			password: ADMIN_PASSWORD,
			mode: 'json',
		},
	});

	accessToken = response?.data?.access_token ?? '';

	if (!accessToken) {
		throw new Error('管理员登录失败，未获取到 access token。');
	}

	const me = await api('GET', '/users/me', { query: { fields: ['id'] } });
	state.adminUserId = me?.data?.id;
}

async function updateProjectName() {
	console.log('[init:new-media] 设置项目名称与默认语言...');
	await api('PATCH', '/settings', {
		body: {
			project_name: productInfo.fullTitle,
			default_language: DEFAULT_LANGUAGE,
		},
	});
}

async function loadProductInfo() {
	try {
		const file = new URL('../../app/package.json', import.meta.url);
		const content = await readFile(file, 'utf-8');
		const packageJson = JSON.parse(content);

		const name = getText(packageJson?.newMedia?.productName) || DEFAULT_PRODUCT_NAME;
		const version = getText(packageJson?.newMedia?.productVersion) || DEFAULT_PRODUCT_VERSION;
		const fullTitle = `${name}${version ? ` ${version}` : ''}`;
		const collectionOrder = Array.isArray(packageJson?.newMedia?.collectionOrder)
			? packageJson.newMedia.collectionOrder.filter((item) => typeof item === 'string' && item.length > 0)
			: [];

		return {
			name,
			version,
			fullTitle,
			collectionOrder: collectionOrder.length > 0 ? collectionOrder : DEFAULT_COLLECTION_DISPLAY_ORDER,
		};
	} catch {
		return {
			name: DEFAULT_PRODUCT_NAME,
			version: DEFAULT_PRODUCT_VERSION,
			fullTitle: `${DEFAULT_PRODUCT_NAME} ${DEFAULT_PRODUCT_VERSION}`,
			collectionOrder: DEFAULT_COLLECTION_DISPLAY_ORDER,
		};
	}
}

async function ensureCustomTranslations() {
	console.log('[init:new-media] 写入自定义 i18n 文案包...');

	const bundle = await loadTranslationBundle(DEFAULT_LANGUAGE);
	const existingResponse = await api('GET', '/translations', {
		query: { fields: ['id', 'key', 'language', 'value'], limit: -1 },
	});

	const existing = new Map((existingResponse?.data ?? []).map((item) => [`${item.language}::${item.key}`, item]));

	for (const [key, value] of Object.entries(bundle)) {
		const mapKey = `${DEFAULT_LANGUAGE}::${key}`;
		const current = existing.get(mapKey);

		if (!current) {
			await api('POST', '/translations', {
				body: {
					key,
					language: DEFAULT_LANGUAGE,
					value,
				},
			});
			continue;
		}

		if (current.value !== value) {
			await api('PATCH', `/translations/${current.id}`, {
				body: { value },
			});
		}
	}
}

async function loadTranslationBundle(language) {
	const file = new URL(`./i18n/${language}.json`, import.meta.url);
	const content = await readFile(file, 'utf-8');
	return JSON.parse(content);
}

async function ensureCollections() {
	console.log('[init:new-media] 创建/校验集合...');

	await ensureCollection(COLLECTIONS.signals, {
		icon: 'tips_and_updates',
		note: '信号池',
		translation: '信号池',
	});

	await ensureCollection(COLLECTIONS.contentCards, {
		icon: 'article',
		note: '内容卡',
		translation: '内容卡',
		archive_field: 'status',
		archive_app_filter: true,
		archive_value: STATUS.archived,
		unarchive_value: STATUS.draft,
	});

	await ensureCollection(COLLECTIONS.versions, {
		icon: 'history',
		note: '版本记录',
		translation: '版本记录',
	});

	await ensureCollection(COLLECTIONS.sources, {
		icon: 'hub',
		note: '来源库',
		translation: '来源库',
	});

	await ensureCollection(COLLECTIONS.assets, {
		icon: 'perm_media',
		note: '资产库',
		translation: '资产库',
	});
}

async function ensureCollectionDisplayOrder() {
	console.log('[init:new-media] 同步集合导航顺序...');

	for (const [index, collection] of productInfo.collectionOrder.entries()) {
		const response = await api('GET', `/collections/${collection}`, {
			allow404: true,
			allow403: true,
		});

		const existing = response?.data;
		if (!existing?.meta) continue;

		const targetSort = index + 1;
		if (existing.meta.sort === targetSort) continue;

		await api('PATCH', `/collections/${collection}`, {
			body: {
				meta: {
					...existing.meta,
					sort: targetSort,
				},
			},
		});
	}
}

async function ensureFields() {
	console.log('[init:new-media] 创建/校验字段...');

	const signalChoices = [
		{ text: '$t:new_media_source_type_tech_site', value: 'tech_site' },
		{ text: '$t:new_media_source_type_youtube', value: 'youtube' },
		{ text: '$t:new_media_source_type_twitter', value: 'twitter' },
		{ text: '$t:new_media_source_type_wechat', value: 'wechat' },
		{ text: '$t:new_media_source_type_report', value: 'report' },
		{ text: '$t:new_media_source_type_kol', value: 'kol' },
		{ text: '$t:new_media_source_type_other', value: 'other' },
	];

	const directionChoices = [
		{ text: '$t:new_media_direction_anchor', value: 'anchor' },
		{ text: '$t:new_media_direction_breakout', value: 'breakout' },
		{ text: '$t:new_media_direction_convert', value: 'convert' },
	];

	const signalStatusChoices = [
		{ text: '$t:new_media_signal_status_watching', value: STATUS.watching },
		{ text: '$t:new_media_signal_status_pending', value: STATUS.pending },
		{ text: '$t:new_media_signal_status_adopted', value: STATUS.adopted },
		{ text: '$t:new_media_signal_status_rejected', value: STATUS.rejected },
	];

	const signalTypeChoices = [
		{ text: '$t:new_media_signal_type_article', value: 'article' },
		{ text: '$t:new_media_signal_type_video', value: 'video' },
		{ text: '$t:new_media_signal_type_tweet', value: 'tweet' },
		{ text: '$t:new_media_signal_type_report', value: 'report' },
		{ text: '$t:new_media_signal_type_announcement', value: 'announcement' },
		{ text: '$t:new_media_signal_type_other', value: 'other' },
	];

	const contentTypeChoices = [
		{ text: '$t:new_media_content_type_brand', value: 'brand' },
		{ text: '$t:new_media_content_type_awareness', value: 'awareness' },
		{ text: '$t:new_media_content_type_solution', value: 'solution' },
		{ text: '$t:new_media_content_type_product', value: 'product' },
		{ text: '$t:new_media_content_type_case', value: 'case' },
	];

	const channelChoices = [
		{ text: '$t:new_media_channel_article', value: 'article' },
		{ text: '$t:new_media_channel_short_post', value: 'short_post' },
		{ text: '$t:new_media_channel_video_script', value: 'video_script' },
	];

	const contentStatusChoices = [
		{ text: '$t:new_media_content_status_draft', value: STATUS.draft },
		{ text: '$t:new_media_content_status_in_review', value: STATUS.inReview },
		{ text: '$t:new_media_content_status_approved', value: STATUS.approved },
		{ text: '$t:new_media_content_status_archived', value: STATUS.archived },
	];

	const versionTypeChoices = [
		{ text: '$t:new_media_version_type_draft', value: 'draft' },
		{ text: '$t:new_media_version_type_submission', value: 'submission' },
		{ text: '$t:new_media_version_type_rejected', value: 'rejected' },
		{ text: '$t:new_media_version_type_approved', value: 'approved' },
	];

	const assetTypeChoices = [
		{ text: '$t:new_media_asset_type_cover', value: 'cover' },
		{ text: '$t:new_media_asset_type_image', value: 'image' },
		{ text: '$t:new_media_asset_type_long_image', value: 'long_image' },
		{ text: '$t:new_media_asset_type_screenshot', value: 'screenshot' },
		{ text: '$t:new_media_asset_type_video_cover', value: 'video_cover' },
		{ text: '$t:new_media_asset_type_other', value: 'other' },
	];

	await ensureField(COLLECTIONS.signals, {
		field: 'title',
		type: 'string',
		meta: {
			interface: 'input',
			width: 'half',
			note: '兼容字段（请使用 signal_title）',
			hidden: true,
			required: false,
		},
		schema: { max_length: 255, nullable: true },
	});

	await ensureField(COLLECTIONS.signals, {
		field: 'signal_title',
		type: 'string',
		meta: { interface: 'input', width: 'full', required: true, note: '信号标题（1.1 主字段）' },
		schema: { max_length: 255, nullable: false },
	});

	await ensureField(COLLECTIONS.signals, {
		field: 'signal_type',
		type: 'string',
		meta: {
			interface: 'select-dropdown',
			display: 'labels',
			width: 'half',
			note: '信号内容类型',
			options: { choices: signalTypeChoices },
			display_options: { choices: signalTypeChoices },
		},
		schema: { max_length: 30, default_value: 'article', nullable: false },
	});

	await ensureField(COLLECTIONS.signals, {
		field: 'source_type',
		type: 'string',
		meta: {
			interface: 'select-dropdown',
			width: 'half',
			note: '兼容字段（请使用 source_ref）',
			hidden: true,
			options: { choices: signalChoices },
		},
		schema: { max_length: 50, default_value: 'tech_site' },
	});

	await ensureField(COLLECTIONS.signals, {
		field: 'source_link',
		type: 'string',
		meta: { interface: 'input', width: 'half', note: '兼容字段（请使用 signal_url）', hidden: true },
		schema: { max_length: 500, nullable: true },
	});

	await ensureField(COLLECTIONS.signals, {
		field: 'signal_url',
		type: 'string',
		meta: { interface: 'input', width: 'half', note: '内容链接（信号原始内容 URL）' },
		schema: { max_length: 500, nullable: true },
	});

	await ensureField(COLLECTIONS.signals, {
		field: 'source_ref',
		type: 'integer',
		meta: {
			interface: 'select-dropdown-m2o',
			width: 'half',
			note: '关联来源（支持快捷新建）',
			options: {
				template: '{{name}} · {{source_type}}',
				enableCreate: true,
				enableSelect: true,
			},
		},
		schema: { nullable: true },
	});

	await ensureField(COLLECTIONS.signals, {
		field: 'source_name_snapshot',
		type: 'string',
		meta: { interface: 'input', width: 'half', note: '来源名称快照', readonly: true },
		schema: { max_length: 255, nullable: true },
	});

	await ensureField(COLLECTIONS.signals, {
		field: 'source_note_snapshot',
		type: 'text',
		meta: { interface: 'input-multiline', width: 'full', note: '来源备注快照', readonly: true },
	});

	await ensureField(COLLECTIONS.signals, {
		field: 'source_summary',
		type: 'text',
		meta: { interface: 'input-multiline', width: 'full', note: '来源摘要' },
	});

	await ensureField(COLLECTIONS.signals, {
		field: 'why_it_matters',
		type: 'text',
		meta: { interface: 'input-multiline', width: 'full', note: '为什么值得关注' },
	});

	await ensureField(COLLECTIONS.signals, {
		field: 'xyunapi_relevance',
		type: 'text',
		meta: { interface: 'input-multiline', width: 'full', note: '对 xyunapi 的关联点' },
	});

	await ensureField(COLLECTIONS.signals, {
		field: 'suggested_direction',
		type: 'string',
		meta: {
			interface: 'select-dropdown',
			display: 'labels',
			width: 'half',
			note: '建议内容方向',
			options: { choices: directionChoices },
			display_options: { choices: directionChoices },
		},
		schema: { max_length: 50, default_value: 'anchor' },
	});

	await ensureField(COLLECTIONS.signals, {
		field: 'submitted_by',
		type: 'uuid',
		meta: {
			interface: 'select-dropdown-m2o',
			width: 'half',
			note: '提交人',
			options: { template: '{{first_name}} {{last_name}} ({{email}})' },
		},
		schema: { nullable: true },
	});

	await ensureField(COLLECTIONS.signals, {
		field: 'status',
		type: 'string',
		meta: {
			interface: 'select-dropdown',
			display: 'labels',
			width: 'half',
			note: '状态',
			options: { choices: signalStatusChoices },
			display_options: { choices: signalStatusChoices },
			required: true,
		},
		schema: { max_length: 30, default_value: STATUS.watching, nullable: false },
	});

	await ensureField(COLLECTIONS.signals, {
		field: 'linked_content',
		type: 'integer',
		meta: { interface: 'select-dropdown-m2o', width: 'half', note: '采纳后关联的内容卡' },
		schema: { nullable: true },
	});

	await ensureField(COLLECTIONS.signals, {
		field: 'linked_contents',
		type: 'alias',
		meta: {
			interface: 'list-o2m',
			special: ['o2m'],
			width: 'full',
			note: '关联内容卡（反向）',
			options: { template: '{{title}} · {{status}}' },
		},
	});

	await ensureField(COLLECTIONS.contentCards, {
		field: 'title',
		type: 'string',
		meta: { interface: 'input', width: 'full', required: true, note: '标题' },
		schema: { max_length: 255, nullable: false },
	});

	await ensureField(COLLECTIONS.contentCards, {
		field: 'code',
		type: 'string',
		meta: { interface: 'input', width: 'half', note: '编号' },
		schema: { max_length: 50, nullable: true },
	});

	await ensureField(COLLECTIONS.contentCards, {
		field: 'content_type',
		type: 'string',
		meta: {
			interface: 'select-dropdown',
			display: 'labels',
			width: 'half',
			note: '内容类型',
			options: { choices: contentTypeChoices },
			display_options: { choices: contentTypeChoices },
		},
		schema: { max_length: 30, default_value: 'brand' },
	});

	await ensureField(COLLECTIONS.contentCards, {
		field: 'channel_type',
		type: 'string',
		meta: {
			interface: 'select-dropdown',
			display: 'labels',
			width: 'half',
			note: '渠道类型',
			options: { choices: channelChoices },
			display_options: { choices: channelChoices },
		},
		schema: { max_length: 30, default_value: 'article' },
	});

	await ensureField(COLLECTIONS.contentCards, {
		field: 'content_goal',
		type: 'string',
		meta: {
			interface: 'select-dropdown',
			display: 'labels',
			width: 'half',
			note: '内容目标',
			options: { choices: directionChoices },
			display_options: { choices: directionChoices },
		},
		schema: { max_length: 30, default_value: 'anchor' },
	});

	await ensureField(COLLECTIONS.contentCards, {
		field: 'owner',
		type: 'uuid',
		meta: {
			interface: 'select-dropdown-m2o',
			width: 'half',
			note: '主负责人',
			options: { template: '{{first_name}} {{last_name}} ({{email}})' },
		},
		schema: { nullable: true },
	});

	await ensureField(COLLECTIONS.contentCards, {
		field: 'reviewer',
		type: 'uuid',
		meta: {
			interface: 'select-dropdown-m2o',
			width: 'half',
			note: '审核者',
			options: { template: '{{first_name}} {{last_name}} ({{email}})' },
		},
		schema: { nullable: true },
	});

	await ensureField(COLLECTIONS.contentCards, {
		field: 'planned_publish_at',
		type: 'timestamp',
		meta: { interface: 'datetime', width: 'half', note: '计划发布时间' },
		schema: { nullable: true },
	});

	await ensureField(COLLECTIONS.contentCards, {
		field: 'published_at',
		type: 'timestamp',
		meta: { interface: 'datetime', width: 'half', note: '实际发布时间' },
		schema: { nullable: true },
	});

	await ensureField(COLLECTIONS.contentCards, {
		field: 'status',
		type: 'string',
		meta: {
			interface: 'select-dropdown',
			display: 'labels',
			width: 'half',
			note: '当前状态',
			options: { choices: contentStatusChoices },
			display_options: { choices: contentStatusChoices },
			required: true,
		},
		schema: { max_length: 30, default_value: STATUS.draft, nullable: false },
	});

	await ensureField(COLLECTIONS.contentCards, {
		field: 'outline',
		type: 'text',
		meta: { interface: 'input-multiline', width: 'full', note: '提纲' },
	});

	await ensureField(COLLECTIONS.contentCards, {
		field: 'body',
		type: 'text',
		meta: {
			interface: 'input-rich-text-md',
			width: 'full',
			note: '正文（非公众号长文）',
			conditions: [
				{
					name: 'hide_body_when_channel_article',
					rule: { channel_type: { _eq: 'article' } },
					hidden: true,
					clear_hidden_value_on_save: false,
				},
			],
		},
	});

	await ensureField(COLLECTIONS.contentCards, {
		field: 'body_structured',
		type: 'json',
		meta: {
			interface: 'nm-wechat-article-editor',
			width: 'full',
			hidden: true,
			note: '公众号长文图文排版（1.3）',
			options: {
				placeholder: '请输入公众号长文正文（支持图文排版）',
			},
			conditions: [
				{
					name: 'show_body_structured_when_channel_article',
					rule: { channel_type: { _eq: 'article' } },
					hidden: false,
					clear_hidden_value_on_save: false,
				},
			],
		},
		schema: { nullable: true },
	});

	await ensureField(COLLECTIONS.contentCards, {
		field: 'summary',
		type: 'text',
		meta: { interface: 'input-multiline', width: 'full', note: '摘要/导语' },
	});

	await ensureField(COLLECTIONS.contentCards, {
		field: 'cta',
		type: 'text',
		meta: { interface: 'input-multiline', width: 'full', note: 'CTA' },
	});

	await ensureField(COLLECTIONS.contentCards, {
		field: 'risk_notes',
		type: 'text',
		meta: { interface: 'input-multiline', width: 'full', note: '风险备注' },
	});

	await ensureField(COLLECTIONS.contentCards, {
		field: 'review_comment',
		type: 'text',
		meta: { interface: 'input-multiline', width: 'full', note: '审核意见（打回必填）' },
	});

	await ensureField(COLLECTIONS.contentCards, {
		field: 'version_note',
		type: 'text',
		meta: { interface: 'input-multiline', width: 'full', note: '版本说明' },
	});

	await ensureField(COLLECTIONS.contentCards, {
		field: 'current_version',
		type: 'integer',
		meta: { interface: 'input', width: 'half', note: '当前版本号', readonly: true },
		schema: { default_value: 1, nullable: false },
	});

	await ensureField(COLLECTIONS.contentCards, {
		field: 'linked_signal',
		type: 'integer',
		meta: { interface: 'select-dropdown-m2o', width: 'half', note: '关联信号池记录' },
		schema: { nullable: true },
	});

	await ensureField(COLLECTIONS.contentCards, {
		field: 'primary_source',
		type: 'integer',
		meta: { interface: 'select-dropdown-m2o', width: 'half', note: '兼容字段（1.1 起建议用来源快照）', hidden: true },
		schema: { nullable: true },
	});

	await ensureField(COLLECTIONS.contentCards, {
		field: 'source_name_snapshot',
		type: 'string',
		meta: { interface: 'input', width: 'half', note: '来源名称快照', readonly: true },
		schema: { max_length: 255, nullable: true },
	});

	await ensureField(COLLECTIONS.contentCards, {
		field: 'source_url_snapshot',
		type: 'string',
		meta: { interface: 'input', width: 'half', note: '来源链接快照', readonly: true },
		schema: { max_length: 500, nullable: true },
	});

	await ensureField(COLLECTIONS.contentCards, {
		field: 'source_note_snapshot',
		type: 'text',
		meta: { interface: 'input-multiline', width: 'full', note: '来源说明快照', readonly: true },
	});

	await ensureField(COLLECTIONS.contentCards, {
		field: 'versions',
		type: 'alias',
		meta: {
			interface: 'list-o2m',
			special: ['o2m'],
			width: 'full',
			note: '版本记录',
			options: { template: 'v{{version_no}} - {{version_type}}' },
		},
	});

	await ensureField(COLLECTIONS.contentCards, {
		field: 'assets',
		type: 'alias',
		meta: {
			interface: 'list-o2m',
			special: ['o2m'],
			width: 'full',
			note: '关联素材',
			options: { template: '{{name}}' },
		},
	});

	await ensureField(COLLECTIONS.versions, {
		field: 'content_card',
		type: 'integer',
		meta: { interface: 'select-dropdown-m2o', width: 'half', note: '关联内容卡', required: true },
		schema: { nullable: false },
	});

	await ensureField(COLLECTIONS.versions, {
		field: 'version_no',
		type: 'integer',
		meta: { interface: 'input', width: 'half', note: '版本号', required: true },
		schema: { nullable: false },
	});

	await ensureField(COLLECTIONS.versions, {
		field: 'version_type',
		type: 'string',
		meta: {
			interface: 'select-dropdown',
			display: 'labels',
			width: 'half',
			note: '版本类型',
			options: { choices: versionTypeChoices },
			display_options: { choices: versionTypeChoices },
		},
		schema: { max_length: 30, default_value: 'draft', nullable: false },
	});

	await ensureField(COLLECTIONS.versions, {
		field: 'changed_by',
		type: 'uuid',
		meta: {
			interface: 'select-dropdown-m2o',
			width: 'half',
			note: '修改人',
			options: { template: '{{first_name}} {{last_name}} ({{email}})' },
		},
		schema: { nullable: true },
	});

	await ensureField(COLLECTIONS.versions, {
		field: 'changed_at',
		type: 'timestamp',
		meta: { interface: 'datetime', width: 'half', note: '修改时间' },
		schema: { nullable: true },
	});

	await ensureField(COLLECTIONS.versions, {
		field: 'change_summary',
		type: 'text',
		meta: { interface: 'input-multiline', width: 'full', note: '修改说明' },
	});

	await ensureField(COLLECTIONS.versions, {
		field: 'review_result',
		type: 'string',
		meta: { interface: 'input', width: 'half', note: '审核结论' },
		schema: { max_length: 50, nullable: true },
	});

	await ensureField(COLLECTIONS.versions, {
		field: 'snapshot',
		type: 'text',
		meta: {
			interface: 'input-code',
			width: 'full',
			note: '版本快照（JSON）',
			options: { language: 'json' },
		},
	});

	await ensureField(COLLECTIONS.versions, {
		field: 'is_final',
		type: 'boolean',
		meta: { interface: 'boolean', width: 'half', note: '是否最终通过版' },
		schema: { default_value: false, nullable: false },
	});

	await ensureField(COLLECTIONS.sources, {
		field: 'name',
		type: 'string',
		meta: { interface: 'input', width: 'full', required: true, note: '来源名称' },
		schema: { max_length: 255, nullable: false },
	});

	await ensureField(COLLECTIONS.sources, {
		field: 'source_type',
		type: 'string',
		meta: {
			interface: 'select-dropdown',
			display: 'labels',
			width: 'half',
			note: '来源类型',
			options: { choices: signalChoices },
			display_options: { choices: signalChoices },
		},
		schema: { max_length: 50, default_value: 'tech_site' },
	});

	await ensureField(COLLECTIONS.sources, {
		field: 'source_link',
		type: 'string',
		meta: { interface: 'input', width: 'half', note: '来源链接' },
		schema: { max_length: 500, nullable: true },
	});

	await ensureFieldRemoved(COLLECTIONS.sources, 'source_tags');

	await ensureField(COLLECTIONS.sources, {
		field: 'quality_rating',
		type: 'string',
		meta: {
			interface: 'select-dropdown',
			display: 'labels',
			width: 'half',
			note: '来源质量评级',
			options: {
				choices: [
					{ text: 'A', value: 'A' },
					{ text: 'B', value: 'B' },
					{ text: 'C', value: 'C' },
				],
			},
			display_options: {
				choices: [
					{ text: 'A', value: 'A' },
					{ text: 'B', value: 'B' },
					{ text: 'C', value: 'C' },
				],
			},
		},
		schema: { max_length: 5, default_value: 'B' },
	});

	await ensureField(COLLECTIONS.sources, {
		field: 'last_used_content',
		type: 'integer',
		meta: { interface: 'select-dropdown-m2o', width: 'half', note: '最近使用内容' },
		schema: { nullable: true },
	});

	await ensureField(COLLECTIONS.sources, {
		field: 'note',
		type: 'text',
		meta: { interface: 'input-multiline', width: 'full', note: '备注' },
	});

	await ensureField(COLLECTIONS.assets, {
		field: 'name',
		type: 'string',
		meta: { interface: 'input', width: 'full', required: true, note: '资产名称' },
		schema: { max_length: 255, nullable: false },
	});

	await ensureField(COLLECTIONS.assets, {
		field: 'asset_type',
		type: 'string',
		meta: {
			interface: 'select-dropdown',
			display: 'labels',
			width: 'half',
			note: '资产类型',
			options: { choices: assetTypeChoices },
			display_options: { choices: assetTypeChoices },
		},
		schema: { max_length: 30, default_value: 'image' },
	});

	await ensureField(COLLECTIONS.assets, {
		field: 'content_card',
		type: 'integer',
		meta: { interface: 'select-dropdown-m2o', width: 'half', note: '关联内容' },
		schema: { nullable: true },
	});

	await ensureField(COLLECTIONS.assets, {
		field: 'uploader',
		type: 'uuid',
		meta: {
			interface: 'select-dropdown-m2o',
			width: 'half',
			note: '上传人',
			options: { template: '{{first_name}} {{last_name}} ({{email}})' },
		},
		schema: { nullable: true },
	});

	await ensureField(COLLECTIONS.assets, {
		field: 'file',
		type: 'uuid',
		meta: { interface: 'file', width: 'half', note: '文件（可选）' },
		schema: { nullable: true },
	});

	await ensureField(COLLECTIONS.assets, {
		field: 'is_final',
		type: 'boolean',
		meta: { interface: 'boolean', width: 'half', note: '是否最终使用' },
		schema: { default_value: false, nullable: false },
	});

	await ensureField(COLLECTIONS.assets, {
		field: 'note',
		type: 'text',
		meta: { interface: 'input-multiline', width: 'full', note: '备注' },
	});
}

async function ensureRelations() {
	console.log('[init:new-media] 创建/校验关系...');

	const relations = [
		{
			collection: COLLECTIONS.signals,
			field: 'submitted_by',
			related_collection: 'directus_users',
			schema: { on_delete: 'SET NULL' },
		},
		{
			collection: COLLECTIONS.signals,
			field: 'linked_content',
			related_collection: COLLECTIONS.contentCards,
			schema: { on_delete: 'SET NULL' },
		},
		{
			collection: COLLECTIONS.signals,
			field: 'source_ref',
			related_collection: COLLECTIONS.sources,
			schema: { on_delete: 'SET NULL' },
		},
		{
			collection: COLLECTIONS.contentCards,
			field: 'owner',
			related_collection: 'directus_users',
			schema: { on_delete: 'SET NULL' },
		},
		{
			collection: COLLECTIONS.contentCards,
			field: 'reviewer',
			related_collection: 'directus_users',
			schema: { on_delete: 'SET NULL' },
		},
		{
			collection: COLLECTIONS.contentCards,
			field: 'linked_signal',
			related_collection: COLLECTIONS.signals,
			schema: { on_delete: 'SET NULL' },
			meta: { one_field: 'linked_contents', one_deselect_action: 'nullify' },
		},
		{
			collection: COLLECTIONS.contentCards,
			field: 'primary_source',
			related_collection: COLLECTIONS.sources,
			schema: { on_delete: 'SET NULL' },
		},
		{
			collection: COLLECTIONS.versions,
			field: 'content_card',
			related_collection: COLLECTIONS.contentCards,
			schema: { on_delete: 'CASCADE' },
			meta: { one_field: 'versions', one_deselect_action: 'nullify' },
		},
		{
			collection: COLLECTIONS.versions,
			field: 'changed_by',
			related_collection: 'directus_users',
			schema: { on_delete: 'SET NULL' },
		},
		{
			collection: COLLECTIONS.sources,
			field: 'last_used_content',
			related_collection: COLLECTIONS.contentCards,
			schema: { on_delete: 'SET NULL' },
		},
		{
			collection: COLLECTIONS.assets,
			field: 'content_card',
			related_collection: COLLECTIONS.contentCards,
			schema: { on_delete: 'SET NULL' },
			meta: { one_field: 'assets', one_deselect_action: 'nullify' },
		},
		{
			collection: COLLECTIONS.assets,
			field: 'uploader',
			related_collection: 'directus_users',
			schema: { on_delete: 'SET NULL' },
		},
		{
			collection: COLLECTIONS.assets,
			field: 'file',
			related_collection: 'directus_files',
			schema: { on_delete: 'SET NULL' },
		},
	];

	for (const relation of relations) {
		const existing = await api('GET', `/relations/${relation.collection}/${relation.field}`, {
			allow404: true,
			allow403: true,
		});

		if (existing) continue;
		await api('POST', '/relations', { body: relation });
	}
}

async function ensureFieldTranslations() {
	console.log('[init:new-media] 同步字段中文显示名...');

	const entries = [
		[COLLECTIONS.signals, 'signal_title', '信号标题'],
		[COLLECTIONS.signals, 'signal_type', '信号类型'],
		[COLLECTIONS.signals, 'signal_url', '内容链接'],
		[COLLECTIONS.signals, 'source_ref', '来源主体'],
		[COLLECTIONS.signals, 'source_name_snapshot', '来源名称快照'],
		[COLLECTIONS.signals, 'source_note_snapshot', '来源备注快照'],
		[COLLECTIONS.signals, 'source_summary', '来源摘要'],
		[COLLECTIONS.signals, 'why_it_matters', '值得关注原因'],
		[COLLECTIONS.signals, 'xyunapi_relevance', '与 xyunapi 关联点'],
		[COLLECTIONS.signals, 'suggested_direction', '建议内容方向'],
		[COLLECTIONS.signals, 'submitted_by', '提交人'],
		[COLLECTIONS.signals, 'status', '状态'],
		[COLLECTIONS.signals, 'linked_content', '关联内容卡'],
		[COLLECTIONS.signals, 'title', '信号标题（兼容）'],
		[COLLECTIONS.signals, 'source_type', '来源类型（兼容）'],
		[COLLECTIONS.signals, 'source_link', '内容链接（兼容）'],
		[COLLECTIONS.contentCards, 'code', '内容编号'],
		[COLLECTIONS.contentCards, 'title', '内容标题'],
		[COLLECTIONS.contentCards, 'content_type', '内容类型'],
		[COLLECTIONS.contentCards, 'channel_type', '渠道类型'],
		[COLLECTIONS.contentCards, 'content_goal', '内容目标'],
		[COLLECTIONS.contentCards, 'owner', '主负责人'],
		[COLLECTIONS.contentCards, 'reviewer', '审核者'],
		[COLLECTIONS.contentCards, 'planned_publish_at', '计划发布时间'],
		[COLLECTIONS.contentCards, 'published_at', '实际发布时间'],
		[COLLECTIONS.contentCards, 'status', '当前状态'],
		[COLLECTIONS.contentCards, 'outline', '提纲'],
		[COLLECTIONS.contentCards, 'body', '正文（文本）'],
		[COLLECTIONS.contentCards, 'body_structured', '公众号长文排版'],
		[COLLECTIONS.contentCards, 'summary', '摘要/导语'],
		[COLLECTIONS.contentCards, 'cta', 'CTA'],
		[COLLECTIONS.contentCards, 'risk_notes', '风险备注'],
		[COLLECTIONS.contentCards, 'review_comment', '审核意见'],
		[COLLECTIONS.contentCards, 'version_note', '版本说明'],
		[COLLECTIONS.contentCards, 'current_version', '当前版本号'],
		[COLLECTIONS.contentCards, 'linked_signal', '关联信号'],
		[COLLECTIONS.contentCards, 'primary_source', '来源主体（兼容）'],
		[COLLECTIONS.contentCards, 'source_name_snapshot', '来源名称快照'],
		[COLLECTIONS.contentCards, 'source_url_snapshot', '来源链接快照'],
		[COLLECTIONS.contentCards, 'source_note_snapshot', '来源说明快照'],
		[COLLECTIONS.contentCards, 'versions', '版本记录'],
		[COLLECTIONS.contentCards, 'assets', '关联素材'],
		[COLLECTIONS.versions, 'content_card', '关联内容卡'],
		[COLLECTIONS.versions, 'version_no', '版本号'],
		[COLLECTIONS.versions, 'version_type', '版本类型'],
		[COLLECTIONS.versions, 'changed_by', '修改人'],
		[COLLECTIONS.versions, 'changed_at', '修改时间'],
		[COLLECTIONS.versions, 'change_summary', '修改说明'],
		[COLLECTIONS.versions, 'review_result', '审核结论'],
		[COLLECTIONS.versions, 'snapshot', '版本快照'],
		[COLLECTIONS.versions, 'is_final', '是否最终版'],
		[COLLECTIONS.sources, 'name', '来源名称'],
		[COLLECTIONS.sources, 'source_type', '来源类型'],
		[COLLECTIONS.sources, 'source_link', '来源链接'],
		[COLLECTIONS.sources, 'quality_rating', '来源质量评级'],
		[COLLECTIONS.sources, 'last_used_content', '最近使用内容'],
		[COLLECTIONS.sources, 'note', '备注'],
		[COLLECTIONS.assets, 'name', '资产名称'],
		[COLLECTIONS.assets, 'asset_type', '资产类型'],
		[COLLECTIONS.assets, 'content_card', '关联内容卡'],
		[COLLECTIONS.assets, 'uploader', '上传人'],
		[COLLECTIONS.assets, 'file', '文件'],
		[COLLECTIONS.assets, 'is_final', '是否最终使用'],
		[COLLECTIONS.assets, 'note', '备注'],
	];

	for (const [collection, field, translation] of entries) {
		const existing = await api('GET', `/fields/${collection}/${field}`, {
			allow404: true,
			allow403: true,
		});

		const meta = existing?.data?.meta;
		if (!meta) continue;

		const currentTranslations = Array.isArray(meta.translations) ? [...meta.translations] : [];
		const normalizedTranslations = currentTranslations.filter(
			(item) => item && typeof item === 'object' && item.language !== DEFAULT_LANGUAGE,
		);
		normalizedTranslations.push({
			language: DEFAULT_LANGUAGE,
			translation,
		});

		const currentTranslation = currentTranslations.find(
			(item) => item && typeof item === 'object' && item.language === DEFAULT_LANGUAGE,
		)?.translation;

		if (currentTranslation === translation) continue;

		await api('PATCH', `/fields/${collection}/${field}`, {
			body: {
				meta: {
					...meta,
					translations: normalizedTranslations,
				},
			},
		});
	}
}

async function ensureV11Compatibility() {
	console.log('[init:new-media] 执行 1.1-1.3 字段兼容迁移...');

	const sourcesResponse = await api('GET', `/items/${COLLECTIONS.sources}`, {
		query: {
			fields: ['id', 'name', 'note', 'source_type', 'source_link'],
			limit: -1,
		},
	});

	const sourceById = new Map((sourcesResponse?.data ?? []).map((source) => [String(source.id), source]));
	const sourceByLink = new Map(
		(sourcesResponse?.data ?? [])
			.filter((source) => getText(source?.source_link))
			.map((source) => [getText(source.source_link), source]),
	);

	const signalsResponse = await api('GET', `/items/${COLLECTIONS.signals}`, {
		query: {
			fields: [
				'id',
				'title',
				'signal_title',
				'source_link',
				'signal_url',
				'source_type',
				'signal_type',
				'source_ref',
				'source_name_snapshot',
				'source_note_snapshot',
			],
			limit: -1,
		},
	});

	for (const signal of signalsResponse?.data ?? []) {
		const patch = {};
		const signalTitle = getText(signal.signal_title) || getText(signal.title);

		if (signalTitle && getText(signal.signal_title) !== signalTitle) {
			patch.signal_title = signalTitle;
		}

		if (signalTitle && getText(signal.title) !== signalTitle) {
			patch.title = signalTitle;
		}

		const signalUrl = getText(signal.signal_url) || getText(signal.source_link);
		if (signalUrl && getText(signal.signal_url) !== signalUrl) {
			patch.signal_url = signalUrl;
		}

		if (signalUrl && getText(signal.source_link) !== signalUrl) {
			patch.source_link = signalUrl;
		}

		if (!getText(signal.signal_type)) {
			patch.signal_type = mapSignalType(signal.source_type, signalUrl);
		}

		let sourceRef = signal.source_ref;
		if (!sourceRef) {
			const fromLink = sourceByLink.get(signalUrl);
			if (fromLink?.id) sourceRef = fromLink.id;
		}

		if (!sourceRef && getText(signal.source_type)) {
			const byType = (sourcesResponse?.data ?? []).find((source) => source.source_type === signal.source_type);
			if (byType?.id) sourceRef = byType.id;
		}

		if (sourceRef && normalizeComparable(signal.source_ref) !== normalizeComparable(sourceRef)) {
			patch.source_ref = sourceRef;
		}

		const source = sourceRef ? sourceById.get(String(sourceRef)) : null;
		if (source) {
			const sourceNameSnapshot = getText(source.name);
			const sourceNoteSnapshot = getText(source.note);

			if (sourceNameSnapshot && getText(signal.source_name_snapshot) !== sourceNameSnapshot) {
				patch.source_name_snapshot = sourceNameSnapshot;
			}

			if (sourceNoteSnapshot && getText(signal.source_note_snapshot) !== sourceNoteSnapshot) {
				patch.source_note_snapshot = sourceNoteSnapshot;
			}
		}

		if (Object.keys(patch).length > 0) {
			await api('PATCH', `/items/${COLLECTIONS.signals}/${signal.id}`, { body: patch });
		}
	}

	const cardsResponse = await api('GET', `/items/${COLLECTIONS.contentCards}`, {
		query: {
			fields: [
				'id',
				'linked_signal',
				'source_name_snapshot',
				'source_url_snapshot',
				'source_note_snapshot',
				'channel_type',
				'body',
				'body_structured',
			],
			limit: -1,
		},
	});

	for (const card of cardsResponse?.data ?? []) {
		const patch = {};
		if (card.linked_signal) {
			const signal = (signalsResponse?.data ?? []).find(
				(item) => normalizeComparable(item.id) === normalizeComparable(card.linked_signal),
			);

			if (signal) {
				const source =
					signal.source_ref && sourceById.has(String(signal.source_ref))
						? sourceById.get(String(signal.source_ref))
						: null;
				const sourceNameSnapshot = getText(signal.source_name_snapshot) || getText(source?.name);
				const sourceUrlSnapshot = getText(signal.signal_url) || getText(source?.source_link);
				const sourceNoteSnapshot = getText(signal.source_note_snapshot) || getText(source?.note);

				if (sourceNameSnapshot && getText(card.source_name_snapshot) !== sourceNameSnapshot) {
					patch.source_name_snapshot = sourceNameSnapshot;
				}

				if (sourceUrlSnapshot && getText(card.source_url_snapshot) !== sourceUrlSnapshot) {
					patch.source_url_snapshot = sourceUrlSnapshot;
				}

				if (sourceNoteSnapshot && getText(card.source_note_snapshot) !== sourceNoteSnapshot) {
					patch.source_note_snapshot = sourceNoteSnapshot;
				}
			}
		}

		const shouldBackfillStructuredBody =
			card.channel_type === 'article' && isEmptyStructuredBody(card.body_structured) && getText(card.body).length > 0;

		if (shouldBackfillStructuredBody) {
			patch.body_structured = createStructuredBodyFromText(card.body);
		}

		if (Object.keys(patch).length > 0) {
			await api('PATCH', `/items/${COLLECTIONS.contentCards}/${card.id}`, { body: patch });
		}
	}
}

async function ensureRolesAndPolicies() {
	console.log('[init:new-media] 创建/校验角色与策略...');

	state.creatorPolicyId = await ensurePolicy('内容创作者策略', {
		icon: 'edit_square',
		description: '新媒体内容中台 - 创作者策略',
		app_access: true,
		admin_access: false,
	});

	state.reviewerPolicyId = await ensurePolicy('审核者策略', {
		icon: 'fact_check',
		description: '新媒体内容中台 - 审核策略',
		app_access: true,
		admin_access: false,
	});

	state.creatorRoleId = await ensureRole(CREATOR_ROLE_NAME, {
		icon: 'edit_note',
		description: '内容起草与素材维护',
	});

	state.reviewerRoleId = await ensureRole(REVIEWER_ROLE_NAME, {
		icon: 'rule',
		description: '内容审核与通过/打回',
	});

	await ensureAccess(state.creatorRoleId, state.creatorPolicyId);
	await ensureAccess(state.reviewerRoleId, state.reviewerPolicyId);
}

async function ensureUsers() {
	console.log('[init:new-media] 创建/校验演示账号...');

	state.creatorUserId = await ensureUser(CREATOR_EMAIL, DEMO_PASSWORD, state.creatorRoleId, {
		first_name: '内容',
		last_name: '创作者',
		language: DEFAULT_LANGUAGE,
	});

	state.reviewerUserId = await ensureUser(REVIEWER_EMAIL, DEMO_PASSWORD, state.reviewerRoleId, {
		first_name: '内容',
		last_name: '审核者',
		language: DEFAULT_LANGUAGE,
	});

	await ensureAdminLanguage();
}

async function ensureAdminLanguage() {
	if (!state.adminUserId) return;

	await api('PATCH', `/users/${state.adminUserId}`, {
		body: {
			language: DEFAULT_LANGUAGE,
		},
	});
}

async function ensurePermissions() {
	console.log('[init:new-media] 创建/校验权限...');

	const creatorCollections = [
		COLLECTIONS.signals,
		COLLECTIONS.contentCards,
		COLLECTIONS.versions,
		COLLECTIONS.sources,
		COLLECTIONS.assets,
	];

	for (const collection of creatorCollections) {
		await ensurePermission(state.creatorPolicyId, collection, 'read', {
			fields: ['*'],
		});
	}

	await ensurePermission(state.creatorPolicyId, COLLECTIONS.signals, 'create', {
		fields: ['*'],
		presets: { submitted_by: '$CURRENT_USER', status: STATUS.watching },
	});

	await ensurePermission(state.creatorPolicyId, COLLECTIONS.signals, 'update', {
		fields: ['*'],
		permissions: {
			_or: [{ submitted_by: { _eq: '$CURRENT_USER' } }, { submitted_by: { _null: true } }],
		},
	});

	await ensurePermission(state.creatorPolicyId, COLLECTIONS.contentCards, 'create', {
		fields: ['*'],
		presets: { owner: '$CURRENT_USER', status: STATUS.draft, current_version: 1 },
	});

	await ensurePermission(state.creatorPolicyId, COLLECTIONS.contentCards, 'update', {
		fields: ['*'],
		permissions: {
			_or: [{ owner: { _eq: '$CURRENT_USER' } }, { reviewer: { _eq: '$CURRENT_USER' } }],
		},
	});

	await ensurePermission(state.creatorPolicyId, COLLECTIONS.assets, 'create', {
		fields: ['*'],
		presets: { uploader: '$CURRENT_USER' },
	});

	await ensurePermission(state.creatorPolicyId, COLLECTIONS.assets, 'update', {
		fields: ['*'],
		permissions: {
			_or: [{ uploader: { _eq: '$CURRENT_USER' } }, { uploader: { _null: true } }],
		},
	});

	await ensurePermission(state.creatorPolicyId, COLLECTIONS.sources, 'create', {
		fields: ['*'],
	});

	await ensurePermission(state.creatorPolicyId, COLLECTIONS.sources, 'update', {
		fields: ['*'],
	});

	await ensurePermission(state.creatorPolicyId, 'directus_users', 'read', {
		fields: ['id', 'first_name', 'last_name', 'email'],
	});
	await ensurePermission(state.creatorPolicyId, 'directus_translations', 'read', {
		fields: ['key', 'language', 'value'],
	});
	await ensurePermission(state.creatorPolicyId, 'directus_dashboards', 'read', { fields: ['*'] });
	await ensurePermission(state.creatorPolicyId, 'directus_panels', 'read', { fields: ['*'] });

	const reviewerCollections = [
		COLLECTIONS.signals,
		COLLECTIONS.contentCards,
		COLLECTIONS.versions,
		COLLECTIONS.sources,
		COLLECTIONS.assets,
	];

	for (const collection of reviewerCollections) {
		await ensurePermission(state.reviewerPolicyId, collection, 'read', {
			fields: ['*'],
		});
	}

	await ensurePermission(state.reviewerPolicyId, COLLECTIONS.contentCards, 'update', {
		fields: ['*'],
	});

	await ensurePermission(state.reviewerPolicyId, COLLECTIONS.versions, 'create', {
		fields: ['*'],
	});

	await ensurePermission(state.reviewerPolicyId, 'directus_users', 'read', {
		fields: ['id', 'first_name', 'last_name', 'email'],
	});
	await ensurePermission(state.reviewerPolicyId, 'directus_translations', 'read', {
		fields: ['key', 'language', 'value'],
	});
	await ensurePermission(state.reviewerPolicyId, 'directus_dashboards', 'read', { fields: ['*'] });
	await ensurePermission(state.reviewerPolicyId, 'directus_panels', 'read', { fields: ['*'] });
}

async function ensureDashboard() {
	console.log('[init:new-media] 创建/校验工作台...');

	const dashboard = await ensureDashboardByName('新媒体内容中台工作台', {
		icon: 'space_dashboard',
		note: productInfo.fullTitle,
		color: '#0B57D0',
	});

	const panels = [
		{
			name: '我的草稿',
			type: 'list',
			position_x: 1,
			position_y: 1,
			width: 12,
			height: 8,
			show_header: true,
			options: {
				collection: COLLECTIONS.contentCards,
				limit: 6,
				sortField: 'planned_publish_at',
				sortDirection: 'desc',
				displayTemplate: '{{title}}',
				linkToItem: true,
				filter: {
					_and: [{ owner: { _eq: '$CURRENT_USER' } }, { status: { _eq: STATUS.draft } }],
				},
			},
		},
		{
			name: '待我审核',
			type: 'list',
			position_x: 13,
			position_y: 1,
			width: 12,
			height: 8,
			show_header: true,
			options: {
				collection: COLLECTIONS.contentCards,
				limit: 6,
				sortField: 'planned_publish_at',
				sortDirection: 'asc',
				displayTemplate: '{{title}}',
				linkToItem: true,
				filter: {
					_and: [{ reviewer: { _eq: '$CURRENT_USER' } }, { status: { _eq: STATUS.inReview } }],
				},
			},
		},
		{
			name: '最近通过内容',
			type: 'list',
			position_x: 1,
			position_y: 9,
			width: 12,
			height: 8,
			show_header: true,
			options: {
				collection: COLLECTIONS.contentCards,
				limit: 6,
				sortField: 'published_at',
				sortDirection: 'desc',
				displayTemplate: '{{title}}',
				linkToItem: true,
				filter: {
					status: { _eq: STATUS.approved },
				},
			},
		},
		{
			name: '最近采纳的信号',
			type: 'list',
			position_x: 13,
			position_y: 9,
			width: 12,
			height: 8,
			show_header: true,
			options: {
				collection: COLLECTIONS.signals,
				limit: 6,
				sortField: 'id',
				sortDirection: 'desc',
				displayTemplate: '{{signal_title}}',
				linkToItem: true,
				filter: {
					status: { _eq: STATUS.adopted },
				},
			},
		},
	];

	for (const panel of panels) {
		await ensurePanel(dashboard.id, panel);
	}
}

async function ensureDemoData() {
	console.log('[init:new-media] 写入演示数据...');

	const source1 = await ensureItem(COLLECTIONS.sources, 'name', '36kr - AI', {
		source_type: 'tech_site',
		source_link: 'https://www.36kr.com/',
		quality_rating: 'A',
		note: '高频跟踪科技行业动态',
	});

	const source2 = await ensureItem(COLLECTIONS.sources, 'name', 'YouTube - Two Minute Papers', {
		source_type: 'youtube',
		source_link: 'https://www.youtube.com/@TwoMinutePapers',
		quality_rating: 'A',
		note: '适合快速捕捉模型与应用热点',
	});

	const source3 = await ensureItem(COLLECTIONS.sources, 'name', '微信公众号 - 量子位', {
		source_type: 'wechat',
		source_link: 'https://mp.weixin.qq.com/',
		quality_rating: 'B',
		note: '中文语境传播素材丰富',
	});

	const signal1 = await ensureItem(COLLECTIONS.signals, 'signal_title', 'OpenAI 新模型发布窗口观察', {
		title: 'OpenAI 新模型发布窗口观察',
		signal_title: 'OpenAI 新模型发布窗口观察',
		signal_type: 'announcement',
		source_type: 'tech_site',
		source_link: 'https://openai.com/news',
		signal_url: 'https://openai.com/news',
		source_ref: source1.id,
		source_name_snapshot: source1.name,
		source_note_snapshot: source1.note,
		source_summary: '近期多模态能力提升，市场关注度高。',
		why_it_matters: '可作为品牌定锚内容，强化技术判断力形象。',
		xyunapi_relevance: '可映射到 xyunapi 的模型适配与调用能力。',
		suggested_direction: 'anchor',
		submitted_by: state.creatorUserId,
		status: STATUS.adopted,
	});

	const signal2 = await ensureItem(COLLECTIONS.signals, 'signal_title', 'AI Agent 成本下降信号', {
		title: 'AI Agent 成本下降信号',
		signal_title: 'AI Agent 成本下降信号',
		signal_type: 'report',
		source_type: 'report',
		source_link: 'https://arxiv.org/',
		signal_url: 'https://arxiv.org/',
		source_ref: source2.id,
		source_name_snapshot: source2.name,
		source_note_snapshot: source2.note,
		source_summary: 'Agent 框架在推理成本和稳定性上持续改善。',
		why_it_matters: '有利于破圈，降低认知门槛并解释商业价值。',
		xyunapi_relevance: '可结合统一网关与监控能力讲清落地路径。',
		suggested_direction: 'breakout',
		submitted_by: state.creatorUserId,
		status: STATUS.adopted,
	});

	const signal3 = await ensureItem(COLLECTIONS.signals, 'signal_title', '行业客户案例沉淀机会', {
		title: '行业客户案例沉淀机会',
		signal_title: '行业客户案例沉淀机会',
		signal_type: 'article',
		source_type: 'kol',
		source_link: 'https://x.com/',
		signal_url: 'https://x.com/',
		source_ref: source3.id,
		source_name_snapshot: source3.name,
		source_note_snapshot: source3.note,
		source_summary: '多个 KOL 开始强调“可复用方法论”内容。',
		why_it_matters: '适合承接转化，提高咨询与合作线索质量。',
		xyunapi_relevance: '可包装为“从 PoC 到生产”案例内容。',
		suggested_direction: 'convert',
		submitted_by: state.creatorUserId,
		status: STATUS.watching,
	});

	const content1 = await ensureItem(COLLECTIONS.contentCards, 'code', 'WXDEMO-001', {
		title: '为什么 2026 年是企业接入 AI 工作流的临界点',
		code: 'WXDEMO-001',
		content_type: 'awareness',
		channel_type: 'article',
		content_goal: 'anchor',
		owner: state.creatorUserId,
		reviewer: state.reviewerUserId,
		planned_publish_at: '2026-04-18T10:00:00.000Z',
		published_at: '2026-04-20T10:00:00.000Z',
		outline: '1. 行业背景\n2. 成本变化\n3. 落地路径\n4. XY 方案',
		body: '企业正在从“尝鲜 AI”走向“把 AI 接进业务主流程”。本文给出判断框架与落地清单。',
		body_structured: createStructuredBodyFromText(
			'企业正在从“尝鲜 AI”走向“把 AI 接进业务主流程”。\n\n本文给出判断框架与落地清单。',
		),
		summary: '从趋势、成本、组织和系统四个层面解释 AI 工作流落地。',
		cta: '回复“工作流”领取模板',
		risk_notes: '避免绝对化结论，标注数据口径。',
		linked_signal: signal1.id,
		source_name_snapshot: source1.name,
		source_url_snapshot: 'https://openai.com/news',
		source_note_snapshot: source1.note,
		primary_source: source1.id,
	});

	const content2 = await ensureItem(COLLECTIONS.contentCards, 'code', 'WXDEMO-002', {
		title: 'AI Agent 成本下降后，中小团队应该先做哪三件事',
		code: 'WXDEMO-002',
		content_type: 'solution',
		channel_type: 'short_post',
		content_goal: 'breakout',
		owner: state.creatorUserId,
		reviewer: state.reviewerUserId,
		planned_publish_at: '2026-04-24T09:30:00.000Z',
		status: STATUS.draft,
		outline: '1. 业务优先级\n2. 流程切片\n3. 指标闭环',
		body: '先做低风险高复用场景，再扩展到核心链路。',
		summary: '三步法把 Agent 从 Demo 推进到可复用。',
		cta: '私信获取试点评估清单',
		risk_notes: '避免夸大 ROI，需要结合真实工时数据。',
		version_note: '草稿版',
		current_version: 1,
		linked_signal: signal2.id,
		source_name_snapshot: source2.name,
		source_url_snapshot: 'https://arxiv.org/',
		source_note_snapshot: source2.note,
		primary_source: source2.id,
	});

	await upsertItemById(COLLECTIONS.signals, signal1.id, {
		linked_content: content1.id,
		status: STATUS.adopted,
	});

	await upsertItemById(COLLECTIONS.signals, signal2.id, {
		linked_content: content2.id,
		status: STATUS.adopted,
	});

	await upsertItemById(COLLECTIONS.sources, source1.id, { last_used_content: content1.id });
	await upsertItemById(COLLECTIONS.sources, source2.id, { last_used_content: content2.id });
	await upsertItemById(COLLECTIONS.sources, source3.id, { last_used_content: content1.id });

	await ensureItem(COLLECTIONS.assets, 'name', '临界点封面图', {
		asset_type: 'cover',
		content_card: content1.id,
		uploader: state.creatorUserId,
		is_final: true,
		note: '公众号头图',
	});

	await ensureItem(COLLECTIONS.assets, 'name', '成本曲线配图', {
		asset_type: 'image',
		content_card: content1.id,
		uploader: state.creatorUserId,
		is_final: true,
		note: '正文第二段',
	});

	await ensureItem(COLLECTIONS.assets, 'name', 'Agent 流程示意图', {
		asset_type: 'long_image',
		content_card: content2.id,
		uploader: state.creatorUserId,
		is_final: false,
		note: '待优化的草图',
	});

	await ensureItem(COLLECTIONS.assets, 'name', '案例截图-客户A', {
		asset_type: 'screenshot',
		content_card: content2.id,
		uploader: state.creatorUserId,
		is_final: false,
		note: '需要脱敏处理',
	});

	const content1VersionSummary = await getVersionSummary(content1.id);

	if (!content1VersionSummary.hasRejected || !content1VersionSummary.hasApproved) {
		await ensureContentStatus(content1.id, STATUS.inReview, {
			versionNote: '送审版',
		});

		await ensureContentStatus(content1.id, STATUS.draft, {
			reviewComment: '补充风险边界并精简案例段落',
			versionNote: '打回版',
		});

		await ensureContentStatus(content1.id, STATUS.inReview, {
			versionNote: '二次送审版',
		});

		await ensureContentStatus(content1.id, STATUS.approved, {
			reviewComment: '通过：逻辑完整，可发布。',
			versionNote: '通过版',
		});
	} else {
		await ensureContentStatus(content1.id, STATUS.approved, {
			reviewComment: '通过：逻辑完整，可发布。',
			versionNote: '通过版',
		});
	}

	await ensureContentStatus(content2.id, STATUS.draft, {
		versionNote: '草稿版',
	});
}

async function maybeSeedContentSampleData() {
	if (!ENABLE_CONTENT_SAMPLE_DATA) {
		console.log('[init:new-media] 跳过内容样例数据写入（仅保留账号、角色与系统配置）。');
		return;
	}

	await ensureDemoData();
}

async function ensureContentStatus(contentId, targetStatus, options = {}) {
	const current = await api('GET', `/items/${COLLECTIONS.contentCards}/${contentId}`, {
		query: { fields: ['id', 'status'] },
	});

	const currentStatus = current?.data?.status ?? null;
	if (currentStatus === targetStatus) return;

	if (targetStatus === STATUS.approved && currentStatus !== STATUS.inReview) {
		await api('PATCH', `/items/${COLLECTIONS.contentCards}/${contentId}`, {
			body: { status: STATUS.inReview, version_note: options.versionNote ?? '送审版' },
		});
	}

	const payload = { status: targetStatus };

	if (options.reviewComment) payload.review_comment = options.reviewComment;
	if (options.versionNote) payload.version_note = options.versionNote;

	if (targetStatus === STATUS.draft && currentStatus === STATUS.inReview && !options.reviewComment) {
		payload.review_comment = '初始化退回草稿';
	}

	await api('PATCH', `/items/${COLLECTIONS.contentCards}/${contentId}`, {
		body: payload,
	});
}

async function getVersionSummary(contentId) {
	const response = await api('GET', `/items/${COLLECTIONS.versions}`, {
		query: { fields: ['content_card', 'version_type'], limit: -1 },
	});

	const versions = response?.data?.filter(
		(version) => normalizeComparable(version?.content_card) === normalizeComparable(contentId),
	);

	return {
		hasRejected: versions?.some((version) => version?.version_type === 'rejected') ?? false,
		hasApproved: versions?.some((version) => version?.version_type === 'approved') ?? false,
	};
}

async function ensureCollection(collection, meta) {
	const existing = await api('GET', `/collections/${collection}`, {
		allow404: true,
		allow403: true,
	});

	if (existing?.data) return existing.data;

	return (
		await api('POST', '/collections', {
			body: {
				collection,
				meta: {
					hidden: false,
					singleton: false,
					icon: meta.icon,
					note: meta.note,
					translations: [
						{
							language: 'zh-CN',
							translation: meta.translation,
							singular: meta.translation,
							plural: meta.translation,
						},
					],
					archive_field: meta.archive_field ?? null,
					archive_app_filter: meta.archive_app_filter ?? true,
					archive_value: meta.archive_value ?? null,
					unarchive_value: meta.unarchive_value ?? null,
				},
				schema: {
					name: collection,
				},
			},
		})
	).data;
}

async function ensureField(collection, field) {
	const existing = await api('GET', `/fields/${collection}/${field.field}`, {
		allow404: true,
		allow403: true,
	});

	if (existing?.data) {
		const updatePayload = {};
		if (field.type) updatePayload.type = field.type;
		if (field.meta) updatePayload.meta = field.meta;
		if (field.schema) updatePayload.schema = field.schema;

		if (Object.keys(updatePayload).length > 0) {
			return (await api('PATCH', `/fields/${collection}/${field.field}`, { body: updatePayload })).data;
		}

		return existing.data;
	}

	return (await api('POST', `/fields/${collection}`, { body: field })).data;
}

async function ensureFieldRemoved(collection, field) {
	const existing = await api('GET', `/fields/${collection}/${field}`, {
		allow404: true,
		allow403: true,
	});

	if (!existing?.data) return;

	await api('DELETE', `/fields/${collection}/${field}`);
}

async function ensurePolicy(name, payload) {
	const existing = await getFirst('/policies', { filter: { name: { _eq: name } } });

	if (existing) {
		await api('PATCH', `/policies/${existing.id}`, { body: payload });
		return existing.id;
	}

	const created = await api('POST', '/policies', {
		body: {
			name,
			...payload,
		},
	});

	return created.data.id;
}

async function ensureRole(name, payload) {
	const existing = await getFirst('/roles', { filter: { name: { _eq: name } } });

	if (existing) {
		await api('PATCH', `/roles/${existing.id}`, { body: payload });
		return existing.id;
	}

	const created = await api('POST', '/roles', {
		body: {
			name,
			...payload,
		},
	});

	return created.data.id;
}

async function ensureAccess(roleId, policyId) {
	const existing = await findAccess(roleId, policyId);

	if (existing) return existing.id;

	const created = await api('POST', '/access', {
		body: {
			role: roleId,
			policy: policyId,
		},
	});

	return created.data.id;
}

async function ensureUser(email, password, roleId, profile = {}) {
	const existing = await getFirst('/users', {
		filter: { email: { _eq: email } },
		fields: ['id', 'email'],
	});

	if (existing) {
		await api('PATCH', `/users/${existing.id}`, {
			body: {
				role: roleId,
				status: 'active',
				password,
				...profile,
			},
		});
		return existing.id;
	}

	const created = await api('POST', '/users', {
		body: {
			email,
			password,
			role: roleId,
			status: 'active',
			...profile,
		},
	});

	return created.data.id;
}

async function ensurePermission(policyId, collection, action, options = {}) {
	const existing = await findPermission(policyId, collection, action);

	const payload = {
		policy: policyId,
		collection,
		action,
		permissions: options.permissions ?? null,
		validation: options.validation ?? null,
		presets: options.presets ?? null,
		fields: options.fields ?? ['*'],
	};

	if (existing) {
		await api('PATCH', `/permissions/${existing.id}`, { body: payload });
		return existing.id;
	}

	const created = await api('POST', '/permissions', { body: payload });
	return created.data.id;
}

async function findAccess(roleId, policyId) {
	const response = await api('GET', '/access', {
		query: { fields: ['id', 'role', 'policy'], limit: -1 },
	});

	return (
		response?.data?.find((row) => normalizeId(row?.role) === roleId && normalizeId(row?.policy) === policyId) ?? null
	);
}

async function findPermission(policyId, collection, action) {
	const response = await api('GET', '/permissions', {
		query: { fields: ['id', 'policy', 'collection', 'action'], limit: -1 },
	});

	return (
		response?.data?.find(
			(row) => normalizeId(row?.policy) === policyId && row?.collection === collection && row?.action === action,
		) ?? null
	);
}

async function ensureDashboardByName(name, payload) {
	const existing = await findDashboardByName(name);

	if (existing) {
		await api('PATCH', `/dashboards/${existing.id}`, { body: payload });
		return { ...existing, ...payload };
	}

	const created = await api('POST', '/dashboards', {
		body: {
			name,
			...payload,
		},
	});

	return created.data;
}

async function ensurePanel(dashboardId, panel) {
	const existing = await findPanel(dashboardId, panel.name);

	const payload = {
		dashboard: dashboardId,
		...panel,
	};

	if (existing) {
		await api('PATCH', `/panels/${existing.id}`, { body: payload });
		return existing.id;
	}

	const created = await api('POST', '/panels', { body: payload });
	return created.data.id;
}

async function findDashboardByName(name) {
	const response = await api('GET', '/dashboards', {
		query: { fields: ['id', 'name', 'icon', 'note', 'color'], limit: -1 },
	});

	return response?.data?.find((dashboard) => dashboard?.name === name) ?? null;
}

async function findPanel(dashboardId, panelName) {
	const response = await api('GET', '/panels', {
		query: { fields: ['id', 'name', 'dashboard'], limit: -1 },
	});

	return (
		response?.data?.find((panel) => normalizeId(panel?.dashboard) === dashboardId && panel?.name === panelName) ?? null
	);
}

async function ensureItem(collection, uniqueField, uniqueValue, payload) {
	const response = await api('GET', `/items/${collection}`, {
		query: { fields: ['id', uniqueField], limit: -1 },
	});

	const existing =
		response?.data?.find((item) => normalizeComparable(item?.[uniqueField]) === normalizeComparable(uniqueValue)) ??
		null;

	if (existing) {
		await api('PATCH', `/items/${collection}/${existing.id}`, { body: payload });
		return { ...existing, ...payload };
	}

	const created = await api('POST', `/items/${collection}`, {
		body: {
			[uniqueField]: uniqueValue,
			...payload,
		},
	});

	return created.data;
}

async function upsertItemById(collection, id, payload) {
	await api('PATCH', `/items/${collection}/${id}`, { body: payload });
}

async function getFirst(path, query) {
	const response = await api('GET', path, { query: { ...query, limit: 1 } });
	return response?.data?.[0] ?? null;
}

async function api(method, path, { auth = true, body, query, allow404 = false, allow403 = false } = {}) {
	const url = new URL(path, API_URL);

	if (query) appendQuery(url.searchParams, query);

	const headers = {
		'Content-Type': 'application/json',
	};

	if (auth) {
		headers.Authorization = `Bearer ${accessToken}`;
	}

	const response = await fetch(url.toString(), {
		method,
		headers,
		body: body ? JSON.stringify(body) : undefined,
	});

	if (allow404 && response.status === 404) return null;
	if (allow403 && response.status === 403) return null;

	let parsed = {};
	const text = await response.text();

	if (text) {
		try {
			parsed = JSON.parse(text);
		} catch {
			parsed = { raw: text };
		}
	}

	if (!response.ok) {
		throw new Error(
			`[${method} ${path}] ${response.status} ${response.statusText}\n${JSON.stringify(parsed, null, 2)}`,
		);
	}

	return parsed;
}

function appendQuery(params, input, prefix = '') {
	if (input == null) return;

	if (Array.isArray(input)) {
		for (const value of input) {
			params.append(`${prefix}[]`, String(value));
		}
		return;
	}

	if (typeof input === 'object') {
		for (const [key, value] of Object.entries(input)) {
			const nestedKey = prefix ? `${prefix}[${key}]` : key;
			appendQuery(params, value, nestedKey);
		}
		return;
	}

	params.append(prefix, String(input));
}

function normalizeId(value) {
	if (typeof value === 'string') return value;
	if (value && typeof value === 'object' && typeof value.id === 'string') return value.id;
	return '';
}

function normalizeComparable(value) {
	if (value == null) return '';
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (typeof value === 'object' && 'id' in value) return normalizeComparable(value.id);
	return '';
}

function getText(value) {
	return typeof value === 'string' ? value.trim() : '';
}

function isEmptyStructuredBody(value) {
	const parsed = parseStructuredBody(value);
	if (!parsed) return true;
	return !Array.isArray(parsed.blocks) || parsed.blocks.length === 0;
}

function parseStructuredBody(value) {
	if (!value) return null;

	if (typeof value === 'string') {
		try {
			const parsed = JSON.parse(value);
			return typeof parsed === 'object' && parsed !== null ? parsed : null;
		} catch {
			return null;
		}
	}

	return typeof value === 'object' ? value : null;
}

function createStructuredBodyFromText(text) {
	const paragraphs = getText(text)
		.split(/\n{2,}/)
		.map((part) => getText(part))
		.filter(Boolean);

	if (paragraphs.length < 1) return null;

	return {
		time: Date.now(),
		version: '2.31.0',
		blocks: paragraphs.map((content) => ({
			type: 'paragraph',
			data: { text: content.replaceAll('\n', '<br>') },
		})),
	};
}

function parseBoolean(value) {
	if (typeof value !== 'string') return false;
	const normalized = value.trim().toLowerCase();
	return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function mapSignalType(sourceType, signalUrl) {
	if (sourceType === 'youtube') return 'video';
	if (sourceType === 'twitter') return 'tweet';
	if (sourceType === 'report') return 'report';
	if (sourceType === 'wechat' || sourceType === 'tech_site' || sourceType === 'kol') return 'article';

	const link = getText(signalUrl).toLowerCase();
	if (!link) return 'other';
	if (link.includes('youtube.com') || link.includes('bilibili.com') || link.includes('video')) return 'video';
	if (link.includes('x.com') || link.includes('twitter.com')) return 'tweet';
	if (link.includes('report')) return 'report';
	if (link.includes('announcement') || link.includes('notice')) return 'announcement';
	return 'article';
}
