import { useCollection, useItems, useSync } from '@directus/composables';
import { defineLayout } from '@directus/extensions';
import { Field } from '@directus/types';
import { useElementSize, useWindowSize } from '@vueuse/core';
import { debounce, flatten } from 'lodash';
import { computed, inject, Ref, ref, toRefs, unref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import TabularActions from './actions.vue';
import TabularOptions from './options.vue';
import TabularLayout from './tabular.vue';
import { LayoutOptions, LayoutQuery } from './types';
import { useAiToolsStore } from '@/ai/stores/use-ai-tools';
import { HeaderRaw, Sort } from '@/components/v-table/types';
import { useAliasFields } from '@/composables/use-alias-fields';
import { useLayoutClickHandler } from '@/composables/use-layout-click-handler';
import { isNewMediaCollection } from '@/new-media/config';
import { useFieldsStore } from '@/stores/fields';
import { adjustFieldsForDisplays } from '@/utils/adjust-fields-for-displays';
import { formatItemsCountPaginated } from '@/utils/format-items-count';
import { getDefaultDisplayForType } from '@/utils/get-default-display-for-type';
import { hideDragImage } from '@/utils/hide-drag-image';
import { saveAsCSV } from '@/utils/save-as-csv';
import { syncRefProperty } from '@/utils/sync-ref-property';

type NewMediaColumnImportance = 'high' | 'medium' | 'low';

const NEW_MEDIA_LOW_IMPORTANCE_FIELDS = new Set([
	'id',
	'is_final',
	'publish_ready',
	'final_version_id',
	'accepted_at',
	'changed_at',
	'modified_at',
	'created_at',
	'updated_at',
	'current_version',
	'version_no',
	'converted_at',
]);

const NEW_MEDIA_MEDIUM_IMPORTANCE_FIELDS = new Set([
	'status',
	'topic_status',
	'signal_type',
	'anchor_type',
	'product_relation',
	'content_form',
	'audience_type',
	'publish_reason',
	'content_type',
	'content_goal',
	'channel_type',
	'source_type',
	'asset_type',
	'quality_rating',
	'review_result',
	'version_type',
	'source_ref',
	'submitted_by',
	'owner',
	'reviewer',
	'content_card',
	'changed_by',
	'linked_content',
	'target_role',
]);

const NEW_MEDIA_GROW_WEIGHTS: Record<NewMediaColumnImportance, number> = {
	high: 6,
	medium: 3,
	low: 1,
};

const GENERIC_COMPACT_WIDTH: Record<string, number> = {
	id: 72,
	status: 120,
	topic_status: 120,
	anchor_type: 136,
	product_relation: 156,
	content_form: 132,
	audience_type: 136,
	publish_reason: 156,
	version_no: 96,
	current_version: 96,
	is_final: 84,
	suggested_direction: 112,
	content_goal: 112,
	content_type: 120,
	signal_type: 118,
	channel_type: 136,
	source_type: 128,
	asset_type: 120,
	quality_rating: 100,
	review_result: 112,
};

const NEW_MEDIA_COLUMN_PRESETS: Record<
	string,
	{
		wide: Record<string, number>;
		compact: Record<string, number>;
		multiline: Set<string>;
	}
> = {
	nm_signals: {
		wide: {
			signal_title: 340,
			topic_angle: 340,
			reader_takeaway: 320,
			title_direction: 320,
			source_summary: 300,
			xyunapi_relevance: 300,
			why_it_matters: 280,
			source_note_snapshot: 240,
			signal_url: 240,
		},
		compact: {
			id: 72,
			status: 108,
			topic_status: 120,
			anchor_type: 132,
			product_relation: 150,
			content_form: 130,
			signal_type: 118,
			suggested_direction: 112,
			source_ref: 132,
			submitted_by: 132,
			linked_content: 140,
		},
		multiline: new Set([
			'signal_title',
			'topic_angle',
			'reader_takeaway',
			'title_direction',
			'source_summary',
			'xyunapi_relevance',
			'why_it_matters',
		]),
	},
	nm_content_cards: {
		wide: {
			title: 520,
			summary: 420,
			outline: 420,
			risk_notes: 360,
			source_note_snapshot: 340,
		},
		compact: {
			id: 72,
			status: 120,
			content_type: 120,
			channel_type: 136,
			content_goal: 112,
			current_version: 96,
			code: 136,
			owner: 140,
			reviewer: 140,
		},
		multiline: new Set(['title', 'summary', 'outline', 'risk_notes']),
	},
	nm_sources: {
		wide: {
			name: 300,
			note: 460,
			source_link: 320,
		},
		compact: {
			id: 72,
			source_type: 128,
			quality_rating: 100,
			last_used_content: 148,
		},
		multiline: new Set(['note']),
	},
	nm_assets: {
		wide: {
			name: 280,
			note: 420,
		},
		compact: {
			id: 72,
			asset_type: 120,
			is_final: 84,
			content_card: 148,
			uploader: 140,
		},
		multiline: new Set(['name', 'note']),
	},
	nm_content_versions: {
		wide: {
			change_summary: 420,
			snapshot: 560,
		},
		compact: {
			id: 72,
			version_no: 96,
			version_type: 120,
			review_result: 112,
			is_final: 84,
			changed_by: 140,
		},
		multiline: new Set(['change_summary']),
	},
};

const NEW_MEDIA_DEFAULT_FIELDS: Record<string, string[]> = {
	nm_signals: [
		'topic_status',
		'anchor_type',
		'product_relation',
		'content_form',
		'signal_title',
		'source_summary',
		'source_ref',
	],
	nm_content_cards: ['status', 'title', 'summary', 'content_type', 'channel_type', 'content_goal', 'owner'],
	nm_sources: ['name', 'source_type', 'source_link', 'note', 'quality_rating'],
	nm_assets: ['name', 'asset_type', 'content_card', 'note', 'is_final'],
	nm_content_versions: ['version_no', 'version_type', 'change_summary', 'review_result', 'changed_at'],
};

const NEW_MEDIA_DEFAULT_FIELDS_MEDIUM: Record<string, string[]> = {
	nm_signals: ['topic_status', 'anchor_type', 'product_relation', 'signal_title', 'source_summary', 'source_ref'],
	nm_content_cards: ['status', 'title', 'summary', 'content_type', 'content_goal', 'owner'],
	nm_sources: ['name', 'source_type', 'quality_rating', 'note'],
	nm_assets: ['name', 'asset_type', 'content_card', 'is_final'],
	nm_content_versions: ['version_no', 'version_type', 'review_result', 'changed_at'],
};

const NEW_MEDIA_DEFAULT_FIELDS_COMPACT: Record<string, string[]> = {
	nm_signals: ['topic_status', 'anchor_type', 'signal_title', 'source_ref'],
	nm_content_cards: ['status', 'title', 'summary', 'content_type', 'owner'],
	nm_sources: ['name', 'source_type', 'quality_rating'],
	nm_assets: ['name', 'asset_type', 'is_final'],
	nm_content_versions: ['version_no', 'version_type', 'review_result'],
};

const NEW_MEDIA_MIN_COLUMN_WIDTH: Record<string, number> = {
	id: 64,
	status: 96,
	topic_status: 102,
	anchor_type: 118,
	product_relation: 132,
	content_form: 118,
	audience_type: 118,
	publish_reason: 132,
	signal_type: 98,
	content_type: 96,
	content_goal: 96,
	channel_type: 104,
	source_type: 104,
	asset_type: 96,
	quality_rating: 88,
	review_result: 92,
	version_no: 88,
	version_type: 96,
	current_version: 88,
	is_final: 72,
	source_ref: 104,
	submitted_by: 104,
	owner: 104,
	reviewer: 104,
	content_card: 104,
	changed_by: 104,
	signal_title: 220,
	title: 220,
	summary: 180,
	source_summary: 180,
	topic_angle: 220,
	reader_takeaway: 200,
	title_direction: 200,
	change_summary: 180,
	note: 160,
};

const NEW_MEDIA_FALLBACK_MIN_COLUMN_WIDTH: Record<string, number> = {
	id: 56,
	status: 84,
	topic_status: 92,
	anchor_type: 106,
	product_relation: 118,
	content_form: 106,
	audience_type: 106,
	publish_reason: 118,
	signal_type: 88,
	content_type: 88,
	content_goal: 88,
	channel_type: 96,
	source_type: 96,
	asset_type: 92,
	quality_rating: 80,
	review_result: 84,
	version_no: 80,
	version_type: 88,
	current_version: 80,
	is_final: 64,
	source_ref: 96,
	submitted_by: 96,
	owner: 96,
	reviewer: 96,
	content_card: 96,
	changed_by: 96,
	signal_title: 180,
	title: 180,
	summary: 140,
	source_summary: 140,
	topic_angle: 170,
	reader_takeaway: 156,
	title_direction: 156,
	change_summary: 140,
	note: 128,
};

function getResponsiveNewMediaDefaultFields(collectionKey: string, viewportWidth: number): string[] | undefined {
	if (viewportWidth <= 1366) return NEW_MEDIA_DEFAULT_FIELDS_COMPACT[collectionKey];
	if (viewportWidth <= 1600) return NEW_MEDIA_DEFAULT_FIELDS_MEDIUM[collectionKey];
	return NEW_MEDIA_DEFAULT_FIELDS[collectionKey];
}

function getNewMediaTableWidthBudget(availableWidth: number): number {
	const horizontalReserved =
		availableWidth >= 1680 ? 56 : availableWidth >= 1366 ? 48 : availableWidth >= 960 ? 36 : 28;
	return Math.max(480, Math.min(1560, availableWidth - horizontalReserved));
}

function getNewMediaColumnImportance(
	fieldKey: string,
	preset:
		| {
				wide: Record<string, number>;
				compact: Record<string, number>;
				multiline: Set<string>;
		  }
		| undefined,
): NewMediaColumnImportance {
	const normalizedFieldKey = fieldKey.split('.').at(-1) ?? fieldKey;

	if (NEW_MEDIA_LOW_IMPORTANCE_FIELDS.has(normalizedFieldKey)) return 'low';
	if (preset?.wide[fieldKey] || preset?.wide[normalizedFieldKey]) return 'high';
	if (NEW_MEDIA_MEDIUM_IMPORTANCE_FIELDS.has(normalizedFieldKey)) return 'medium';
	if (preset?.compact[fieldKey] || preset?.compact[normalizedFieldKey]) return 'medium';

	return 'high';
}

function getNewMediaMinColumnWidth(fieldKey: string, importance: NewMediaColumnImportance): number {
	const normalizedFieldKey = fieldKey.split('.').at(-1) ?? fieldKey;
	return (
		NEW_MEDIA_MIN_COLUMN_WIDTH[normalizedFieldKey] ?? (importance === 'high' ? 180 : importance === 'medium' ? 96 : 76)
	);
}

function getNewMediaFallbackMinColumnWidth(fieldKey: string, importance: NewMediaColumnImportance): number {
	const normalizedFieldKey = fieldKey.split('.').at(-1) ?? fieldKey;
	return (
		NEW_MEDIA_FALLBACK_MIN_COLUMN_WIDTH[normalizedFieldKey] ??
		(importance === 'high' ? 150 : importance === 'medium' ? 84 : 64)
	);
}

function fitHeadersToViewport(headers: HeaderRaw[], viewportWidth: number): HeaderRaw[] {
	if (headers.length === 0) return headers;

	type ResponsiveHeader = HeaderRaw & {
		_minWidth: number;
		_fallbackMinWidth: number;
		_isPriority: boolean;
		_importance: NewMediaColumnImportance;
	};

	const prepared = headers.map((header) => {
		const fieldKey = String(header.value ?? '');
		const importance = ((header as { importance?: NewMediaColumnImportance }).importance ??
			((header as { priority?: boolean }).priority ? 'high' : 'medium')) as NewMediaColumnImportance;
		const isPriority = importance === 'high';
		const minWidth = getNewMediaMinColumnWidth(fieldKey, importance);
		const fallbackMinWidth = Math.min(minWidth, getNewMediaFallbackMinColumnWidth(fieldKey, importance));
		const width = Math.max(minWidth, Math.round(Number(header.width ?? 144)));

		return {
			...header,
			width,
			_minWidth: minWidth,
			_fallbackMinWidth: fallbackMinWidth,
			_isPriority: isPriority,
			_importance: importance,
		} as ResponsiveHeader;
	});

	const budget = getNewMediaTableWidthBudget(viewportWidth);
	const totalWidth = prepared.reduce((sum, header) => sum + Number(header.width ?? 0), 0);

	if (totalWidth <= budget) {
		const expanded = distributeRemainingWidth(prepared, budget - totalWidth);
		return expanded.map(({ _minWidth, _fallbackMinWidth, _isPriority, _importance, ...header }) => header as HeaderRaw);
	}

	const compressionRatio = budget / totalWidth;
	let compressed = prepared.map((header) => {
		const scaledWidth = Math.round(Number(header.width ?? 144) * compressionRatio);
		return {
			...header,
			width: Math.max(header._minWidth, scaledWidth),
		} as ResponsiveHeader;
	});

	let overflow = compressed.reduce((sum, header) => sum + Number(header.width ?? 0), 0) - budget;

	overflow = reduceOverflow(compressed, overflow, (header) => header._minWidth);
	overflow = reduceOverflow(compressed, overflow, (header) => header._fallbackMinWidth);
	overflow = reduceOverflow(compressed, overflow, (header) =>
		header._importance === 'high' ? 132 : header._importance === 'medium' ? 84 : 56,
	);

	const finalTotalWidth = compressed.reduce((sum, header) => sum + Number(header.width ?? 0), 0);
	if (finalTotalWidth < budget) {
		compressed = distributeRemainingWidth(compressed, budget - finalTotalWidth);
	}

	return compressed.map(({ _minWidth, _fallbackMinWidth, _isPriority, _importance, ...header }) => header as HeaderRaw);

	function reduceOverflow(
		responsiveHeaders: ResponsiveHeader[],
		currentOverflow: number,
		getFloor: (header: ResponsiveHeader) => number,
	): number {
		if (currentOverflow <= 0) return currentOverflow;

		const shrinkOrder = responsiveHeaders
			.map((header, index) => {
				const floor = getFloor(header);
				const shrinkable = Number(header.width ?? 0) - floor;
				return { index, floor, shrinkable, importance: header._importance };
			})
			.filter((entry) => entry.shrinkable > 0)
			.sort((a, b) => {
				if (a.importance !== b.importance) {
					return getShrinkPriority(a.importance) - getShrinkPriority(b.importance);
				}
				return b.shrinkable - a.shrinkable;
			});

		for (const entry of shrinkOrder) {
			if (currentOverflow <= 0) break;

			const header = responsiveHeaders[entry.index]!;
			const currentWidth = Number(header.width ?? 0);
			const shrinkable = currentWidth - entry.floor;

			if (shrinkable <= 0) continue;

			const shrinkBy = Math.min(shrinkable, currentOverflow);
			header.width = currentWidth - shrinkBy;
			currentOverflow -= shrinkBy;
		}

		return currentOverflow;
	}

	function distributeRemainingWidth(responsiveHeaders: ResponsiveHeader[], extraWidth: number): ResponsiveHeader[] {
		if (extraWidth <= 0 || responsiveHeaders.length === 0) return responsiveHeaders;

		const weightedHeaders = responsiveHeaders.map((header, index) => ({
			index,
			weight: NEW_MEDIA_GROW_WEIGHTS[header._importance] ?? 1,
		}));
		const totalWeight = weightedHeaders.reduce((sum, header) => sum + header.weight, 0);

		let allocated = 0;

		for (const { index, weight } of weightedHeaders) {
			const addWidth = Math.floor((extraWidth * weight) / totalWeight);
			if (addWidth <= 0) continue;

			const header = responsiveHeaders[index]!;
			header.width = Number(header.width ?? 0) + addWidth;
			allocated += addWidth;
		}

		let remaining = extraWidth - allocated;

		if (remaining > 0) {
			const growOrder = [...weightedHeaders].sort((a, b) => {
				if (a.weight !== b.weight) return b.weight - a.weight;
				return a.index - b.index;
			});

			let pointer = 0;
			while (remaining > 0 && growOrder.length > 0) {
				const target = growOrder[pointer % growOrder.length]!;
				const header = responsiveHeaders[target.index]!;
				header.width = Number(header.width ?? 0) + 1;
				pointer += 1;
				remaining -= 1;
			}
		}

		return responsiveHeaders;
	}

	function getShrinkPriority(importance: NewMediaColumnImportance): number {
		switch (importance) {
			case 'low':
				return 0;
			case 'medium':
				return 1;
			case 'high':
			default:
				return 2;
		}
	}
}

export default defineLayout<LayoutOptions, LayoutQuery>({
	id: 'tabular',
	name: '$t:layouts.tabular.tabular',
	icon: 'table_rows',
	component: TabularLayout,
	slots: {
		options: TabularOptions,
		sidebar: () => undefined,
		actions: TabularActions,
	},
	headerShadow: false,
	setup(props, { emit }) {
		const { t, n } = useI18n();
		const fieldsStore = useFieldsStore();
		const { width: viewportWidth } = useWindowSize();
		const mainElement = inject<Ref<Element | undefined>>('main-element', ref<Element>());
		const { width: mainElementWidth } = useElementSize(mainElement);
		const responsiveWidth = computed(() => {
			const containerWidth = Math.round(mainElementWidth.value || 0);
			return containerWidth > 0 ? containerWidth : viewportWidth.value;
		});

		const toolsStore = useAiToolsStore();

		toolsStore.onSystemToolResult((tool, input) => {
			if (tool === 'items' && input.collection === collection.value) {
				refresh();
			}
		});

		const selection = useSync(props, 'selection', emit);
		const layoutOptions = useSync(props, 'layoutOptions', emit);
		const layoutQuery = useSync(props, 'layoutQuery', emit);

		const { collection, filter, filterSystem, filterUser, search } = toRefs(props);

		const { info, primaryKeyField, fields: fieldsInCollection, sortField } = useCollection(collection);

		const { sort, limit, page, fields } = useItemOptions();

		const { aliasedFields, aliasQuery, aliasedKeys } = useAliasFields(fields, collection);

		const fieldsWithRelationalAliased = computed(() =>
			flatten(Object.values(aliasedFields.value).map(({ fields }) => fields)),
		);

		const { onClick } = useLayoutClickHandler({ props, selection, primaryKeyField });

		const {
			items,
			loading,
			loadingItemCount,
			error,
			totalPages,
			itemCount,
			totalCount,
			changeManualSort,
			getItems,
			getItemCount,
			getTotalCount,
		} = useItems(collection, {
			sort,
			limit,
			page,
			fields: fieldsWithRelationalAliased,
			alias: aliasQuery,
			filter,
			search,
			filterSystem,
		});

		const { tableSort, tableHeaders, tableRowHeight, onSortChange, onAlignChange, activeFields, tableSpacing } =
			useTable();

		const showingCount = computed(() => {
			// Don't show count if there are no items
			if (!totalCount.value || !itemCount.value) return;

			return formatItemsCountPaginated({
				currentItems: itemCount.value,
				currentPage: page.value,
				perPage: limit.value,
				isFiltered: !!filterUser.value,
				totalItems: totalCount.value,
				i18n: { t, n },
			});
		});

		return {
			tableHeaders,
			items,
			loading,
			loadingItemCount,
			error,
			totalPages,
			tableSort,
			onRowClick: onClick,
			onSortChange,
			onAlignChange,
			tableRowHeight,
			page,
			toPage,
			itemCount,
			totalCount,
			fieldsInCollection,
			fields,
			limit,
			activeFields,
			tableSpacing,
			primaryKeyField,
			info,
			showingCount,
			sortField,
			changeManualSort,
			hideDragImage,
			refresh,
			resetPresetAndRefresh,
			selectAll,
			filter,
			search,
			download,
			fieldsWithRelationalAliased,
			aliasedFields,
			aliasedKeys,
		};

		async function resetPresetAndRefresh() {
			await props?.resetPreset?.();
			refresh();
		}

		function refresh() {
			getItems();
			getTotalCount();
			getItemCount();
		}

		function download() {
			if (!collection.value) return;
			saveAsCSV(collection.value, fields.value, items.value);
		}

		function toPage(newPage: number) {
			page.value = newPage;
		}

		function selectAll() {
			if (!primaryKeyField.value) return;
			const pk = primaryKeyField.value;
			selection.value = items.value.map((item) => item[pk.field]);
		}

		function useItemOptions() {
			const page = syncRefProperty(layoutQuery, 'page', 1);
			const limit = syncRefProperty(layoutQuery, 'limit', 25);

			const defaultSort = computed(() => {
				const field = sortField.value ?? primaryKeyField.value?.field;
				return field ? [field] : [];
			});

			const sort = syncRefProperty(layoutQuery, 'sort', defaultSort);

			const fieldsDefaultValue = computed(() => {
				const collectionKey = collection.value ?? '';
				const preferredFields = isNewMediaCollection(collectionKey)
					? getResponsiveNewMediaDefaultFields(collectionKey, responsiveWidth.value)
					: NEW_MEDIA_DEFAULT_FIELDS[collectionKey];

				if (preferredFields && preferredFields.length > 0) {
					const availableFields = new Set(fieldsInCollection.value.map((field) => field.field));

					return preferredFields.filter((field) => availableFields.has(field));
				}

				return fieldsInCollection.value
					.filter((field) => !field.meta?.hidden && !field.meta?.special?.includes('no-data'))
					.slice(0, 4)
					.map(({ field }) => field)
					.sort();
			});

			const fields = computed({
				get() {
					if (layoutQuery.value?.fields) {
						return layoutQuery.value.fields.filter((field) => fieldsStore.getField(collection.value!, field));
					} else {
						return unref(fieldsDefaultValue);
					}
				},
				set(value) {
					layoutQuery.value = Object.assign({}, layoutQuery.value, { fields: value });
				},
			});

			const fieldsWithRelational = computed(() => {
				if (!props.collection) return [];
				return adjustFieldsForDisplays(fields.value, props.collection);
			});

			return { sort, limit, page, fields, fieldsWithRelational };
		}

		function useTable() {
			const isNewMediaCollectionView = computed(() => isNewMediaCollection(collection.value ?? ''));

			const tableSort = computed(() => {
				if (!sort.value?.[0]) {
					return null;
				} else if (sort.value?.[0].startsWith('-')) {
					return { by: sort.value[0].substring(1), desc: true };
				} else {
					return { by: sort.value[0], desc: false };
				}
			});

			const localWidths = ref<{ [field: string]: number }>({});

			watch(
				() => layoutOptions.value,
				() => {
					localWidths.value = {};
				},
			);

			const saveWidthsToLayoutOptions = debounce(() => {
				layoutOptions.value = Object.assign({}, layoutOptions.value, {
					widths: localWidths.value,
				});
			}, 350);

			const activeFields = computed<(Field & { key: string })[]>({
				get() {
					if (!collection.value) return [];

					return fields.value
						.map((key) => ({ ...fieldsStore.getField(collection.value!, key), key }))
						.filter((f) => f && f.meta?.special?.includes('no-data') !== true) as (Field & { key: string })[];
				},
				set(val) {
					fields.value = val.map((field) => field.field);
				},
			});

			const tableHeaders = computed<HeaderRaw[]>({
				get() {
					const rawHeaders = activeFields.value.map((field) => {
						let description: string | null = null;

						const fieldParts = field.key.split('.');

						if (fieldParts.length > 1) {
							const fieldNames = fieldParts.map((fieldKey, index) => {
								const pathPrefix = fieldParts.slice(0, index);
								const field = fieldsStore.getField(collection.value!, [...pathPrefix, fieldKey].join('.'));
								return field?.name ?? fieldKey;
							});

							description = fieldNames.join(' -> ');
						}

						const manualWidth = localWidths.value[field.key] ?? layoutOptions.value?.widths?.[field.key];
						const preset = NEW_MEDIA_COLUMN_PRESETS[collection.value ?? ''];
						const fieldKey = field.key;
						const normalizedFieldKey = fieldKey.split('.').at(-1) ?? fieldKey;
						const presetWidth =
							preset?.compact[fieldKey] ??
							preset?.wide[fieldKey] ??
							preset?.compact[normalizedFieldKey] ??
							preset?.wide[normalizedFieldKey] ??
							GENERIC_COMPACT_WIDTH[normalizedFieldKey];
						const width = manualWidth ?? presetWidth ?? 144;
						const importance = getNewMediaColumnImportance(fieldKey, preset);
						const multiline =
							importance === 'high' ||
							(preset?.multiline.has(fieldKey) ?? false) ||
							(preset?.multiline.has(normalizedFieldKey) ?? false);
						const priority = importance === 'high';

						return {
							text: field.name,
							value: field.key,
							description,
							width,
							multiline,
							priority,
							importance,
							align: layoutOptions.value?.align?.[field.key] || 'left',
							field: {
								display: field.meta?.display || getDefaultDisplayForType(field.type),
								displayOptions: field.meta?.display_options,
								interface: field.meta?.interface,
								interfaceOptions: field.meta?.options,
								type: field.type,
								field: field.field,
								collection: field.collection,
							},
							sortable: ['json', 'alias', 'presentation', 'translations'].includes(field.type) === false,
						} as HeaderRaw;
					});

					if (!isNewMediaCollectionView.value) return rawHeaders;
					return fitHeadersToViewport(rawHeaders, responsiveWidth.value);
				},
				set(val) {
					const widths = {} as { [field: string]: number };

					val.forEach((header) => {
						widths[header.value] = header.width ?? 144;
					});

					localWidths.value = widths;

					saveWidthsToLayoutOptions();

					fields.value = val.map((header) => header.value);
				},
			});

			const tableSpacing = syncRefProperty(
				layoutOptions,
				'spacing',
				computed(() => (isNewMediaCollectionView.value ? 'comfortable' : 'cozy')),
			);

			const tableRowHeight = computed<number>(() => {
				switch (tableSpacing.value) {
					case 'compact':
						return 29;
					case 'cozy':
					default:
						return 43;
					case 'comfortable':
						return 58;
				}
			});

			return {
				tableSort,
				tableHeaders,
				tableSpacing,
				tableRowHeight,
				onSortChange,
				onAlignChange,
				activeFields,
				getFieldDisplay,
			};

			function onSortChange(newSort: Sort | null) {
				if (!newSort?.by) {
					sort.value = [];
					return;
				}

				let sortString = newSort.by;

				if (newSort.desc === true) {
					sortString = '-' + sortString;
				}

				sort.value = [sortString];
			}

			function onAlignChange(field: string, align: 'left' | 'center' | 'right') {
				layoutOptions.value = Object.assign({}, layoutOptions.value, {
					align: {
						...(layoutOptions.value?.align ?? {}),
						[field]: align,
					},
				});
			}

			function getFieldDisplay(fieldKey: string) {
				const field = fieldsInCollection.value.find((field: Field) => field.field === fieldKey);

				if (!field?.meta?.display) return null;

				return {
					display: field.meta.display,
					options: field.meta.display_options,
				};
			}
		}
	},
});
