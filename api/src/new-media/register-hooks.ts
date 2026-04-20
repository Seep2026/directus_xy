import { ForbiddenError, InvalidPayloadError } from '@directus/errors';
import type { Accountability } from '@directus/types';
import type { Knex } from 'knex';
import emitter from '../emitter.js';

const SIGNAL_COLLECTION = 'nm_signals';
const CONTENT_COLLECTION = 'nm_content_cards';
const VERSION_COLLECTION = 'nm_content_versions';
const SOURCE_COLLECTION = 'nm_sources';
const ASSET_COLLECTION = 'nm_assets';

const STATUS_DRAFT = 'draft';
const STATUS_IN_REVIEW = 'in_review';
const STATUS_APPROVED = 'approved';
const STATUS_ADOPTED = 'adopted';
const TOPIC_STATUS_CAN_WRITE = 'can_write';
const TOPIC_STATUS_CONVERTED = 'converted';
const CHANNEL_WECHAT_ARTICLE = 'article';

const ROLE_REVIEWER = '审核者';

let isRegistered = false;

export function registerNewMediaHooks() {
	if (isRegistered) return;
	isRegistered = true;

	emitter.onFilter<any>(`${CONTENT_COLLECTION}.items.update`, async (payload, meta, context) => {
		if (!isRecord(payload) || typeof payload['status'] !== 'string') return payload;

		const database = context.database as Knex | undefined;
		const accountability = context.accountability ?? null;

		if (!database) return payload;

		const keys = getPrimaryKeys(meta['keys']);

		if (keys.length === 0) return payload;

		const nextStatus = payload['status'];
		const reviewComment = getText(payload['review_comment']);
		const isReviewer = await hasReviewerCapability(accountability, database);

		const records = await database(CONTENT_COLLECTION).select('id', 'status').whereIn('id', keys);
		const previousStatuses = new Map(records.map((record) => [String(record['id']), String(record['status'] ?? '')]));

		if (nextStatus === STATUS_APPROVED) {
			if (!isReviewer) {
				throw new ForbiddenError({ reason: '仅审核者可以将内容标记为“已通过”。' });
			}

			const invalidTransition = keys.some((key) => previousStatuses.get(String(key)) !== STATUS_IN_REVIEW);

			if (invalidTransition) {
				throw new InvalidPayloadError({ reason: '内容需先进入“预发布”后才能标记为“已通过”。' });
			}
		}

		if (nextStatus === STATUS_DRAFT) {
			const isRejectingFromReview = keys.some((key) => previousStatuses.get(String(key)) === STATUS_IN_REVIEW);

			if (isRejectingFromReview) {
				if (!isReviewer) {
					throw new ForbiddenError({ reason: '仅审核者可以打回“预发布”内容。' });
				}

				if (!reviewComment) {
					throw new InvalidPayloadError({ reason: '打回内容时必须填写审核意见。' });
				}
			}
		}

		return payload;
	});

	emitter.onFilter<any>(`${SIGNAL_COLLECTION}.items.update`, async (payload, meta, context) => {
		if (!isRecord(payload)) return payload;

		const database = context.database as Knex | undefined;
		if (!database) return payload;

		const keys = getPrimaryKeys(meta['keys']);
		if (keys.length === 0) return payload;

		for (const key of keys) {
			const current = await database(SIGNAL_COLLECTION)
				.select(
					'id',
					'status',
					'topic_status',
					'anchor_type',
					'topic_angle',
					'product_relation',
					'reader_takeaway',
					'content_form',
					'audience_type',
					'linked_content',
				)
				.where({ id: key })
				.first();

			if (!current) continue;

			const nextStatus = String(payload['status'] ?? current['status'] ?? '');
			const nextTopicStatus = String(payload['topic_status'] ?? current['topic_status'] ?? '');
			const targetConvert = nextStatus === STATUS_ADOPTED || nextTopicStatus === TOPIC_STATUS_CONVERTED;
			const targetCanWrite = nextTopicStatus === TOPIC_STATUS_CAN_WRITE;

			if (!targetConvert && !targetCanWrite) continue;

			const merged = {
				anchor_type: payload['anchor_type'] ?? current['anchor_type'],
				topic_angle: payload['topic_angle'] ?? current['topic_angle'],
				product_relation: payload['product_relation'] ?? current['product_relation'],
				reader_takeaway: payload['reader_takeaway'] ?? current['reader_takeaway'],
				content_form: payload['content_form'] ?? current['content_form'],
				audience_type: payload['audience_type'] ?? current['audience_type'],
			};

			const requiredForCanWrite = [
				['anchor_type', '锚点类型'],
				['topic_angle', '一句话选题结论'],
				['product_relation', '与产品关系'],
				['reader_takeaway', '用户带走点'],
				['content_form', '建议写法'],
				['audience_type', '目标读者'],
			] as const;

			const requiredForConvert = [
				['anchor_type', '锚点类型'],
				['topic_angle', '一句话选题结论'],
				['product_relation', '与产品关系'],
				['reader_takeaway', '用户带走点'],
			] as const;

			const requiredFields = targetConvert ? requiredForConvert : requiredForCanWrite;
			const missing = requiredFields.filter(([field]) => !getText(merged[field])).map(([, label]) => label);

			if (missing.length > 0 && !current['linked_content']) {
				const actionLabel = targetConvert ? '转为内容卡' : '标记为可写';
				throw new InvalidPayloadError({
					reason: `${actionLabel}前请补全：${missing.join('、')}`,
				});
			}
		}

		return payload;
	});

	emitter.onFilter<any>(`${SIGNAL_COLLECTION}.items.create`, async (payload) => {
		if (!isRecord(payload)) return payload;

		const nextStatus = String(payload['status'] ?? '');
		const nextTopicStatus = String(payload['topic_status'] ?? '');
		const targetConvert = nextStatus === STATUS_ADOPTED || nextTopicStatus === TOPIC_STATUS_CONVERTED;
		const targetCanWrite = nextTopicStatus === TOPIC_STATUS_CAN_WRITE;

		if (!targetConvert && !targetCanWrite) return payload;

		const requiredForCanWrite = [
			['anchor_type', '锚点类型'],
			['topic_angle', '一句话选题结论'],
			['product_relation', '与产品关系'],
			['reader_takeaway', '用户带走点'],
			['content_form', '建议写法'],
			['audience_type', '目标读者'],
		] as const;

		const requiredForConvert = [
			['anchor_type', '锚点类型'],
			['topic_angle', '一句话选题结论'],
			['product_relation', '与产品关系'],
			['reader_takeaway', '用户带走点'],
		] as const;

		const requiredFields = targetConvert ? requiredForConvert : requiredForCanWrite;
		const missing = requiredFields.filter(([field]) => !getText(payload[field])).map(([, label]) => label);

		if (missing.length > 0) {
			const actionLabel = targetConvert ? '转为内容卡' : '标记为可写';
			throw new InvalidPayloadError({
				reason: `${actionLabel}前请补全：${missing.join('、')}`,
			});
		}

		return payload;
	});

	emitter.onAction(`${CONTENT_COLLECTION}.items.update`, async (meta, context) => {
		const payload = meta['payload'];
		const database = context.database as Knex | undefined;
		const accountability = context.accountability ?? null;

		if (!database || !isRecord(payload)) return;

		const keys = getPrimaryKeys(meta['keys']);
		if (keys.length === 0) return;

		if ('body_structured' in payload) {
			for (const key of keys) {
				await syncContentAssetsFromStructuredBody(database, key, accountability?.user ?? null);
			}
		}

		if (typeof payload['status'] !== 'string') return;

		const versionType = getVersionType(payload['status'], getText(payload['review_comment']));
		if (!versionType) return;

		const reviewResult = getReviewResult(payload['status'], getText(payload['review_comment']));

		for (const key of keys) {
			const item = await database(CONTENT_COLLECTION)
				.select(
					'id',
					'title',
					'outline',
					'body',
					'body_structured',
					'summary',
					'cta',
					'risk_notes',
					'status',
					'current_version',
				)
				.where({ id: key })
				.first();

			if (!item) continue;

			const structuredBody = parseStructuredBody(item['body_structured']);
			const imageRefs = extractWechatImageRefs(structuredBody);

			const currentVersion = Number(item['current_version'] ?? 1);
			const nextVersion = Number.isFinite(currentVersion) ? currentVersion + 1 : 1;

			await database(VERSION_COLLECTION).insert({
				content_card: item['id'],
				version_no: nextVersion,
				version_type: versionType,
				changed_by: accountability?.user ?? null,
				changed_at: new Date().toISOString(),
				change_summary:
					getText(payload['version_note']) ||
					getText(payload['review_comment']) ||
					`状态变更为 ${String(item['status'] ?? payload['status'])}`,
				review_result: reviewResult,
				snapshot: JSON.stringify({
					title: item['title'] ?? null,
					outline: item['outline'] ?? null,
					body: item['body'] ?? null,
					body_structured: structuredBody,
					summary: item['summary'] ?? null,
					cta: item['cta'] ?? null,
					risk_notes: item['risk_notes'] ?? null,
					status: item['status'] ?? null,
					wechat_image_refs: imageRefs,
				}),
				is_final: payload['status'] === STATUS_APPROVED,
			});

			await database(CONTENT_COLLECTION).where({ id: item['id'] }).update({ current_version: nextVersion });
		}
	});

	emitter.onAction(`${CONTENT_COLLECTION}.items.create`, async (meta, context) => {
		const payload = meta['payload'];
		const database = context.database as Knex | undefined;
		const accountability = context.accountability ?? null;

		if (!database || !isRecord(payload) || !('body_structured' in payload)) return;

		const keys = getPrimaryKeys(meta['keys'] ?? meta['key']);
		if (keys.length === 0) return;

		for (const key of keys) {
			await syncContentAssetsFromStructuredBody(database, key, accountability?.user ?? null);
		}
	});

	emitter.onAction(`${SIGNAL_COLLECTION}.items.update`, async (meta, context) => {
		const payload = meta['payload'];
		const database = context.database as Knex | undefined;
		const accountability = context.accountability ?? null;

		if (!database || !isRecord(payload)) return;

		const keys = getPrimaryKeys(meta['keys']);

		for (const key of keys) {
			await syncSignalSnapshot(database, key);
		}

		if (payload['status'] !== STATUS_ADOPTED && payload['topic_status'] !== TOPIC_STATUS_CONVERTED) return;

		for (const key of keys) {
			await tryCreateContentFromSignalDecision(database, key, accountability?.user ?? null);
		}
	});

	emitter.onAction(`${SIGNAL_COLLECTION}.items.create`, async (meta, context) => {
		const payload = meta['payload'];
		const database = context.database as Knex | undefined;
		const accountability = context.accountability ?? null;

		if (!database || !isRecord(payload)) return;

		const keys = getPrimaryKeys(meta['keys'] ?? meta['key']);
		for (const key of keys) {
			await syncSignalSnapshot(database, key);
		}

		if (payload['status'] !== STATUS_ADOPTED && payload['topic_status'] !== TOPIC_STATUS_CONVERTED) return;

		for (const key of keys) {
			await tryCreateContentFromSignalDecision(database, key, accountability?.user ?? null);
		}
	});
}

