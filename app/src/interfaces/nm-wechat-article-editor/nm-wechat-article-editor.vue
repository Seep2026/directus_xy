<script setup lang="ts">
import EditorJS from '@editorjs/editorjs';
import { isEqual } from 'lodash';
import DOMPurify from 'dompurify';
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useBus } from '../input-block-editor/bus';
import { sanitizeValue } from '../input-block-editor/sanitize';
import getTools from '../input-block-editor/tools';
import { useFileHandler } from '../input-block-editor/use-file-handler';
import api from '@/api';
import VDrawer from '@/components/v-drawer.vue';
import VInput from '@/components/v-input.vue';
import VUpload from '@/components/v-upload.vue';
import { parseGlobalMimeTypeAllowList } from '@/composables/use-mime-type-filter';
import { useCollectionsStore } from '@/stores/collections';
import { useServerStore } from '@/stores/server';
import { unexpectedError } from '@/utils/unexpected-error';

import '../input-block-editor/editorjs-overrides.css';

const RedactorDomChanged = 'redactor dom changed';
const FLOATING_PREVIEW_WIDTH = 430;
const FLOATING_PREVIEW_HEIGHT = 760;
const FLOATING_PREVIEW_MARGIN = 16;
const FLOATING_PREVIEW_TOP = 92;

type WechatMode = 'split' | 'edit' | 'preview';

type AssetItem = {
	id: string | number;
	name: string;
	file: string | null;
	note: string;
	asset_type: string | null;
};

const props = withDefaults(
	defineProps<{
		disabled?: boolean;
		nonEditable?: boolean;
		autofocus?: boolean;
		value?: Record<string, any> | null;
		bordered?: boolean;
		placeholder?: string;
		folder?: string;
		font?: 'sans-serif' | 'serif';
		collection?: string;
		primaryKey?: string | number;
	}>(),
	{
		value: null,
		bordered: true,
		font: 'sans-serif',
	},
);

const emit = defineEmits<{ input: [value: EditorJS.OutputData | null] }>();

const { t } = useI18n();
const bus = useBus();
const router = useRouter();
const collectionStore = useCollectionsStore();
const { info } = useServerStore();
const allowedMimeTypes = computed(() => parseGlobalMimeTypeAllowList(info.files?.mimeTypeAllowList)?.join(','));
const haveFilesAccess = Boolean(collectionStore.getCollection('directus_files'));

const { currentPreview, setCurrentPreview, fileHandler, setFileHandler, unsetFileHandler, handleFile } =
	useFileHandler();

const editorjsRef = ref<EditorJS>();
const editorjsIsReady = ref(false);
const uploaderComponentElement = ref<HTMLElement>();
const editorElement = ref<HTMLElement>();
const haveValuesChanged = ref(false);
const documentValue = ref<EditorJS.OutputData | null>(sanitizeEditorValue(props.value));

const mode = ref<WechatMode>(typeof window !== 'undefined' && window.innerWidth >= 1400 ? 'split' : 'preview');
const viewportWidth = ref(typeof window !== 'undefined' ? window.innerWidth : 1440);
const viewportHeight = ref(typeof window !== 'undefined' ? window.innerHeight : 900);
const floatingPreviewPosition = ref({ x: 0, y: FLOATING_PREVIEW_TOP });
const floatingPreviewInitialized = ref(false);
const isDraggingPreview = ref(false);
const dragOffset = ref({ x: 0, y: 0 });

const tools = getTools(
	{
		baseURL: api.defaults.baseURL,
		setFileHandler,
		setCurrentPreview,
		getUploadFieldElement: () => uploaderComponentElement,
	},
	['header', 'nestedlist', 'paragraph', 'quote', 'delimiter', 'image', 'underline'],
	haveFilesAccess,
);

const assetDrawerOpen = ref(false);
const assetsLoading = ref(false);
const assets = ref<AssetItem[]>([]);
const assetSearch = ref('');

