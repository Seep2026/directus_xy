import { defineInterface } from '@directus/extensions';
import InterfaceNewMediaWechatArticleEditor from './nm-wechat-article-editor.vue';
import PreviewSVG from './preview.svg?raw';

export default defineInterface({
	id: 'nm-wechat-article-editor',
	name: '$t:new_media_wechat_editor_name',
	description: '$t:new_media_wechat_editor_description',
	icon: 'smartphone',
	component: InterfaceNewMediaWechatArticleEditor,
	types: ['json'],
	group: 'standard',
	preview: PreviewSVG,
	options: [
		{
			field: 'placeholder',
			name: '$t:placeholder',
			meta: {
				width: 'half',
				interface: 'text-input',
				options: {
					placeholder: '$t:enter_a_placeholder',
				},
			},
		},
		{
			field: 'folder',
			name: '$t:interfaces.system-folder.folder',
			type: 'uuid',
			meta: {
				width: 'half',
				interface: 'system-folder',
				note: '$t:interfaces.system-folder.field_hint',
			},
		},
		{
			field: 'font',
			name: '$t:font',
			type: 'string',
			meta: {
				width: 'half',
				interface: 'select-dropdown',
				options: {
					choices: [
						{
							text: '$t:sans_serif',
							value: 'sans-serif',
						},
						{
							text: '$t:serif',
							value: 'serif',
						},
					],
				},
			},
			schema: {
				default_value: 'sans-serif',
			},
		},
	],
});