async function tryCreateContentFromSignalDecision(
	database: Knex,
	signalId: string | number,
	converterUserId: string | null,
) {
	const signal = await database(SIGNAL_COLLECTION)
		.select(
			'id',
			'title',
			'signal_title',
			'signal_url',
			'topic_status',
			'anchor_type',
			'topic_angle',
			'product_relation',
			'reader_takeaway',
			'publish_reason',
			'content_form',
			'audience_type',
			'title_direction',
			'topic_note',
			'source_ref',
			'source_name_snapshot',
			'source_note_snapshot',
			'suggested_direction',
			'submitted_by',
			'linked_content',
			'status',
		)
		.where({ id: signalId })
		.first();

	if (!signal) return;
	const canConvert =
		signal['status'] === STATUS_ADOPTED ||
		signal['topic_status'] === TOPIC_STATUS_CAN_WRITE ||
		signal['topic_status'] === TOPIC_STATUS_CONVERTED;
	if (!canConvert) return;
	if (signal['linked_content']) return;

	const source =
		signal['source_ref'] != null
			? await database(SOURCE_COLLECTION)
					.select('id', 'name', 'source_link', 'note')
					.where({ id: signal['source_ref'] })
					.first()
			: null;

	const signalTitle = getText(signal['signal_title']) || getText(signal['title']) || '未命名选题';
	const sourceNameSnapshot = getText(signal['source_name_snapshot']) || getText(source?.['name']);
	const sourceUrlSnapshot = getText(signal['signal_url']) || getText(source?.['source_link']);
	const sourceNoteSnapshot = getText(signal['source_note_snapshot']) || getText(source?.['note']);

	const contentCode = await generateContentCode(database);
	const inserted = await database(CONTENT_COLLECTION)
		.insert({
			title: signalTitle,
			code: contentCode,
			content_type: 'brand',
			channel_type: 'article',
			content_goal: signal['suggested_direction'] ?? 'anchor',
			owner: signal['submitted_by'] ?? null,
			reviewer: null,
			status: STATUS_DRAFT,
			current_version: 1,
			linked_signal: signal['id'],
			signal_title_snapshot: signalTitle,
			signal_url_snapshot: getText(signal['signal_url']) || null,
			topic_anchor_type: getText(signal['anchor_type']) || null,
			topic_angle: getText(signal['topic_angle']) || null,
			topic_product_relation: getText(signal['product_relation']) || null,
			topic_reader_takeaway: getText(signal['reader_takeaway']) || null,
			topic_publish_reason: getText(signal['publish_reason']) || null,
			topic_content_form: getText(signal['content_form']) || null,
			topic_audience_type: getText(signal['audience_type']) || null,
			topic_title_direction: getText(signal['title_direction']) || null,
			topic_note_snapshot: getText(signal['topic_note']) || null,
			primary_source: source?.['id'] ?? null,
			source_name_snapshot: sourceNameSnapshot || null,
			source_url_snapshot: sourceUrlSnapshot || null,
			source_note_snapshot: sourceNoteSnapshot || null,
			summary: getText(signal['reader_takeaway']) || null,
			outline: getText(signal['topic_angle']) || null,
		})
		.returning('id');

	const createdId = getReturningId(inserted);
	if (!createdId) return;

	await database(SIGNAL_COLLECTION)
		.where({ id: signal['id'] })
		.update({
			linked_content: createdId,
			status: STATUS_ADOPTED,
			topic_status: TOPIC_STATUS_CONVERTED,
			converted_at: new Date().toISOString(),
			converted_by: converterUserId,
			converted_content_snapshot: `${contentCode} | ${signalTitle}`,
		});
}