const hasPersistedItem = computed(
	() => props.primaryKey !== '+' && props.primaryKey !== undefined && props.primaryKey !== null,
);
const canPickAsset = computed(() => hasPersistedItem.value && !props.disabled);
const showEditor = computed(() => mode.value !== 'preview');
const showPreview = computed(() => mode.value !== 'edit');
const canUseFloatingPreview = computed(() => viewportWidth.value > 1320);
const isFloatingPreview = computed(() => mode.value === 'split' && canUseFloatingPreview.value);
const menuActive = computed(() => fileHandler.value !== null || assetDrawerOpen.value);

const filteredAssets = computed(() => {
	const keyword = assetSearch.value.trim().toLowerCase();
	if (!keyword) return assets.value;
	return assets.value.filter((asset) => `${asset.name} ${asset.note}`.toLowerCase().includes(keyword));
});

const previewHtml = computed(() => renderWechatHtml(documentValue.value));

const floatingPreviewStyle = computed(() => {
	if (!isFloatingPreview.value) return undefined;

	return {
		left: `${floatingPreviewPosition.value.x}px`,
		top: `${floatingPreviewPosition.value.y}px`,
	};
});

bus.on(async (event) => {
	if (event.type === 'open-url') {
		router.push(event.payload);
	}
});

onMounted(async () => {
	editorjsRef.value = new EditorJS({
		logLevel: 'ERROR' as EditorJS.LogLevels,
		holder: editorElement.value,
		readOnly: false,
		placeholder: props.placeholder || t('new_media_wechat_editor_placeholder'),
		minHeight: 160,
		onChange: (context) => emitValue(context),
		tools,
	});

	await editorjsRef.value.isReady;

	const sanitizedValue = sanitizeEditorValue(props.value);
	if (sanitizedValue) {
		await editorjsRef.value.render(sanitizedValue);
		documentValue.value = sanitizedValue;
	}

	if (props.autofocus) {
		editorjsRef.value.focus();
	}

	editorjsRef.value.on(RedactorDomChanged, () => {
		void emitValue(editorjsRef.value!);
	});

	editorjsIsReady.value = true;
});

onMounted(() => {
	if (typeof window === 'undefined') return;
	window.addEventListener('resize', handleWindowResize, { passive: true });
});

onUnmounted(() => {
	stopFloatingPreviewDrag();
	if (typeof window !== 'undefined') {
		window.removeEventListener('resize', handleWindowResize);
	}

	editorjsRef.value?.destroy();
	bus.reset();
});

watch(
	[editorjsIsReady, () => props.disabled],
	async ([isReady, isDisabled]) => {
		if (!isReady) return;
		await nextTick();
		editorjsRef.value?.readOnly.toggle(Boolean(isDisabled));
	},
	{ immediate: true },
);

watch(
	() => props.value,
	async (newVal, oldVal) => {
		if (!editorjsRef.value || !editorjsIsReady.value) return;
		if (newVal === null && props.disabled) return;

		if (haveValuesChanged.value) {
			haveValuesChanged.value = false;
			return;
		}

		if (isEqual(newVal?.blocks, oldVal?.blocks)) return;

		try {
			const sanitizedValue = sanitizeEditorValue(newVal);

			if (sanitizedValue) {
				await editorjsRef.value.render(sanitizedValue);
				documentValue.value = sanitizedValue;
			} else {
				editorjsRef.value.clear();
				documentValue.value = null;
			}
		} catch (error) {
			unexpectedError(error);
		}
	},
);

watch(
	() => assetDrawerOpen.value,
	(open) => {
		if (open) void loadAssets();
	},
);

watch(
	() => props.primaryKey,
	() => {
		if (assetDrawerOpen.value) void loadAssets();
	},
);

