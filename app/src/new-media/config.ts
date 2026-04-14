export type NewMediaCollectionKey =
	| 'nm_sources'
	| 'nm_signals'
	| 'nm_content_cards'
	| 'nm_assets'
	| 'nm_content_versions';

const DEFAULT_COLLECTION_ORDER: NewMediaCollectionKey[] = [
	'nm_sources',
	'nm_signals',
	'nm_content_cards',
	'nm_assets',
	'nm_content_versions',
];

export const NEW_MEDIA_PRODUCT_NAME = __NEW_MEDIA_PRODUCT_NAME__ || '新媒体内容中台';
export const NEW_MEDIA_PRODUCT_VERSION = __NEW_MEDIA_PRODUCT_VERSION__ || '';
export const NEW_MEDIA_PRODUCT_TITLE = __NEW_MEDIA_PRODUCT_TITLE__ || NEW_MEDIA_PRODUCT_NAME;

const runtimeCollectionOrder = Array.isArray(__NEW_MEDIA_COLLECTION_ORDER__) ? __NEW_MEDIA_COLLECTION_ORDER__ : [];

export const NEW_MEDIA_COLLECTION_ORDER = Array.from(
	new Set([...runtimeCollectionOrder, ...DEFAULT_COLLECTION_ORDER]),
) as string[];

export const NEW_MEDIA_COLLECTION_SET = new Set(NEW_MEDIA_COLLECTION_ORDER);

export const NEW_MEDIA_COLLECTION_ORDER_MAP = NEW_MEDIA_COLLECTION_ORDER.reduce<Record<string, number>>(
	(accumulator, collection, index) => {
		accumulator[collection] = index;
		return accumulator;
	},
	{},
);

export function isNewMediaCollection(collectionKey: string | null | undefined): boolean {
	if (!collectionKey) return false;
	return NEW_MEDIA_COLLECTION_SET.has(collectionKey);
}

export function getNewMediaCollectionOrderIndex(collectionKey: string | null | undefined): number {
	if (!collectionKey) return -1;
	return NEW_MEDIA_COLLECTION_ORDER_MAP[collectionKey] ?? -1;
}