async function syncSignalSnapshot(database: Knex, signalId: string | number) {
	const signal = await database(SIGNAL_COLLECTION)
		.select(
			'id',
			'title',
			'signal_title',
			'signal_type',
			'source_type',
			'signal_url',
			'source_link',
			'source_ref',
			'source_name_snapshot',
			'source_note_snapshot',
			'topic_status',
			'linked_content',
		)
		.where({ id: signalId })
		.first();

	if (!signal) return;

	const patch: Record<string, unknown> = {};
	const signalTitle = getText(signal['signal_title']) || getText(signal['title']);
	const signalUrl = getText(signal['signal_url']) || getText(signal['source_link']);

	if (signalTitle && getText(signal['signal_title']) !== signalTitle) patch['signal_title'] = signalTitle;
	if (signalTitle && getText(signal['title']) !== signalTitle) patch['title'] = signalTitle;
	if (signalUrl && getText(signal['signal_url']) !== signalUrl) patch['signal_url'] = signalUrl;
	if (signalUrl && getText(signal['source_link']) !== signalUrl) patch['source_link'] = signalUrl;
	if (signal['linked_content'] != null && getText(signal['topic_status']) !== TOPIC_STATUS_CONVERTED) {
		patch['topic_status'] = TOPIC_STATUS_CONVERTED;
	}

	if (!getText(signal['signal_type'])) {
		patch['signal_type'] = mapSignalType(getText(signal['source_type']), signalUrl);
	}

	if (signal['source_ref'] != null) {
		const source = await database(SOURCE_COLLECTION).select('name', 'note').where({ id: signal['source_ref'] }).first();

		if (source) {
			const sourceNameSnapshot = getText(source['name']);
			const sourceNoteSnapshot = getText(source['note']);

			if (sourceNameSnapshot && getText(signal['source_name_snapshot']) !== sourceNameSnapshot) {
				patch['source_name_snapshot'] = sourceNameSnapshot;
			}

			if (sourceNoteSnapshot && getText(signal['source_note_snapshot']) !== sourceNoteSnapshot) {
				patch['source_note_snapshot'] = sourceNoteSnapshot;
			}
		}
	}

	if (Object.keys(patch).length === 0) return;

	await database(SIGNAL_COLLECTION).where({ id: signal['id'] }).update(patch);
}