watch(
	() => isFloatingPreview.value,
	(enabled) => {
		if (!enabled) {
			stopFloatingPreviewDrag();
			return;
		}

		if (!floatingPreviewInitialized.value) {
			resetFloatingPreviewPosition();
			return;
		}

		floatingPreviewPosition.value = clampFloatingPreviewPosition(
			floatingPreviewPosition.value.x,
			floatingPreviewPosition.value.y,
		);
	},
	{ immediate: true },
);

async function emitValue(context: EditorJS.API | EditorJS) {
	if (props.disabled || !context || !context.saver) return;

	try {
		const result = await context.saver.save();
		haveValuesChanged.value = true;

		if (!result || result.blocks.length < 1) {
			documentValue.value = null;
			emit('input', null);
			return;
		}

		documentValue.value = result;

		if (isEqual(result.blocks, props.value?.blocks)) return;
		emit('input', result);
	} catch (error) {
		unexpectedError(error);
	}
}

function sanitizeEditorValue(value: unknown): EditorJS.OutputData | null {
	const sanitized = sanitizeValue(value as Record<string, unknown> | null | undefined);
	return sanitized ?? null;
}

function handleWindowResize() {
	viewportWidth.value = window.innerWidth;
	viewportHeight.value = window.innerHeight;

	if (!isFloatingPreview.value) return;

	floatingPreviewPosition.value = clampFloatingPreviewPosition(
		floatingPreviewPosition.value.x,
		floatingPreviewPosition.value.y,
	);
}

function resetFloatingPreviewPosition() {
	floatingPreviewPosition.value = getDefaultFloatingPreviewPosition();
	floatingPreviewInitialized.value = true;
}

function getDefaultFloatingPreviewPosition() {
	const minX = FLOATING_PREVIEW_MARGIN;
	const maxX = Math.max(minX, viewportWidth.value - FLOATING_PREVIEW_WIDTH - FLOATING_PREVIEW_MARGIN);
	const minY = FLOATING_PREVIEW_TOP;
	const maxY = Math.max(minY, viewportHeight.value - FLOATING_PREVIEW_HEIGHT - FLOATING_PREVIEW_MARGIN);

	return {
		x: maxX,
		y: Math.min(Math.max(minY, FLOATING_PREVIEW_TOP), maxY),
	};
}

function clampFloatingPreviewPosition(x: number, y: number) {
	const minX = FLOATING_PREVIEW_MARGIN;
	const maxX = Math.max(minX, viewportWidth.value - FLOATING_PREVIEW_WIDTH - FLOATING_PREVIEW_MARGIN);
	const minY = FLOATING_PREVIEW_TOP;
	const maxY = Math.max(minY, viewportHeight.value - FLOATING_PREVIEW_HEIGHT - FLOATING_PREVIEW_MARGIN);

	return {
		x: Math.min(Math.max(x, minX), maxX),
		y: Math.min(Math.max(y, minY), maxY),
	};
}

function startFloatingPreviewDrag(event: PointerEvent) {
	if (!isFloatingPreview.value || props.disabled) return;

	isDraggingPreview.value = true;
	dragOffset.value = {
		x: event.clientX - floatingPreviewPosition.value.x,
		y: event.clientY - floatingPreviewPosition.value.y,
	};

	window.addEventListener('pointermove', onFloatingPreviewPointerMove);
	window.addEventListener('pointerup', stopFloatingPreviewDrag);
	event.preventDefault();
}

function onFloatingPreviewPointerMove(event: PointerEvent) {
	if (!isDraggingPreview.value) return;

	const nextX = event.clientX - dragOffset.value.x;
	const nextY = event.clientY - dragOffset.value.y;
	floatingPreviewPosition.value = clampFloatingPreviewPosition(nextX, nextY);
}

function stopFloatingPreviewDrag() {
	isDraggingPreview.value = false;
	window.removeEventListener('pointermove', onFloatingPreviewPointerMove);
	window.removeEventListener('pointerup', stopFloatingPreviewDrag);
}

