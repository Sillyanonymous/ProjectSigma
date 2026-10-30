// where the extension kept its estate in an ST home, the one definition the migration and its verifier read

// the extension's own key under ST's extension_settings
export const EXT_SETTINGS_KEY = 'SillyTavernCharacterGallery';

// docs the extension kept in ST's Files API, mapped to their app_store homes
export const STORE_DOC_MAP = [
    { file: '_cl_custom_css.json', key: 'custom-css-snippets' },
    { file: '_cl_chat_prompts.json', key: 'chat-prompts' },
    { file: '_cl_filterpresets.json', key: 'filter-presets' },
];

// the extension settings that travel: raw custom CSS is user-authored styling, not configuration
export const CSS_SETTING_KEYS = ['customCSS', 'customCSSMode'];