async function syncContentAssetsFromStructuredBody(
	database: Knex,
	contentId: string | number,
	editorUserId: string | null,
) {
	const content = await database(CONTENT_COLLECTION)
		.select('id', 'title', 'channel_type', 'body_structured')
		.where({ id: contentId })
		.first();

	if (!content) return;
	if (content['channel_type'] !== CHANNEL_WECHAT_ARTICLE) return;

	const structuredBody = parseStructuredBody(content['body_structured']);
	const imageRefs = extractWechatImageRefs(structuredBody).filter((ref) => ref.fileId);
	if (imageRefs.length === 0) return;

	const uniqueFileIds = Array.from(new Set(imageRefs.map((ref) => ref.fileId)));
	const existingAssets = await database(ASSET_COLLECTION)
		.select('id', 'file', 'note')
		.where({ content_card: content['id'] })
		.whereIn('file', uniqueFileIds);

	const existingByFile = new Map(
		existingAssets
			.map((asset) => [getComparableId(asset['file']), asset] as const)
			.filter(([fileId]) => fileId.length > 0),
	);

	for (const [index, imageRef] of imageRefs.entries()) {
		const fileId = imageRef.fileId;
		if (!fileId) continue;

		const existing = existingByFile.get(fileId);
		if (existing) {
			const note = getText(existing['note']);
			if (!note && imageRef.caption) {
				await database(ASSET_COLLECTION).where({ id: existing['id'] }).update({ note: imageRef.caption });
			}
			continue;
		}

		await database(ASSET_COLLECTION).insert({
			name: imageRef.assetName || `${getText(content['title']) || '内容'} 配图 ${index + 1}`,
			asset_type: 'image',
			content_card: content['id'],
			uploader: editorUserId,
			file: fileId,
			is_final: false,
			note: imageRef.caption || null,
		});
	}
}