async function loadAssets() {
	if (!hasPersistedItem.value) {
		assets.value = [];
		return;
	}

	assetsLoading.value = true;
	try {
		const response = await api.get('/items/nm_assets', {
			params: {
				fields: ['id', 'name', 'file', 'note', 'asset_type'],
				filter: {
					_and: [{ content_card: { _eq: props.primaryKey } }, { file: { _nnull: true } }],
				},
				sort: ['-id'],
				limit: -1,
			},
		});

		const rows = Array.isArray(response?.data?.data) ? response.data.data : [];
		assets.value = rows
			.map((row: Record<string, unknown>) => ({
				id: typeof row['id'] === 'number' || typeof row['id'] === 'string' ? row['id'] : '',
				name: typeof row['name'] === 'string' ? row['name'] : t('new_media_wechat_asset_default_name'),
				file: normalizeFileId(row['file']),
				note: typeof row['note'] === 'string' ? row['note'] : '',
				asset_type: typeof row['asset_type'] === 'string' ? row['asset_type'] : null,
			}))
			.filter((row) => row.id !== '' && row.file);
	} catch (error) {
		unexpectedError(error);
	} finally {
		assetsLoading.value = false;
	}
}

async function insertAsset(asset: AssetItem) {
	if (!editorjsRef.value || !asset.file) return;

	const imageData = {
		file: {
			url: buildAssetUrl(asset.file),
			fileId: asset.file,
			fileURL: buildFileUrl(asset.file),
			assetId: asset.id,
			assetName: asset.name,
		},
		caption: asset.note || asset.name || '',
		withBorder: false,
		withBackground: false,
		stretched: false,
	};

	try {
		editorjsRef.value.blocks.insert('image', imageData);
		await emitValue(editorjsRef.value);
		assetDrawerOpen.value = false;
	} catch (error) {
		unexpectedError(error);
	}
}

function normalizeFileId(value: unknown): string | null {
	if (typeof value === 'string') return value;
	if (value && typeof value === 'object') {
		const item = value as Record<string, unknown>;
		if (typeof item['id'] === 'string') return item['id'];
	}
	return null;
}

function buildAssetUrl(fileId: string): string {
	return buildAbsoluteUrl(`assets/${fileId}`);
}

function buildFileUrl(fileId: string): string {
	return buildAbsoluteUrl(`files/${fileId}`);
}

function buildAbsoluteUrl(path: string): string {
	const base = String(api.defaults.baseURL ?? '/');
	const normalizedPath = path.replace(/^\/+/, '');
	const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:8055';

	let baseUrl = base;
	if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
		baseUrl = `${origin}${baseUrl.startsWith('/') ? '' : '/'}${baseUrl}`;
	}

	if (!baseUrl.endsWith('/')) baseUrl += '/';

	return new URL(normalizedPath, baseUrl).toString();
}

function renderWechatHtml(value: EditorJS.OutputData | null): string {
	const blocks = Array.isArray(value?.blocks) ? value.blocks : [];
	if (blocks.length === 0) {
		return `<p class="nm-wechat-empty">${escapeHtml(t('new_media_wechat_preview_empty'))}</p>`;
	}

	return blocks.map(renderBlock).join('');
}

function renderBlock(block: Record<string, any>): string {
	const type = String(block?.type ?? '');
	const data = isRecord(block?.data) ? block.data : {};

	if (type === 'header') {
		const levelRaw = Number(data.level ?? 2);
		const level = levelRaw <= 1 ? 1 : levelRaw >= 3 ? 3 : levelRaw;
		return `<h${level}>${sanitizeInline(data.text)}</h${level}>`;
	}

	if (type === 'paragraph') {
		return `<p>${sanitizeInline(data.text)}</p>`;
	}

	if (type === 'quote') {
		const quoteText = sanitizeInline(data.text);
		const caption = sanitizeInline(data.caption);
		return `<blockquote><p>${quoteText}</p>${caption ? `<cite>${caption}</cite>` : ''}</blockquote>`;
	}

	if (type === 'delimiter') {
		return '<hr />';
	}

	if (type === 'image') {
		const file = isRecord(data.file) ? data.file : {};
		const imageUrl = resolveImageUrl(file);
		const caption = sanitizeInline(data.caption);
		if (!imageUrl) return '';
		const alt = escapeAttribute(stripHtml(caption) || t('new_media_wechat_image_alt'));
		return `<figure><img src="${escapeAttribute(imageUrl)}" alt="${alt}" />${caption ? `<figcaption>${caption}</figcaption>` : ''}</figure>`;
	}

	if (type === 'nestedlist' || type === 'list') {
		const style = data.style === 'ordered' ? 'ordered' : 'unordered';
		return renderListBlock(Array.isArray(data.items) ? data.items : [], style === 'ordered');
	}

	if (type === 'checklist') {
		const items = Array.isArray(data.items) ? data.items : [];
		const html = items
			.map((item) => {
				const content = sanitizeInline(isRecord(item) ? item.text : item);
				const checked = isRecord(item) && item.checked ? 'checked' : '';
				return `<li class="${checked}"><span class="checkmark">${checked ? '✓' : ''}</span>${content}</li>`;
			})
			.join('');
		return `<ul class="checklist">${html}</ul>`;
	}

	return '';
}

function renderListBlock(items: unknown[], ordered: boolean): string {
	const tag = ordered ? 'ol' : 'ul';
	return `<${tag}>${renderListItems(items, ordered)}</${tag}>`;
}

function renderListItems(items: unknown[], ordered: boolean): string {
	return items
		.map((item) => {
			if (typeof item === 'string') {
				return `<li>${sanitizeInline(item)}</li>`;
			}

			if (isRecord(item)) {
				const content = sanitizeInline(item['content']);
				const children = Array.isArray(item['items']) ? renderListBlock(item['items'], ordered) : '';
				return `<li>${content}${children}</li>`;
			}

			return '';
		})
		.join('');
}

function resolveImageUrl(file: Record<string, unknown>): string {
	if (typeof file['url'] === 'string' && file['url'].length > 0) return file['url'];
	if (typeof file['fileURL'] === 'string' && file['fileURL'].length > 0) return file['fileURL'];
	if (typeof file['fileId'] === 'string' && file['fileId'].length > 0) return buildAssetUrl(file['fileId']);
	return '';
}

function sanitizeInline(value: unknown): string {
	const input = typeof value === 'string' ? value : '';
	return DOMPurify.sanitize(input, {
		ALLOWED_TAGS: ['a', 'b', 'br', 'code', 'em', 'i', 'mark', 'strong', 'u'],
		ALLOWED_ATTR: ['href', 'target', 'rel'],
	});
}

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

function escapeAttribute(value: string): string {
	return escapeHtml(value);
}

function stripHtml(value: string): string {
	return value.replace(/<[^>]*>/g, '').trim();
}

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
</script>