function parseStructuredBody(value: unknown): Record<string, any> | null {
	if (!value) return null;

	if (typeof value === 'string') {
		try {
			const parsed = JSON.parse(value);
			return isRecord(parsed) ? parsed : null;
		} catch {
			return null;
		}
	}

	return isRecord(value) ? value : null;
}

function extractWechatImageRefs(structuredBody: Record<string, any> | null): Array<{
	fileId: string;
	assetId: string;
	assetName: string;
	caption: string;
	url: string;
}> {
	if (!structuredBody || !Array.isArray(structuredBody['blocks'])) return [];

	return structuredBody['blocks']
		.filter((block) => isRecord(block) && block['type'] === 'image')
		.map((block) => {
			const data = isRecord(block['data']) ? block['data'] : {};
			const file = isRecord(data['file']) ? data['file'] : {};
			const fileId = getComparableId(file['fileId'] ?? file['id']);
			const assetId = getComparableId(file['assetId']);
			const assetName = getText(file['assetName']);
			const caption = getText(data['caption']);
			const url = getText(file['url'] ?? file['fileURL']);

			return {
				fileId,
				assetId,
				assetName,
				caption,
				url,
			};
		})
		.filter((item) => item.fileId.length > 0 || item.url.length > 0);
}

async function hasReviewerCapability(accountability: Accountability | null, database: Knex): Promise<boolean> {
	if (!accountability) return false;
	if (accountability.admin === true) return true;
	if (!accountability.role) return false;

	const role = await database('directus_roles').select('name').where({ id: accountability.role }).first();
	return role?.name === ROLE_REVIEWER;
}