<template>
	<div v-prevent-focusout="menuActive" class="nm-wechat-article-editor">
		<div class="toolbar-row">
			<div class="mode-switch">
				<button type="button" class="mode-btn" :class="{ active: mode === 'edit' }" @click="mode = 'edit'">
					{{ t('new_media_wechat_mode_edit') }}
				</button>
				<button type="button" class="mode-btn" :class="{ active: mode === 'preview' }" @click="mode = 'preview'">
					{{ t('new_media_wechat_mode_preview') }}
				</button>
				<button type="button" class="mode-btn" :class="{ active: mode === 'split' }" @click="mode = 'split'">
					{{ t('new_media_wechat_mode_split') }}
				</button>
			</div>

			<button type="button" class="asset-btn" :disabled="!canPickAsset" @click="assetDrawerOpen = true">
				{{ t('new_media_wechat_insert_asset') }}
			</button>
		</div>

		<div v-if="!canPickAsset && !disabled" class="asset-hint">
			{{ t('new_media_wechat_asset_hint_save_first') }}
		</div>

		<div class="workspace" :class="[`mode-${mode}`, { disabled }]">
			<div v-show="showEditor" class="editor-pane">
				<div
					ref="editorElement"
					class="editor"
					:class="{ [font]: true, bordered, disabled, 'non-editable': nonEditable }"
				/>
			</div>

			<div
				v-show="showPreview"
				class="preview-pane"
				:class="{ floating: isFloatingPreview, dragging: isDraggingPreview }"
				:style="floatingPreviewStyle"
			>
				<div
					v-if="isFloatingPreview"
					class="preview-float-header"
					:class="{ dragging: isDraggingPreview }"
					@pointerdown="startFloatingPreviewDrag"
				>
					<span>{{ t('new_media_wechat_mode_preview') }}</span>
					<button type="button" class="preview-float-reset" @click.stop="resetFloatingPreviewPosition">
						{{ t('new_media_wechat_float_reset') }}
					</button>
				</div>
				<div class="phone-shell">
					<div class="phone-notch"></div>
					<div class="wechat-page">
						<article class="wechat-article" v-html="previewHtml"></article>
					</div>
				</div>
			</div>
		</div>

		<VDrawer
			v-if="haveFilesAccess && !disabled"
			:model-value="fileHandler !== null"
			icon="image"
			:title="$t('upload_from_device')"
			cancelable
			@update:model-value="unsetFileHandler"
			@cancel="unsetFileHandler"
		>
			<div class="uploader-drawer-content">
				<div v-if="currentPreview" class="uploader-preview-image">
					<img :src="currentPreview" />
				</div>
				<VUpload
					:ref="uploaderComponentElement"
					:multiple="false"
					:folder="folder"
					from-library
					from-url
					:accept="allowedMimeTypes"
					@input="handleFile"
				/>
			</div>
		</VDrawer>

		<VDrawer
			:model-value="assetDrawerOpen"
			icon="collections"
			:title="t('new_media_wechat_asset_picker_title')"
			cancelable
			@update:model-value="assetDrawerOpen = $event"
			@cancel="assetDrawerOpen = false"
		>
			<div class="asset-picker">
				<VInput v-model="assetSearch" :placeholder="t('new_media_wechat_asset_search_placeholder')" />

				<div v-if="assetsLoading" class="asset-state">{{ t('loading') }}</div>
				<div v-else-if="filteredAssets.length < 1" class="asset-state">
					{{ t('new_media_wechat_asset_empty') }}
				</div>

				<div v-else class="asset-list">
					<div v-for="asset in filteredAssets" :key="asset.id" class="asset-item">
						<img class="asset-thumb" :src="buildAssetUrl(asset.file!)" :alt="asset.name" />
						<div class="asset-meta">
							<div class="asset-name">{{ asset.name }}</div>
							<div v-if="asset.note" class="asset-note">{{ asset.note }}</div>
						</div>
						<button type="button" class="asset-insert-btn" @click="insertAsset(asset)">
							{{ t('new_media_wechat_asset_insert_action') }}
						</button>
					</div>
				</div>
			</div>
		</VDrawer>
	</div>
</template>

<style lang="scss" scoped>
.nm-wechat-article-editor {
	display: flex;
	flex-direction: column;
	gap: 12px;
}

.toolbar-row {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
}

.mode-switch {
	display: inline-flex;
	gap: 4px;
	padding: 4px;
	border: 1px solid var(--theme--border-color-subdued);
	border-radius: 999px;
	background: var(--theme--background-subdued);
}

.mode-btn {
	padding: 4px 10px;
	font-size: 12px;
	color: var(--theme--foreground-subdued);
	border: none;
	border-radius: 999px;
	background: transparent;
	cursor: pointer;

	&.active {
		color: var(--theme--foreground);
		background: var(--theme--background-normal);
	}
}

.asset-btn {
	padding: 6px 12px;
	color: #fff;
	border: none;
	border-radius: 999px;
	background: var(--theme--primary);
	cursor: pointer;

	&:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
}