function getPrimaryKeys(keys: unknown): (string | number)[] {
	if (typeof keys === 'string' || typeof keys === 'number') return [keys];
	if (!Array.isArray(keys)) return [];
	return keys.filter((key) => ['string', 'number'].includes(typeof key)) as (string | number)[];
}

function getVersionType(status: string, reviewComment: string): string | null {
	if (status === STATUS_IN_REVIEW) return 'submission';
	if (status === STATUS_DRAFT && reviewComment) return 'rejected';
	if (status === STATUS_APPROVED) return 'approved';
	return null;
}

function getReviewResult(status: string, reviewComment: string): string | null {
	if (status === STATUS_APPROVED) return '通过';
	if (status === STATUS_DRAFT && reviewComment) return '打回';
	if (status === STATUS_IN_REVIEW) return '送审';
	return null;
}

async function generateContentCode(database: Knex): Promise<string> {
	const now = new Date();
	const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(
		2,
		'0',
	)}`;
	const prefix = `WX${ymd}-`;

	const latest = await database(CONTENT_COLLECTION)
		.select('code')
		.where('code', 'like', `${prefix}%`)
		.orderBy('code', 'desc')
		.first();

	const latestCode = typeof latest?.code === 'string' ? latest.code : '';
	const latestSequence = Number(latestCode.split('-')[1] ?? 0);
	const nextSequence = Number.isFinite(latestSequence) ? latestSequence + 1 : 1;

	return `${prefix}${String(nextSequence).padStart(3, '0')}`;
}

function getReturningId(result: unknown): string | number | null {
	if (Array.isArray(result)) {
		const first = result[0];

		if (typeof first === 'number' || typeof first === 'string') return first;
		if (isRecord(first) && (typeof first['id'] === 'number' || typeof first['id'] === 'string')) return first['id'];
	}

	return null;
}

function getText(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function getComparableId(value: unknown): string {
	if (typeof value === 'string' || typeof value === 'number') return String(value);
	if (isRecord(value) && (typeof value['id'] === 'string' || typeof value['id'] === 'number')) {
		return String(value['id']);
	}
	return '';
}

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mapSignalType(sourceType: string, signalUrl: string): string {
	if (sourceType === 'youtube') return 'video';
	if (sourceType === 'twitter') return 'tweet';
	if (sourceType === 'report') return 'report';
	if (sourceType === 'wechat' || sourceType === 'tech_site' || sourceType === 'kol') return 'article';

	const normalized = signalUrl.toLowerCase();
	if (normalized.includes('youtube.com') || normalized.includes('bilibili.com') || normalized.includes('video')) {
		return 'video';
	}
	if (normalized.includes('x.com') || normalized.includes('twitter.com')) return 'tweet';
	if (normalized.includes('report')) return 'report';
	if (normalized.includes('announcement') || normalized.includes('notice')) return 'announcement';

	return 'other';
}