.asset-hint {
	font-size: 12px;
	color: var(--theme--warning);
}

.workspace {
	display: grid;
	grid-template-columns: minmax(0, 1fr) minmax(360px, 420px);
	gap: 12px;

	&.mode-split {
		grid-template-columns: minmax(0, 1fr);
	}

	&.mode-edit {
		grid-template-columns: minmax(0, 1fr);
	}

	&.mode-preview {
		grid-template-columns: minmax(0, 1fr);
	}
}

.editor-pane {
	min-width: 0;
}

.preview-pane {
	display: flex;
	justify-content: center;
	min-width: 0;
}

.preview-pane.floating {
	position: fixed;
	z-index: 40;
	width: min(430px, calc(100vw - 32px));
	max-width: 430px;
	display: flex;
	flex-direction: column;
	align-items: stretch;
	gap: 8px;
	justify-content: flex-start;
}

.preview-pane.floating .phone-shell {
	width: 100%;
	max-width: none;
	padding: 12px;
	border-radius: 26px;
}

.preview-pane.floating .wechat-page {
	height: clamp(420px, 62vh, 680px);
}

.preview-float-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	padding: 8px 10px;
	color: #f2f2f2;
	font-size: 12px;
	border-radius: 10px;
	background: rgb(20 20 20 / 88%);
	cursor: grab;
	user-select: none;
	touch-action: none;
}

.preview-pane.dragging .preview-float-header {
	cursor: grabbing;
}

.preview-float-reset {
	padding: 2px 8px;
	color: #fff;
	font-size: 11px;
	border: 1px solid rgb(255 255 255 / 28%);
	border-radius: 999px;
	background: transparent;
	cursor: pointer;
}

.editor {
	border-radius: var(--theme--border-radius);
	padding: var(--theme--form--field--input--padding)
		max(1.8125rem, calc(var(--theme--form--field--input--padding) + 0.875rem));
}

.disabled {
	pointer-events: none;

	&:not(.non-editable) {
		color: var(--theme--form--field--input--foreground-subdued);
		background-color: var(--theme--form--field--input--background-subdued);
		border-color: var(--theme--form--field--input--border-color);
	}
}

.bordered {
	border: var(--theme--border-width) solid var(--theme--form--field--input--border-color);

	&:not(.disabled) {
		background-color: var(--theme--form--field--input--background);

		&:hover {
			border-color: var(--theme--form--field--input--border-color-hover);
		}

		&:focus-within {
			border-color: var(--theme--form--field--input--border-color-focus);
		}
	}
}

.sans-serif {
	font-family: var(--theme--fonts--sans--font-family);
}

.serif {
	font-family: var(--theme--fonts--serif--font-family);
}

.phone-shell {
	width: 390px;
	max-width: 100%;
	padding: 14px 14px 18px;
	border: 1px solid #d8d8d8;
	border-radius: 34px;
	background: #111;
	box-shadow: 0 12px 30px rgb(0 0 0 / 18%);
}

.phone-notch {
	width: 120px;
	height: 20px;
	margin: 0 auto 10px;
	border-radius: 12px;
	background: #000;
}

.wechat-page {
	height: 680px;
	overflow: auto;
	border-radius: 22px;
	background: #efefef;
}

.wechat-article {
	width: min(100%, 360px);
	margin: 0 auto;
	padding: 18px 16px 26px;
	color: #222;
	font-size: 16px;
	line-height: 1.82;
	background: #fff;

	:deep(h1) {
		margin: 0 0 14px;
		font-size: 25px;
		font-weight: 700;
		line-height: 1.35;
	}

	:deep(h2) {
		margin: 22px 0 10px;
		font-size: 22px;
		font-weight: 700;
		line-height: 1.4;
	}

	:deep(h3) {
		margin: 18px 0 8px;
		font-size: 19px;
		font-weight: 700;
		line-height: 1.45;
	}

	:deep(p) {
		margin: 0 0 14px;
		word-break: break-word;
	}

	:deep(figure) {
		margin: 14px 0 18px;
	}

	:deep(img) {
		display: block;
		width: 100%;
		height: auto;
		border-radius: 8px;
		object-fit: contain;
	}

	:deep(figcaption) {
		margin-top: 8px;
		color: #8a8a8a;
		font-size: 13px;
		line-height: 1.5;
		text-align: center;
	}

	:deep(blockquote) {
		margin: 16px 0;
		padding: 10px 12px;
		border-left: 3px solid #5f5f5f;
		background: #f6f6f6;
	}

	:deep(blockquote p) {
		margin: 0;
	}

	:deep(blockquote cite) {
		display: block;
		margin-top: 8px;
		color: #7d7d7d;
		font-size: 13px;
		font-style: normal;
	}

	:deep(ul),
	:deep(ol) {
		margin: 0 0 14px;
		padding-left: 22px;
	}

	:deep(li) {
		margin: 4px 0;
	}

	:deep(hr) {
		margin: 18px 0;
		border: none;
		border-top: 1px solid #ddd;
	}

	:deep(.checklist) {
		padding-left: 0;
		list-style: none;
	}

	:deep(.checklist li) {
		display: flex;
		gap: 8px;
		align-items: flex-start;
	}

	:deep(.checklist .checkmark) {
		display: inline-flex;
		flex-shrink: 0;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		margin-top: 5px;
		font-size: 12px;
		color: #fff;
		border: 1px solid #8a8a8a;
		border-radius: 50%;
	}

	:deep(.checklist li.checked .checkmark) {
		border-color: #09bb07;
		background: #09bb07;
	}

	:deep(.nm-wechat-empty) {
		margin: 24px 0;
		color: #888;
		font-size: 14px;
		text-align: center;
	}
}

.asset-picker {
	display: flex;
	flex-direction: column;
	gap: 10px;
	height: 100%;
	padding-bottom: 10px;
}

.asset-state {
	padding: 18px 0;
	color: var(--theme--foreground-subdued);
	font-size: 13px;
	text-align: center;
}

.asset-list {
	display: flex;
	flex-direction: column;
	gap: 8px;
	max-height: 62vh;
	overflow: auto;
}

.asset-item {
	display: grid;
	grid-template-columns: 80px minmax(0, 1fr) auto;
	gap: 10px;
	align-items: center;
	padding: 8px;
	border: 1px solid var(--theme--border-color-subdued);
	border-radius: 8px;
}

.asset-thumb {
	width: 80px;
	height: 60px;
	object-fit: cover;
	border-radius: 6px;
	background: #f2f2f2;
}

.asset-meta {
	min-width: 0;
}

.asset-name {
	overflow: hidden;
	font-size: 13px;
	font-weight: 600;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.asset-note {
	display: -webkit-box;
	margin-top: 4px;
	overflow: hidden;
	color: var(--theme--foreground-subdued);
	font-size: 12px;
	-webkit-line-clamp: 2;
	-webkit-box-orient: vertical;
}

.asset-insert-btn {
	padding: 6px 10px;
	color: #fff;
	font-size: 12px;
	border: none;
	border-radius: 6px;
	background: var(--theme--primary);
	cursor: pointer;
}

.uploader-drawer-content {
	padding: var(--content-padding);
	padding-block-end: var(--content-padding);
}

.uploader-preview-image {
	margin-block-end: var(--theme--form--row-gap);
	background-color: var(--theme--background-normal);
	border-radius: var(--theme--border-radius);
}

.uploader-preview-image img {
	display: block;
	inline-size: auto;
	max-inline-size: 100%;
	block-size: auto;
	max-block-size: 40vh;
	margin: 0 auto;
	object-fit: contain;
}

@media (max-width: 1320px) {
	.workspace,
	.workspace.mode-split {
		grid-template-columns: minmax(0, 1fr);
	}

	.phone-shell {
		width: min(390px, 100%);
	}
}
</style>
