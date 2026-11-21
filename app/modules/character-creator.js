// Character Creator Module
// Create new characters from scratch with AI-assisted field generation

import * as CoreAPI from './core-api.js';
import { defineCommand, runCommand } from './ext-registry.js';
import { cardValuesEqual } from './card-fields.js';
import { generatePlaceholder } from './providers/provider-utils.js';

// ========================================
// CONSTANTS
// ========================================

// ========================================
// STATE
// ========================================

let avatarBuffer = null;
let avatarDataUrl = null;
let avatarSourceAvatar = null;
// the library character the form was filled FROM: saving back over it is the common save-as, so the split menu offers it
let importSourceId = null;
let importSourceName = '';
// what Create carries from that character: the parts the form has no field for, each switchable (null when none)
let carried = null;
let creatorTagsArray = [];
let tagAiBusy = false;
let saveAsTarget = null;
// Import/Save-As picker search debounce.
let importSearchTimer = 0;
let fieldsAutoGrowHandler = null;


// ========================================
// MODAL HTML
// ========================================

function createModal() {
    const html = `
    <div id="creatorModal" class="modal-overlay hidden">
        <div class="modal-glass creator-modal-glass" data-fw-min="760x520">
            <div class="modal-header creator-header">
                <h2><i class="fa-solid fa-plus-circle"></i> Create Character</h2>
                <div class="modal-controls">
                    <button class="glass-btn icon-only ccs-opener" id="creatorStudioToggle" title="Open the studio: a design partner over the whole draft">
                        <i class="fa-solid fa-wand-magic-sparkles"></i>
                    </button>
                    <button class="glass-btn icon-only" id="creatorFieldsToggle" title="Expand all fields to fit content">
                        <i class="fa-solid fa-up-right-and-down-left-from-center"></i>
                    </button>
                    <button class="close-btn" id="creatorClose">&times;</button>
                </div>
            </div>

            <div class="modal-body creator-body">
                <div class="modal-sidebar creator-sidebar">
                    <div class="creator-avatar-area">
                        <div class="creator-avatar-preview" id="creatorAvatarPreview">
                            <i class="fa-solid fa-image"></i>
                            <span>Click or drop an image</span>
                        </div>
                        <input type="file" id="creatorAvatarInput" accept="image/*" hidden>
                        <button type="button" class="cl-btn cl-btn-secondary cl-btn-sm creator-avatar-clear hidden" id="creatorAvatarClear">
                            <i class="fa-solid fa-times"></i> Remove
                        </button>
                    </div>

                    <div class="creator-sidebar-section">
                        <div class="sidebar-label"><i class="fa-solid fa-tags"></i> Tags
                            <button type="button" class="creator-tag-ai-btn" id="creatorTagAiBtn" title="Suggest tags from the draft">
                                <i class="fa-solid fa-wand-magic-sparkles"></i>
                            </button>
                        </div>
                        <div class="tags-container" id="creatorTagsContainer"></div>
                        <div id="creatorTagSuggestions" class="creator-tag-suggestions hidden"></div>
                        <div class="creator-tag-input-row">
                            <input type="search" id="creatorTagInput" class="glass-input tag-input" placeholder="Add tag..." autocomplete="one-time-code">
                            <div id="creatorTagAutocomplete" class="tag-autocomplete is-below"></div>
                        </div>
                    </div>
                </div>

                <div class="creator-content">
                    <div class="creator-fields">
                        <div class="creator-mobile-topbar">
                            <div class="creator-mobile-avatar" id="creatorMobileAvatarPreview">
                                <i class="fa-solid fa-image"></i>
                            </div>
                            <button type="button" class="creator-topbar-btn" id="creatorMobileImportBtn" title="Start from a character in the library">
                                <i class="fa-solid fa-file-import"></i><span>Import</span>
                            </button>
                            <button type="button" class="creator-topbar-btn creator-mobile-studio-btn ccs-opener" id="creatorMobileStudioBtn" title="Open the studio">
                                <i class="fa-solid fa-wand-magic-sparkles"></i><span>Studio</span>
                            </button>
                        </div>
                        <div class="edit-section" id="creatorBasicSection">
                            <h4 class="section-header"><i class="fa-solid fa-user"></i> Basic Information</h4>
                            <div class="form-group">
                                <label>Character Name <span class="creator-required">*</span></label>
                                <input type="search" id="creatorName" class="glass-input" placeholder="Give your character a name" autocomplete="one-time-code">
                            </div>
                            <div class="form-row">
                                <div class="form-group half">
                                    <label>Creator / Author</label>
                                    <input type="search" id="creatorAuthor" class="glass-input" placeholder="Your name" autocomplete="one-time-code">
                                </div>
                                <div class="form-group half">
                                    <label>Version</label>
                                    <input type="search" id="creatorVersion" class="glass-input" placeholder="1.0" autocomplete="one-time-code">
                                </div>
                            </div>
                            <div class="form-group creator-field-group">
                                <div class="creator-field-header">
                                    <label>Tagline</label>
                                    <button type="button" class="creator-ai-btn" data-field="tagline" title="Work on this field in the studio">
                                        <i class="fa-solid fa-wand-magic-sparkles"></i>
                                    </button>
                                </div>
                                <input type="search" id="creatorTagline" class="glass-input" placeholder="Short hook shown under the name" autocomplete="one-time-code">
                            </div>
                        </div>

                        <div class="edit-section">
                            <h4 class="section-header"><i class="fa-solid fa-scroll"></i> Character Definition</h4>
                            <div class="form-group creator-field-group">
                                <div class="creator-field-header">
                                    <label>Description / Persona</label>
                                    <button type="button" class="creator-ai-btn" data-field="description" title="Work on this field in the studio">
                                        <i class="fa-solid fa-wand-magic-sparkles"></i>
                                    </button>
                                </div>
                                <textarea id="creatorDescription" class="glass-input" rows="6" placeholder="Who is this character? Their appearance, backstory, personality..."></textarea>
                            </div>
                            <div class="form-group creator-field-group">
                                <div class="creator-field-header">
                                    <label>Personality Summary</label>
                                    <button type="button" class="creator-ai-btn" data-field="personality" title="Work on this field in the studio">
                                        <i class="fa-solid fa-wand-magic-sparkles"></i>
                                    </button>
                                </div>
                                <textarea id="creatorPersonality" class="glass-input" rows="3" placeholder="Key traits, mannerisms, quirks..."></textarea>
                            </div>
                            <div class="form-group creator-field-group">
                                <div class="creator-field-header">
                                    <label>Scenario / Setting</label>
                                    <button type="button" class="creator-ai-btn" data-field="scenario" title="Work on this field in the studio">
                                        <i class="fa-solid fa-wand-magic-sparkles"></i>
                                    </button>
                                </div>
                                <textarea id="creatorScenario" class="glass-input" rows="3" placeholder="Where and when does the story take place?"></textarea>
                            </div>
                        </div>

                        <div class="edit-section">
                            <h4 class="section-header"><i class="fa-solid fa-comments"></i> Messages</h4>
                            <div class="form-group creator-field-group">
                                <div class="creator-field-header">
                                    <label>First Message</label>
                                    <button type="button" class="creator-ai-btn" data-field="first_mes" title="Work on this field in the studio">
                                        <i class="fa-solid fa-wand-magic-sparkles"></i>
                                    </button>
                                </div>
                                <textarea id="creatorFirstMes" class="glass-input" rows="6" placeholder="The character's opening message..."></textarea>
                            </div>
                            <div class="form-group">
                                <label>Alternate Greetings</label>
                                <div id="creatorAltGreetings" class="creator-alt-greetings"></div>
                                <button type="button" class="cl-btn cl-btn-secondary cl-btn-sm u-mt-sm" id="creatorAddAltGreeting">
                                    <i class="fa-solid fa-plus"></i> Add Greeting
                                </button>
                            </div>
                            <div class="form-group creator-field-group">
                                <div class="creator-field-header">
                                    <label>Example Dialogue</label>
                                    <button type="button" class="creator-ai-btn" data-field="mes_example" title="Work on this field in the studio">
                                        <i class="fa-solid fa-wand-magic-sparkles"></i>
                                    </button>
                                </div>
                                <textarea id="creatorMesExample" class="glass-input" rows="4" placeholder="{{user}}: Hello!\n{{char}}: *waves* Hi there!"></textarea>
                            </div>
                        </div>

                        <div class="edit-section">
                            <h4 class="section-header"><i class="fa-solid fa-wand-magic-sparkles"></i> Advanced</h4>
                            <div class="form-group creator-field-group">
                                <div class="creator-field-header">
                                    <label>System Prompt <span class="label-hint">(Override)</span></label>
                                    <button type="button" class="creator-ai-btn" data-field="system_prompt" title="Work on this field in the studio">
                                        <i class="fa-solid fa-wand-magic-sparkles"></i>
                                    </button>
                                </div>
                                <textarea id="creatorSystemPrompt" class="glass-input" rows="3" placeholder="Optional system prompt override..."></textarea>
                            </div>
                            <div class="form-group creator-field-group">
                                <div class="creator-field-header">
                                    <label>Post-History Instructions <span class="label-hint">(Jailbreak)</span></label>
                                    <button type="button" class="creator-ai-btn" data-field="post_history_instructions" title="Work on this field in the studio">
                                        <i class="fa-solid fa-wand-magic-sparkles"></i>
                                    </button>
                                </div>
                                <textarea id="creatorPostHistory" class="glass-input" rows="3" placeholder="Instructions placed after chat history..."></textarea>
                            </div>
                            <div class="form-group creator-field-group">
                                <div class="creator-field-header">
                                    <label>Creator's Notes <span class="label-hint">(Not sent to AI)</span></label>
                                    <div class="creator-field-actions">
                                        <button type="button" class="creator-ai-btn" id="creatorNotesPreviewBtn" title="Preview rendered notes">
                                            <i class="fa-solid fa-eye"></i>
                                        </button>
                                        <button type="button" class="creator-ai-btn" data-field="creator_notes" title="Work on this field in the studio">
                                            <i class="fa-solid fa-wand-magic-sparkles"></i>
                                        </button>
                                    </div>
                                </div>
                                <textarea id="creatorNotes" class="glass-input" rows="3" placeholder="Tips and info for users who download this card..."></textarea>
                            </div>
                        </div>
                    </div>

                    <div class="creator-footer">
                        <div class="creator-footer-left">
                            <button type="button" class="cl-btn cl-btn-secondary creator-import-btn" id="creatorImportBtn">
                                <i class="fa-solid fa-file-import"></i> Import from Library
                            </button>
                        </div>
                        <div class="creator-footer-right">
                            <button type="button" class="cl-btn cl-btn-secondary" id="creatorCancelBtn">Cancel</button>
                            <div class="creator-split-btn">
                                <button type="button" class="cl-btn cl-btn-primary" id="creatorCreateBtn">
                                    <i class="fa-solid fa-plus"></i> Create Character
                                </button>
                                <button type="button" class="cl-btn cl-btn-primary creator-split-caret" id="creatorCreateCaret" aria-label="More create options">
                                    <i class="fa-solid fa-caret-down"></i>
                                </button>
                                <div class="creator-split-menu hidden" id="creatorSplitMenu">
                                    <button type="button" class="dropdown-item" id="creatorSaveAsBtn">
                                        <i class="fa-solid fa-floppy-disk"></i> Save as Existing Character...
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>`;

    document.body.insertAdjacentHTML('beforeend', html);
    CoreAPI.mountDialogSizing('creatorModal');
    CoreAPI.mountSeam(document.querySelector('#creatorModal .creator-sidebar'), { key: 'creatorModal:sidebar', minPx: 200, max: 45 });
}


// ========================================
// MODAL LIFECYCLE
// ========================================

function openModal() {
    let modal = document.getElementById('creatorModal');
    if (!modal) {
        createModal();
        modal = document.getElementById('creatorModal');
        attachEvents();
    }
    resetForm();
    placeTagSection();
    modal.classList.remove('hidden');
    if (!matchMedia('(pointer: coarse)').matches) {
        document.getElementById('creatorName')?.focus();
    }
    void mountStudio();
}

// the sidebar is hidden on a phone, so the tag editor rides the fields column there and returns on a desktop flip
function placeTagSection() {
    const section = document.querySelector('#creatorModal .creator-sidebar-section');
    if (!section) return;
    const mobile = CoreAPI.isMobileMode();
    const inFields = !!section.closest('.creator-fields');
    if (mobile && !inFields) {
        document.getElementById('creatorBasicSection')?.insertAdjacentElement('afterend', section);
    } else if (!mobile && inFields) {
        document.querySelector('#creatorModal .creator-sidebar')?.appendChild(section);
    }
    section.classList.toggle('edit-section', mobile);
    section.querySelector('.sidebar-label')?.classList.toggle('section-header', mobile);
}

function closeModal() {
    // the draft the studio was answering is gone with the creator, so its run stops too
    studioMod?.closeStudio({ stop: true });
    document.getElementById('creatorModal')?.classList.add('hidden');
}

function isDirty() {
    const textFields = [
        'creatorName', 'creatorDescription', 'creatorPersonality', 'creatorScenario',
        'creatorFirstMes', 'creatorMesExample', 'creatorSystemPrompt', 'creatorPostHistory', 'creatorNotes',
        'creatorTagline',
    ];
    if (textFields.some(id => document.getElementById(id)?.value.trim())) return true;
    if (avatarBuffer) return true;
    if (creatorTagsArray.length > 0) return true;
    if (document.getElementById('creatorAltGreetings')?.children.length > 0) return true;
    return false;
}

function showUnsavedConfirm({ title = 'Discard unsaved character?', message = 'Your character draft has unsaved changes. Discard them and close?', confirmLabel = 'Discard' } = {}) {
    return CoreAPI.showConfirm({
        title,
        message,
        confirmLabel,
        cancelLabel: 'Keep Editing',
        danger: true,
    });
}

async function maybeClose() {
    if (isDirty()) {
        const confirmed = await showUnsavedConfirm();
        if (!confirmed) return;
    }
    closeModal();
}

function resetForm() {
    const fields = [
        'creatorName', 'creatorAuthor', 'creatorVersion', 'creatorDescription',
        'creatorPersonality', 'creatorScenario', 'creatorFirstMes', 'creatorMesExample',
        'creatorSystemPrompt', 'creatorPostHistory', 'creatorNotes', 'creatorTagline',
    ];
    fields.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });

    avatarBuffer = null;
    if (avatarDataUrl) URL.revokeObjectURL(avatarDataUrl);
    avatarDataUrl = null;
    avatarSourceAvatar = null;
    importSourceId = null;
    importSourceName = '';
    carried = null;
    creatorTagsArray = [];
    clearTagSuggestions();

    const preview = document.getElementById('creatorAvatarPreview');
    if (preview) {
        preview.style.backgroundImage = '';
        preview.classList.remove('has-image');
        preview.querySelector('i').hidden = false;
        preview.querySelector('span').hidden = false;
    }
    document.getElementById('creatorAvatarClear')?.classList.add('hidden');
    const mobileAvatar = document.getElementById('creatorMobileAvatarPreview');
    if (mobileAvatar) mobileAvatar.innerHTML = '<i class="fa-solid fa-image"></i>';
    document.getElementById('creatorAltGreetings').innerHTML = '';
    renderCreatorTags();
    clearAllFieldStates();
    // the conversation belonged to the draft that was just cleared
    studioMod?.resetStudioSubject();
}

// pad: the form fields keep a little breathing room under the text, a local quirk the
// composers dont share.
function autoGrowField(ta) {
    CoreAPI.fitTextarea(ta, { pad: 4 });
}

function detachFieldsAutoGrow() {
    if (!fieldsAutoGrowHandler) return;
    document.querySelector('.creator-fields')?.removeEventListener('input', fieldsAutoGrowHandler);
    fieldsAutoGrowHandler = null;
}

function clearAllFieldStates() {
    document.querySelectorAll('.creator-ai-btn').forEach(btn => {
        btn.classList.remove('generating');
        btn.disabled = false;
    });
    const btn = document.getElementById('creatorFieldsToggle');
    if (btn?.classList.contains('active')) {
        btn.classList.remove('active');
        const icon = btn.querySelector('i');
        if (icon) icon.className = 'fa-solid fa-up-right-and-down-left-from-center';
        btn.title = 'Expand all fields to fit content';
        document.querySelectorAll('.creator-fields textarea.glass-input, .creator-alt-textarea').forEach(ta => {
            ta.style.height = '';
        });
        detachFieldsAutoGrow();
    }
}

function toggleFieldExpand() {
    const btn = document.getElementById('creatorFieldsToggle');
    const icon = btn?.querySelector('i');
    if (!btn || !icon) return;
    const container = document.querySelector('.creator-fields');
    const textareas = document.querySelectorAll('.creator-fields textarea.glass-input, .creator-alt-textarea');
    if (btn.classList.contains('active')) {
        textareas.forEach(ta => { ta.style.height = ''; });
        detachFieldsAutoGrow();
        btn.classList.remove('active');
        icon.className = 'fa-solid fa-up-right-and-down-left-from-center';
        btn.title = 'Expand all fields to fit content';
    } else {
        // Initial pass only expands fields that already overflow, so empty textareas keep their min-height.
        textareas.forEach(ta => {
            if (ta.scrollHeight > ta.clientHeight) autoGrowField(ta);
        });
        // Delegated on .creator-fields so textareas added/removed after the toggle (alt-greetings) still grow.
        if (container && !fieldsAutoGrowHandler) {
            fieldsAutoGrowHandler = (e) => {
                const ta = e.target;
                if (ta?.matches?.('.creator-fields textarea.glass-input, .creator-alt-textarea')) {
                    autoGrowField(ta);
                }
            };
            container.addEventListener('input', fieldsAutoGrowHandler);
        }
        btn.classList.add('active');
        icon.className = 'fa-solid fa-down-left-and-up-right-to-center';
        btn.title = 'Contract fields to default size';
    }
}


// ========================================
// EVENT WIRING
// ========================================

function attachEvents() {
    const modal = document.getElementById('creatorModal');
    if (!modal) return;

    document.getElementById('creatorClose').addEventListener('click', maybeClose);
    document.getElementById('creatorCancelBtn').addEventListener('click', maybeClose);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) maybeClose();
    });

    document.getElementById('creatorFieldsToggle')?.addEventListener('click', toggleFieldExpand);
    document.getElementById('creatorStudioToggle')?.addEventListener('click', () => void toggleStudio());
    document.getElementById('creatorMobileStudioBtn')?.addEventListener('click', () => void toggleStudio());

    document.getElementById('creatorCreateBtn').addEventListener('click', handleCreate);

    document.getElementById('creatorAvatarPreview').addEventListener('click', () => {
        document.getElementById('creatorAvatarInput').click();
    });
    document.getElementById('creatorAvatarInput').addEventListener('change', handleAvatarSelect);
    document.getElementById('creatorAvatarClear').addEventListener('click', handleAvatarClear);
    const avatarDrop = document.getElementById('creatorAvatarPreview');
    avatarDrop.addEventListener('dragover', (e) => { e.preventDefault(); avatarDrop.classList.add('drag-over'); });
    avatarDrop.addEventListener('dragleave', () => avatarDrop.classList.remove('drag-over'));
    avatarDrop.addEventListener('drop', (e) => {
        e.preventDefault();
        avatarDrop.classList.remove('drag-over');
        const file = [...(e.dataTransfer?.files || [])].find(f => f.type.startsWith('image/'));
        if (file) processAvatarFile(file);
    });

    document.getElementById('creatorAddAltGreeting').addEventListener('click', () => addAltGreeting());
    document.getElementById('creatorAltGreetings').addEventListener('click', (e) => {
        const removeBtn = e.target.closest('.creator-alt-remove');
        if (removeBtn) removeBtn.closest('.creator-alt-greeting-item').remove();
    });

    modal.addEventListener('click', (e) => {
        const aiBtn = e.target.closest('.creator-ai-btn');
        if (aiBtn && aiBtn.dataset.field) void openStudioFor(aiBtn.dataset.field);
    });

    document.getElementById('creatorNotesPreviewBtn')?.addEventListener('click', openNotesPreview);

    document.getElementById('creatorImportBtn').addEventListener('click', openImportPicker);
    document.getElementById('creatorMobileImportBtn')?.addEventListener('click', openImportPicker);
    document.addEventListener('cl-mobile-mode-change', placeTagSection);

    // Split menu is delegated: renderSplitMenu rebuilds the rows per open, so a
    // direct listener on a row would die with the first rebuild.
    document.getElementById('creatorCreateCaret').addEventListener('click', toggleSplitMenu);
    document.getElementById('creatorSplitMenu').addEventListener('click', (e) => {
        const btn = e.target.closest('#creatorSaveOverBtn, #creatorSaveAsBtn');
        if (!btn) return;
        closeSplitMenu();
        if (btn.id === 'creatorSaveOverBtn') saveOverSource();
        else openSaveAsPicker();
    });
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.creator-split-btn')) closeSplitMenu();
    });

    document.getElementById('creatorMobileAvatarPreview')?.addEventListener('click', () => {
        document.getElementById('creatorAvatarInput')?.click();
    });

    const tagInput = document.getElementById('creatorTagInput');
    tagInput?.addEventListener('keydown', handleTagKeydown);
    // each keystroke asks the server, so a typing burst asks once
    tagInput?.addEventListener('input', CoreAPI.debounce(showCreatorTagSuggestions, 150));
    tagInput?.addEventListener('focus', showCreatorTagSuggestions);
    document.getElementById('creatorTagAiBtn')?.addEventListener('click', suggestTags);
    document.addEventListener('click', (e) => {
        if (!e.target.closest('#creatorTagInput') && !e.target.closest('#creatorTagAutocomplete')) {
            document.getElementById('creatorTagAutocomplete')?.classList.remove('visible');
        }
    });
}


// ========================================
// AVATAR HANDLING
// ========================================

async function handleAvatarSelect(e) {
    const file = e.target.files?.[0];
    if (file) await processAvatarFile(file);
    e.target.value = '';
}

// One processing path for the picker AND drag-drop, so the checks cannot fork.
async function processAvatarFile(file) {
    if (!file.type.startsWith('image/')) {
        CoreAPI.showToast('Please select an image file', 'warning');
        return;
    }

    if (file.size > 20 * 1024 * 1024) {
        CoreAPI.showToast('Image is too large (max 20MB)', 'warning');
        return;
    }

    try {
        const originalBuffer = await file.arrayBuffer();
        // a picture that will not read leaves the one already picked, which the preview still shows
        const png = await convertToPng(originalBuffer);
        if (!png) {
            CoreAPI.showToast('Could not read this image: the file may be damaged, or in a format this browser cannot open', 'error');
            return;
        }
        avatarBuffer = png;
        avatarSourceAvatar = null;

        const blob = new Blob([avatarBuffer], { type: 'image/png' });
        if (avatarDataUrl) URL.revokeObjectURL(avatarDataUrl);
        avatarDataUrl = URL.createObjectURL(blob);

        const preview = document.getElementById('creatorAvatarPreview');
        preview.style.backgroundImage = `url(${avatarDataUrl})`;
        preview.classList.add('has-image');
        preview.querySelector('i').hidden = true;
        preview.querySelector('span').hidden = true;
        document.getElementById('creatorAvatarClear').classList.remove('hidden');

        const mobileAvatar = document.getElementById('creatorMobileAvatarPreview');
        if (mobileAvatar) {
            mobileAvatar.innerHTML = `<img src="${avatarDataUrl}" alt="">`;
        }
    } catch (err) {
        console.error('[Creator] Avatar processing failed:', err);
        CoreAPI.showToast(`Could not use this image: ${err?.message || err}`, 'error');
    }
}

function handleAvatarClear() {
    if (avatarDataUrl) URL.revokeObjectURL(avatarDataUrl);
    avatarBuffer = null;
    avatarDataUrl = null;
    avatarSourceAvatar = null;

    const preview = document.getElementById('creatorAvatarPreview');
    preview.style.backgroundImage = '';
    preview.classList.remove('has-image');
    preview.querySelector('i').hidden = false;
    preview.querySelector('span').hidden = false;
    document.getElementById('creatorAvatarClear').classList.add('hidden');

    const mobileAvatar = document.getElementById('creatorMobileAvatarPreview');
    if (mobileAvatar) {
        mobileAvatar.innerHTML = '<i class="fa-solid fa-image"></i>';
    }
}

async function convertToPng(imageBuffer) {
    const header = new Uint8Array(imageBuffer, 0, 4);
    const isPng = header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4E && header[3] === 0x47;
    if (isPng) return imageBuffer;

    try {
        const blob = new Blob([imageBuffer]);
        const bitmap = await createImageBitmap(blob);
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        const pngBlob = await canvas.convertToBlob({ type: 'image/png' });
        return await pngBlob.arrayBuffer();
    } catch {
        const fallback = CoreAPI.convertImageToPng(imageBuffer);
        if (fallback) return fallback;
    }
    return null;
}


// ========================================
// TAG INPUT
// ========================================

function renderCreatorTags() {
    const container = document.getElementById('creatorTagsContainer');
    if (!container) return;
    CoreAPI.renderEditableTagChips(container, creatorTagsArray, (tag) => {
        creatorTagsArray = creatorTagsArray.filter(t => t !== tag);
        renderCreatorTags();
    });
}

function handleTagKeydown(e) {
    if (CoreAPI.tagAutocompleteKeydown(e, document.getElementById('creatorTagAutocomplete'))) return;
    if (e.key === 'Enter') {
        e.preventDefault();
        const val = e.target.value.trim();
        if (val && !creatorTagsArray.includes(val)) {
            creatorTagsArray.push(val);
            renderCreatorTags();
        }
        e.target.value = '';
        document.getElementById('creatorTagAutocomplete')?.classList.remove('visible');
    }
}

// the app's tag suggestions under the field; a pick joins the form's tags
function showCreatorTagSuggestions() {
    const input = document.getElementById('creatorTagInput');
    const dropdown = document.getElementById('creatorTagAutocomplete');
    if (!input || !dropdown) return;
    return CoreAPI.showTagAutocomplete(input.value, {
        dropdown, exclude: creatorTagsArray, allowCreate: false,
        onPick: (tag) => {
            if (!creatorTagsArray.includes(tag)) {
                creatorTagsArray.push(tag);
                renderCreatorTags();
            }
            input.value = '';
            dropdown.classList.remove('visible');
        },
    });
}


// ========================================
// THE TAG WAND
// ========================================

// one click, no session: the studio's connection suggests tags over the draft, landing as pills to pick from
async function suggestTags() {
    if (tagAiBusy) return;
    const btn = document.getElementById('creatorTagAiBtn');
    const box = document.getElementById('creatorTagSuggestions');
    if (!box) return;
    const draft = readDraft();
    if (!draft.name?.trim() && !draft.description?.trim()) {
        CoreAPI.showToast('Give the character a name or a description first', 'warning', 3000);
        return;
    }
    tagAiBusy = true;
    btn?.classList.add('generating');
    box.innerHTML = '<span class="creator-tag-suggestions-loading"><i class="fa-solid fa-spinner fa-spin"></i> Suggesting tags</span>';
    box.classList.remove('hidden');
    try {
        const mod = await mountStudio();
        if (!mod) throw new Error('the studio could not load');
        const items = (await mod.suggestTags(draft)).filter(t => !creatorTagsArray.includes(t.tag));
        if (!items.length) { box.innerHTML = '<span class="creator-tag-suggestions-empty">No new tags to suggest.</span>'; return; }
        renderTagSuggestions(items);
    } catch (err) {
        box.innerHTML = `<span class="creator-tag-suggestions-empty">Could not suggest tags: ${CoreAPI.escapeHtml(err?.message || String(err))}</span>`;
    } finally {
        tagAiBusy = false;
        btn?.classList.remove('generating');
    }
}

// items are { tag, known, count }: a known tag wears the library's spelling and count, a new one is dashed
function renderTagSuggestions(items) {
    const container = document.getElementById('creatorTagSuggestions');
    if (!container) return;

    const pillsHtml = items.map(t => {
        const tag = CoreAPI.escapeHtml(t.tag);
        const title = t.known ? `In your library on ${t.count ?? '?'} card${t.count === 1 ? '' : 's'}` : 'Not in your library yet';
        const count = t.known && t.count != null ? `<span class="creator-tag-suggestion-count">${t.count}</span>` : '';
        return `<button type="button" class="creator-tag-suggestion-pill ${t.known ? 'is-known' : 'is-new'}" data-tag="${tag}" title="${title}">${tag}${count}</button>`;
    }).join('');

    container.innerHTML = `
        <div class="creator-tag-suggestions-header">
            <span>Suggestions</span>
            <button type="button" class="creator-tag-suggestions-add-all" title="Add all">Add All</button>
            <button type="button" class="creator-tag-suggestions-dismiss" title="Dismiss"><i class="fa-solid fa-times"></i></button>
        </div>
        <div class="creator-tag-suggestions-pills">${pillsHtml}</div>`;
    container.classList.remove('hidden');

    container.querySelector('.creator-tag-suggestions-dismiss')?.addEventListener('click', clearTagSuggestions);

    container.querySelector('.creator-tag-suggestions-add-all')?.addEventListener('click', () => {
        container.querySelectorAll('.creator-tag-suggestion-pill:not(.added)').forEach(pill => {
            const tag = pill.dataset.tag;
            if (tag && !creatorTagsArray.includes(tag)) {
                creatorTagsArray.push(tag);
                pill.classList.add('added');
            }
        });
        renderCreatorTags();
    });

    container.querySelectorAll('.creator-tag-suggestion-pill').forEach(pill => {
        pill.addEventListener('click', () => {
            const tag = pill.dataset.tag;
            if (pill.classList.contains('added')) {
                creatorTagsArray = creatorTagsArray.filter(t => t !== tag);
                pill.classList.remove('added');
            } else if (!creatorTagsArray.includes(tag)) {
                creatorTagsArray.push(tag);
                pill.classList.add('added');
            }
            renderCreatorTags();
        });
    });
}

function clearTagSuggestions() {
    const container = document.getElementById('creatorTagSuggestions');
    if (!container) return;
    container.classList.add('hidden');
    container.innerHTML = '';
}

// ========================================
// ALT GREETINGS
// ========================================

function addAltGreeting(value = '') {
    const container = document.getElementById('creatorAltGreetings');
    const idx = container.children.length + 1;
    const item = document.createElement('div');
    item.className = 'creator-alt-greeting-item';
    item.innerHTML = `
        <textarea class="glass-input creator-alt-textarea" rows="3" placeholder="Alternate greeting #${idx}..."></textarea>
        <button type="button" class="creator-alt-remove" title="Remove"><i class="fa-solid fa-times"></i></button>
    `;
    // a greeting from a card or the studio is text, set as the field's value and never parsed
    item.querySelector('textarea').value = value;
    container.appendChild(item);
}

function collectAltGreetings() {
    const container = document.getElementById('creatorAltGreetings');
    if (!container) return [];
    return Array.from(container.querySelectorAll('.creator-alt-textarea'))
        .map(ta => ta.value.trim())
        .filter(Boolean);
}


// ========================================
// IMPORT FROM LIBRARY
// ========================================

let importPickerInjected = false;

function createImportPicker() {
    if (importPickerInjected) return;
    importPickerInjected = true;

    const html = `
    <div id="creatorImportPicker" class="creator-import-overlay hidden">
        <div class="creator-import-panel">
            <div class="creator-import-header">
                <h3><i class="fa-solid fa-file-import"></i> Import from Library</h3>
                <button type="button" class="creator-import-close" id="importPickerClose" aria-label="Close">
                    <i class="fa-solid fa-times"></i>
                </button>
            </div>
            <div class="creator-import-search">
                <i class="fa-solid fa-search"></i>
                <input type="search" id="importPickerSearch" class="glass-input" placeholder="Search characters..." autocomplete="one-time-code">
            </div>
            <div class="creator-import-list" id="importPickerList"></div>
        </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', html);

    document.getElementById('importPickerClose').addEventListener('click', closeImportPicker);
    document.getElementById('creatorImportPicker').addEventListener('click', (e) => {
        if (e.target.id === 'creatorImportPicker') closeImportPicker();
    });
    document.getElementById('importPickerSearch').addEventListener('input', (e) => {
        const mode = document.getElementById('creatorImportPicker')?.dataset.mode;
        const q = e.target.value.trim().toLowerCase();
        // Debounce so a keystroke storm collapses to one filter+render pass.
        clearTimeout(importSearchTimer);
        importSearchTimer = setTimeout(() => renderImportList(q, mode === 'saveas'), 120);
    });
    document.getElementById('importPickerList').addEventListener('click', (e) => {
        const item = e.target.closest('.creator-import-item');
        if (item) {
            const mode = document.getElementById('importPickerList')?.dataset.mode;
            if (mode === 'saveas') {
                handleSaveAsSelection(item.dataset.charId);
            } else {
                importCharacterFromLibrary(item.dataset.charId);
                closeImportPicker();
            }
        }
    });
}

async function openImportPicker() {
    createImportPicker();
    document.getElementById('importPickerSearch').value = '';
    const picker = document.getElementById('creatorImportPicker');
    picker.classList.remove('hidden');
    picker.dataset.mode = 'import';
    picker.querySelector('h3').innerHTML = '<i class="fa-solid fa-file-import"></i> Import from Library';
    // Desktop nicety only: on a phone this raises the keyboard over the list.
    if (!CoreAPI.isMobileMode()) requestAnimationFrame(() => document.getElementById('importPickerSearch')?.focus());
    await renderImportList('');
}

function closeImportPicker() {
    document.getElementById('creatorImportPicker')?.classList.add('hidden');
}

// The list is a server query (name/creator/tag search, name sort, 100-row page);
// no library mirror. A render token drops out-of-order responses on fast typing.
let _importRenderToken = 0;
async function renderImportList(query, isSaveAs = false) {
    const list = document.getElementById('importPickerList');
    if (!list) return;
    const token = ++_importRenderToken;

    let display = [];
    try {
        const rows = await CoreAPI.fetchCharactersWhere({
            ...(query ? { q: query, qIn: 'name,creator,tags' } : {}),
            sort: 'name',
            limit: 100,
        });
        // stable prefix-first partition keeps the old "name starts with" ordering
        if (query) {
            const starts = [], rest = [];
            for (const c of rows) (((c.name || '').toLowerCase()).startsWith(query) ? starts : rest).push(c);
            display = starts.concat(rest);
        } else {
            display = rows;
        }
    } catch (err) {
        console.error('[Creator] import picker query failed:', err);
        if (token !== _importRenderToken) return;
        list.dataset.mode = isSaveAs ? 'saveas' : 'import';
        // A failed query is UNKNOWN, never "no characters": rendering the empty state
        // here reads as the library missing and the picker being broken.
        list.innerHTML = '<div class="creator-import-empty">The search failed, so this list is unknown rather than empty. Try again.</div>';
        return;
    }
    if (token !== _importRenderToken) return;
    list.dataset.mode = isSaveAs ? 'saveas' : 'import';

    list.innerHTML = display.map(c => {
        const name = CoreAPI.escapeHtml(c.name || 'Unknown');
        const creator = c.data?.creator ? CoreAPI.escapeHtml(c.data.creator) : '';
        const avatarPath = c.id ? CoreAPI.getCharacterAvatarSmallThumbUrl(c.id) : '';
        return `
            <div class="creator-import-item" data-char-id="${CoreAPI.escapeHtml(c.id || '')}">
                <div class="creator-import-avatar" ${avatarPath ? `style="background-image: url(&quot;${avatarPath}&quot;)"` : ''}></div>
                <div class="creator-import-info">
                    <span class="creator-import-name">${name}</span>
                    ${creator ? `<span class="creator-import-creator">${creator}</span>` : ''}
                </div>
            </div>`;
    }).join('');

    if (!display.length) {
        list.innerHTML = '<div class="creator-import-empty">No characters found</div>';
    } else if (display.length === 100) {
        // The page size, so the list is almost certainly truncated on a big library.
        list.insertAdjacentHTML('beforeend',
            '<div class="creator-import-more">Showing the first 100 by name. Type to narrow the search.</div>');
    }
}

async function importCharacterFromLibrary(charId) {
    if (!charId) return;
    // an import overwrites the whole form, so a filled one is asked about first, as a close is
    if (isDirty() && !(await showUnsavedConfirm({
        title: 'Replace the draft?',
        message: 'Importing replaces every field of the form, its tags, greetings and picture. Discard the unsaved draft?',
        confirmLabel: 'Replace',
    }))) return;

    const char = await CoreAPI.ensureCharacterById(charId);
    if (!char) {
        CoreAPI.showToast('Character not found', 'error');
        return;
    }

    await CoreAPI.hydrateCharacter(char);
    if (char._slim) CoreAPI.showToast('Could not load the full card; some fields may be empty', 'warning');
    const data = char.data || {};

    document.getElementById('creatorName').value = char.name || '';
    document.getElementById('creatorAuthor').value = data.creator || '';
    document.getElementById('creatorVersion').value = data.character_version || '';
    document.getElementById('creatorDescription').value = data.description || '';
    document.getElementById('creatorPersonality').value = data.personality || '';
    document.getElementById('creatorScenario').value = data.scenario || '';
    document.getElementById('creatorFirstMes').value = data.first_mes || '';
    document.getElementById('creatorMesExample').value = data.mes_example || '';
    document.getElementById('creatorSystemPrompt').value = data.system_prompt || '';
    document.getElementById('creatorPostHistory').value = data.post_history_instructions || '';
    document.getElementById('creatorNotes').value = data.creator_notes || '';
    // Read tagline from the active namespace so the imported source carries its tagline forward whatever its origin.
    const importTaglineNs = CoreAPI.getActiveTaglineNamespace(char) ?? 'cl';
    document.getElementById('creatorTagline').value = data.extensions?.[importTaglineNs]?.tagline || '';

    document.getElementById('creatorAltGreetings').innerHTML = '';
    if (Array.isArray(data.alternate_greetings)) {
        data.alternate_greetings.forEach(g => addAltGreeting(g));
    }

    creatorTagsArray = Array.isArray(data.tags) ? [...data.tags] : [];
    renderCreatorTags();

    // the picture is replaced like every field: a character with none, or one that failed to load, leaves none
    let pictureFailed = null;
    let blob = null;
    try {
        const resp = await fetch(CoreAPI.getCharacterAvatarUrl(charId));
        if (resp.ok) blob = await resp.blob();
        else if (resp.status !== 404) pictureFailed = `the server answered ${resp.status}`;
    } catch (err) {
        pictureFailed = err?.message || String(err);
    }
    if (blob) {
        avatarBuffer = await blob.arrayBuffer();
        if (avatarDataUrl) URL.revokeObjectURL(avatarDataUrl);
        avatarDataUrl = URL.createObjectURL(blob);
        avatarSourceAvatar = charId;
        const preview = document.getElementById('creatorAvatarPreview');
        if (preview) {
            preview.style.backgroundImage = `url(${avatarDataUrl})`;
            preview.classList.add('has-image');
            preview.querySelector('i').hidden = true;
            preview.querySelector('span').hidden = true;
        }
        document.getElementById('creatorAvatarClear')?.classList.remove('hidden');
        const mobileAvatar = document.getElementById('creatorMobileAvatarPreview');
        if (mobileAvatar) mobileAvatar.innerHTML = `<img src="${avatarDataUrl}" alt="">`;
    } else {
        handleAvatarClear();
    }

    importSourceId = charId;
    importSourceName = char.name || '';
    const reading = await readCarried(charId, char.name || '');
    // a later import or a reset while this read was out owns the form now
    if (importSourceId !== charId) return;
    carried = reading;
    studioMod?.resetStudioSubject();
    if (pictureFailed) {
        CoreAPI.showToast(`Imported "${char.name}" fields, but not its picture (${pictureFailed}). Add one before Create, or the character is saved without one.`, 'warning', 8000);
    } else {
        CoreAPI.showToast(`Imported "${char.name}" fields`, 'success', 2000);
    }
}

// ========================================
// CARRIED OVER: what Create takes from the imported character beyond the form
// ========================================

function carriedFrom(detail) {
    const data = detail?.card?.data || {};
    const composed = new Set([...(detail?.providerLinks || []).map(l => l.providerId), 'world', 'update_locked', 'fav']);
    return {
        book: data.character_book && typeof data.character_book === 'object' ? data.character_book : null,
        extensions: Object.fromEntries(Object.entries(data.extensions || {}).filter(([k]) => !composed.has(k))),
        mediaCount: Number(detail?.mediaCount) || 0,
    };
}

// the extension keys that hold more than the defaults a new card gets anyway
function otherCarriedKeys(extensions) {
    return Object.entries(extensions).filter(([k, v]) => {
        if (k === 'depth_prompt') return false;
        if (k === 'talkativeness') return String(v) !== '0.5';
        if (k === 'group_only_greetings') return Array.isArray(v) && v.length > 0;
        if (k === 'cl') return v && typeof v === 'object' && Object.keys(v).some(key => key !== 'tagline');
        return true;
    }).map(([k]) => k);
}

function bookEntryCount(book) {
    const entries = book?.entries;
    return Array.isArray(entries) ? entries.length : Object.keys(entries || {}).length;
}

async function readCarried(charId, name) {
    try {
        const detail = await CoreAPI.readAnswer(await CoreAPI.apiRequest(`/characters/${encodeURIComponent(charId)}`));
        return { fromId: charId, fromName: name, ...carriedFrom(detail), keep: { book: true, note: true, other: true, gallery: true } };
    } catch (e) {
        CoreAPI.showToast(`Could not read what "${name}" holds beyond these fields (its lorebook, its Character's Note, its gallery), so Create will not carry them: ${e.message}`, 'warning', 8000);
        return null;
    }
}

// the parts the switches leave on, in the shape withCarried reads
function carriedParts(c) {
    if (!c) return null;
    const extensions = {};
    for (const [k, v] of Object.entries(c.extensions)) {
        if (k === 'depth_prompt' ? c.keep.note : c.keep.other) extensions[k] = v;
    }
    return { book: c.keep.book ? c.book : null, extensions };
}

// the form's card with what it carries: the form wins where it has a field, the carried parts fill the rest
function withCarried(card, parts) {
    if (!parts) return card;
    const data = card.data;
    if (parts.book) data.character_book = parts.book;
    const formCl = data.extensions.cl;
    const extensions = { ...data.extensions };
    for (const [k, v] of Object.entries(parts.extensions)) if (k !== 'cl') extensions[k] = v;
    // the tagline is the form's own field, so the carried namespace keeps everything but it
    const carriedCl = parts.extensions.cl && typeof parts.extensions.cl === 'object' ? { ...parts.extensions.cl } : {};
    delete carriedCl.tagline;
    const cl = { ...carriedCl, ...(formCl || {}) };
    if (Object.keys(cl).length) extensions.cl = cl;
    else delete extensions.cl;
    data.extensions = extensions;
    return card;
}

// one switch per part the source holds, each on unless the reader turned it off
function carryRows(c) {
    if (!c) return [];
    const row = (part, label, title = '') => `
        <label class="creator-carried-row"${title ? ` title="${CoreAPI.escapeHtml(title)}"` : ''}>
            <input type="checkbox" class="cl-switch-input" data-carry="${CoreAPI.escapeHtml(part)}"${c.keep[part] ? ' checked' : ''}>
            <span class="cl-switch" aria-hidden="true"></span>
            <span>${CoreAPI.escapeHtml(label)}</span>
        </label>`;
    const rows = [];
    if (c.book) {
        const n = bookEntryCount(c.book);
        rows.push(row('book', `Embedded lorebook (${n} ${n === 1 ? 'entry' : 'entries'})`));
    }
    if (String(c.extensions.depth_prompt?.prompt || '').trim()) rows.push(row('note', 'Character\'s Note'));
    const others = otherCarriedKeys(c.extensions);
    if (others.length) rows.push(row('other', 'Other card settings', others.join(', ')));
    if (c.mediaCount) rows.push(row('gallery', `Gallery (${c.mediaCount} ${c.mediaCount === 1 ? 'file' : 'files'})`));
    return rows;
}

let carryConfirmInjected = false;
let carryAnswer = null;

function createCarryConfirmModal() {
    if (carryConfirmInjected) return;
    carryConfirmInjected = true;
    const html = `
    <div id="creatorCarryConfirm" class="cl-modal cl-modal-drawer cl-drawer-partial creator-carry-overlay">
        <div class="cl-modal-content creator-carry-content">
            <div class="cl-modal-header">
                <h3><i class="fa-solid fa-suitcase"></i> Carried Over</h3>
                <button type="button" class="cl-modal-close" id="carryConfirmClose" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="cl-modal-body">
                <p class="creator-carried-hint" id="carryConfirmHint"></p>
                <div class="creator-carried-list" id="carryConfirmList"></div>
            </div>
            <div class="cl-modal-footer">
                <button type="button" class="cl-btn cl-btn-secondary" id="carryConfirmBack">Back</button>
                <button type="button" class="cl-btn cl-btn-primary" id="carryConfirmCreate">
                    <i class="fa-solid fa-plus"></i> Create Character
                </button>
            </div>
        </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
    CoreAPI.mountDialogSizing('creatorCarryConfirm');
    document.getElementById('carryConfirmClose').addEventListener('click', () => closeCarryConfirm(false));
    document.getElementById('carryConfirmBack').addEventListener('click', () => closeCarryConfirm(false));
    document.getElementById('carryConfirmCreate').addEventListener('click', () => closeCarryConfirm(true));
    document.getElementById('creatorCarryConfirm').addEventListener('click', (e) => {
        if (e.target.id === 'creatorCarryConfirm') closeCarryConfirm(false);
    });
    document.getElementById('carryConfirmList').addEventListener('change', (e) => {
        const part = e.target.dataset?.carry;
        if (carried && part in carried.keep) carried.keep[part] = e.target.checked;
    });
}

// Create asks once the draft came from an import holding something the form cannot show; Back keeps the draft
function confirmCarry() {
    createCarryConfirmModal();
    document.getElementById('carryConfirmHint').innerHTML = `The new character also gets these parts of <strong>${CoreAPI.escapeHtml(carried.fromName)}</strong>,
        which the form has no fields for.`;
    document.getElementById('carryConfirmList').innerHTML = carryRows(carried).join('');
    document.getElementById('creatorCarryConfirm').classList.add('visible');
    if (!CoreAPI.isMobileMode()) requestAnimationFrame(() => document.getElementById('carryConfirmCreate')?.focus());
    return new Promise((resolve) => { carryAnswer = resolve; });
}

function closeCarryConfirm(go) {
    document.getElementById('creatorCarryConfirm')?.classList.remove('visible');
    const answer = carryAnswer;
    carryAnswer = null;
    answer?.(go);
}

// the source's gallery copied into the new character on the server; a shortfall is said, the character stands
async function copyCarriedGallery(toId, fromId) {
    try {
        const out = await CoreAPI.readAnswer(await CoreAPI.apiRequest(`/characters/${encodeURIComponent(toId)}/media/copy`, 'POST', { from: fromId }));
        if (out?.missing) CoreAPI.showToast(`${out.missing} gallery ${out.missing === 1 ? 'file' : 'files'} could not be copied: the file is gone from the original's gallery`, 'warning', 8000);
        return out;
    } catch (e) {
        CoreAPI.showToast(`The character was created, but its gallery was not copied: ${e.message}`, 'warning', 8000);
        return null;
    }
}

// ========================================
// CREATOR NOTES PREVIEW
// ========================================

let notesPreviewInjected = false;

function createNotesPreviewModal() {
    if (notesPreviewInjected) return;
    notesPreviewInjected = true;

    const html = `
    <div id="creatorNotesPreview" class="modal-overlay hidden">
        <div class="modal-glass creator-notes-fullscreen-modal" id="creatorNotesPreviewInner">
            <div class="modal-header">
                <h2><i class="fa-solid fa-eye"></i> Creator's Notes Preview</h2>
                <div class="creator-notes-display-controls">
                    <div class="display-control-btns zoom-controls" id="previewZoomBtns">
                        <button type="button" class="display-control-btn" data-zoom="out" title="Zoom Out">
                            <i class="fa-solid fa-minus"></i>
                        </button>
                        <span class="zoom-level" id="previewZoomLevel">100%</span>
                        <button type="button" class="display-control-btn" data-zoom="in" title="Zoom In">
                            <i class="fa-solid fa-plus"></i>
                        </button>
                        <button type="button" class="display-control-btn" data-zoom="reset" title="Reset Zoom">
                            <i class="fa-solid fa-rotate-left"></i>
                        </button>
                    </div>
                </div>
                <div class="modal-controls">
                    <button class="close-btn" id="creatorNotesPreviewClose">&times;</button>
                </div>
            </div>
            <div class="creator-notes-fullscreen-body" id="creatorNotesPreviewBody"></div>
        </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
    CoreAPI.mountDialogSizing('creatorNotesPreview');

    document.getElementById('creatorNotesPreviewClose').addEventListener('click', closeNotesPreview);
    document.getElementById('creatorNotesPreview').addEventListener('click', (e) => {
        if (e.target.id === 'creatorNotesPreview') closeNotesPreview();
    });

    document.getElementById('previewZoomBtns').addEventListener('click', (e) => {
        const btn = e.target.closest('.display-control-btn[data-zoom]');
        if (!btn) return;
        const action = btn.dataset.zoom;
        if (action === 'in') updatePreviewZoom(previewZoom + 10);
        else if (action === 'out') updatePreviewZoom(previewZoom - 10);
        else if (action === 'reset') updatePreviewZoom(100);
    });
}

let previewZoom = 100;

function updatePreviewZoom(zoom) {
    previewZoom = Math.max(50, Math.min(200, zoom));
    const display = document.getElementById('previewZoomLevel');
    if (display) display.textContent = `${previewZoom}%`;

    const iframe = document.querySelector('#creatorNotesPreviewBody iframe');
    if (!iframe) return;
    const scale = previewZoom / 100;
    try {
        const doc = iframe.contentDocument || iframe.contentWindow?.document;
        if (doc?.body) {
            const wrapper = doc.getElementById('content-wrapper');
            if (wrapper) {
                wrapper.style.transform = `scale(${scale})`;
                wrapper.style.transformOrigin = 'top center';
                wrapper.style.width = scale <= 1 ? '100%' : `${100 / scale}%`;
                wrapper.style.margin = '0 auto';
            }
            doc.body.style.zoom = scale;
        }
    } catch { /* sandboxed */ }
}

function openNotesPreview() {
    const content = document.getElementById('creatorNotes')?.value?.trim();
    if (!content) {
        CoreAPI.showToast('No notes to preview', 'warning', 2000);
        return;
    }
    createNotesPreviewModal();

    previewZoom = 100;
    const zoomDisplay = document.getElementById('previewZoomLevel');
    if (zoomDisplay) zoomDisplay.textContent = '100%';
    const container = document.getElementById('creatorNotesPreviewBody');
    const charName = document.getElementById('creatorName')?.value?.trim() || 'Character';
    CoreAPI.renderCreatorNotesSecure(content, charName, container);

    // Last iframe = the render that just ran; the first can be a still-bridging prior render.
    const iframes = container.querySelectorAll('iframe');
    const iframe = iframes[iframes.length - 1];
    if (iframe) {
        // fixed flex height here: setupCreatorNotesResize's onload would re-impose a pixel height and cut the iframe off
        iframe._resizeObserver?.disconnect();
        iframe._resizeObserver = null;
        iframe.onload = null;
        iframe.style.height = '100%';
        iframe.style.maxHeight = 'none';
        iframe.style.minHeight = '0';
        iframe.addEventListener('load', () => {
            setTimeout(() => updatePreviewZoom(previewZoom), 50);
        }, { once: true });
    }

    document.getElementById('creatorNotesPreview').classList.remove('hidden');
}

function closeNotesPreview() {
    document.getElementById('creatorNotesPreview')?.classList.add('hidden');
}

// ========================================
// THE STUDIO PANEL
// ========================================

// the studio reads the draft through these accessors on every request and writes applied results back; the form holds the draft

const DRAFT_INPUTS = {
    name: 'creatorName',
    tagline: 'creatorTagline',
    description: 'creatorDescription',
    personality: 'creatorPersonality',
    scenario: 'creatorScenario',
    first_mes: 'creatorFirstMes',
    mes_example: 'creatorMesExample',
    system_prompt: 'creatorSystemPrompt',
    post_history_instructions: 'creatorPostHistory',
    creator_notes: 'creatorNotes',
};

let studioMod = null;
let studioMounting = null;

/** The draft exactly as the form holds it: untrimmed, so the studio's anchors match the text on screen. */
function readDraft() {
    const draft = {};
    for (const [key, id] of Object.entries(DRAFT_INPUTS)) draft[key] = document.getElementById(id)?.value ?? '';
    draft.tags = [...creatorTagsArray];
    draft.alternate_greetings = Array.from(document.querySelectorAll('#creatorAltGreetings .creator-alt-textarea')).map(ta => ta.value);
    return draft;
}

/** Write an applied result into the form: only the keys named move, each through the form's own path. */
function writeDraft(patch) {
    if (!patch || typeof patch !== 'object') return;
    for (const [key, id] of Object.entries(DRAFT_INPUTS)) {
        if (!(key in patch)) continue;
        const el = document.getElementById(id);
        if (!el) continue;
        el.value = String(patch[key] ?? '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (Array.isArray(patch.tags)) {
        creatorTagsArray = [...patch.tags];
        renderCreatorTags();
    }
    if (Array.isArray(patch.alternate_greetings)) {
        const container = document.getElementById('creatorAltGreetings');
        if (container) {
            container.innerHTML = '';
            patch.alternate_greetings.forEach(g => addAltGreeting(g));
        }
    }
}

async function mountStudio() {
    if (studioMod) return studioMod;
    if (studioMounting) return studioMounting;
    studioMounting = (async () => {
        try {
            const mod = await import('./creator-studio.js');
            mod.mountCreatorStudio(document.querySelector('#creatorModal .creator-body'), {
                readDraft, writeDraft,
                sourceId: () => importSourceId || null,
                // the form's picture as it stands, for the studio to show its partner
                portrait: () => (avatarBuffer ? new Blob([avatarBuffer], { type: 'image/png' }) : null),
                button: 'creatorStudioToggle',
                openers: ['creatorStudioToggle', 'creatorMobileStudioBtn'],
            });
            studioMod = mod;
        } catch (err) {
            console.error('[Creator] The studio could not load:', err);
            CoreAPI.showToast('The studio could not load', 'error');
        }
        studioMounting = null;
        return studioMod;
    })();
    return studioMounting;
}

async function toggleStudio() {
    const mod = await mountStudio();
    mod?.toggleStudio();
}

// a field's wand opens the studio scoped to it; a selection rides the next ask as the passage to revise
async function openStudioFor(field) {
    if (!(field in DRAFT_INPUTS)) return;
    const el = document.getElementById(DRAFT_INPUTS[field]);
    const start = el?.selectionStart ?? 0;
    const end = el?.selectionEnd ?? 0;
    const selection = el && end > start ? { text: el.value.slice(start, end) } : null;
    const mod = await mountStudio();
    await mod?.openStudio({ field, selection });
}

// ========================================
// CHARACTER CREATION
// ========================================

/** character.create: a new character from a card + picture (made PNG, placeholder if none), never onto an existing one; answers { id, name }. */
async function createCharacterFrom({ card, image } = {}) {
    // a card's data alone, or a card whose spec the caller left off, is a V2 card like the form's
    const full = card?.data && typeof card.data === 'object'
        ? { spec: 'chara_card_v2', spec_version: '2.0', ...card }
        : { spec: 'chara_card_v2', spec_version: '2.0', data: { ...(card || {}) } };
    const name = String(full.data.name ?? '').trim();
    if (!name) throw new Error('character.create: a name is required');
    if (name.length > 128) throw new Error('character.create: the name is longer than 128 characters');
    let png = null;
    if (image != null) {
        const buffer = typeof image.arrayBuffer === 'function' ? await image.arrayBuffer()
            : ArrayBuffer.isView(image) ? image.buffer.slice(image.byteOffset, image.byteOffset + image.byteLength) : image;
        // the caller picked this picture, so it keeps its size (the provider path's budget is theirs)
        png = Object.prototype.toString.call(buffer) === '[object ArrayBuffer]' && buffer.byteLength >= 8 ? await convertToPng(buffer) : null;
        if (!png) throw new Error('character.create: the picture is not an image');
    }
    const embedded = CoreAPI.embedCharacterDataInPng(png || await generatePlaceholder(), full);
    // onExisting=copy and NO name hint: a fresh card has no identity to heal onto, a hint could only hit someone elses row
    const response = await CoreAPI.apiRequest('/characters/import?onExisting=copy', 'POST', embedded,
        { raw: true, headers: { 'Content-Type': 'image/png' } });
    if (!response.ok) {
        // spelled here, not readAnswer: the refusal (a bad file, a store guard) is named by the command it refuses
        const body = await response.json().catch(() => null);
        throw new Error(`character.create: ${body?.error || `the import answered ${response.status}`}`);
    }
    const result = await response.json();
    // created:false is the import landing on an existing row: someone else's character, never a new one
    if (!result.id || result.error || result.created === false) throw new Error('character.create: the import resolved onto an existing character instead of making one');
    await CoreAPI.adoptCreatedCharacter(result.id);
    return { id: result.id, name: result.name || name };
}

async function handleCreate() {
    const name = document.getElementById('creatorName')?.value?.trim();
    if (!name) {
        CoreAPI.showToast('Character name is required', 'warning');
        document.getElementById('creatorName')?.focus();
        return;
    }

    if (name.length > 128) {
        CoreAPI.showToast('Character name is too long (max 128 characters)', 'warning');
        return;
    }
    if (carryRows(carried).length && !(await confirmCarry())) return;

    const createBtn = document.getElementById('creatorCreateBtn');
    createBtn.disabled = true;
    createBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Creating...';

    try {
        const made = await runCommand('character.create', { card: withCarried(buildCharacterCard(), carriedParts(carried)), image: avatarBuffer });
        if (!made?.id) throw new Error('the character was not created');

        const copied = carried?.keep.gallery && carried.mediaCount ? await copyCarriedGallery(made.id, carried.fromId) : null;
        CoreAPI.showToast(copied?.copied ? `Character "${name}" created, with ${copied.copied} gallery ${copied.copied === 1 ? 'file' : 'files'}` : `Character "${name}" created`, 'success');

        // the studio conversation this draft came from follows the character it became
        await studioMod?.bindSessionTo(made.id);

        closeModal();

        await CoreAPI.openCharacterById(made.id);
    } catch (err) {
        console.error('[Creator] Character creation failed:', err);
        CoreAPI.showToast(`Creation failed: ${err.message}`, 'error');
    } finally {
        createBtn.disabled = false;
        createBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Create Character';
    }
}

// ========================================
// SAVE AS EXISTING CHARACTER
// ========================================

let saveAsDiffInjected = false;

function createSaveAsDiffModal() {
    if (saveAsDiffInjected) return;
    saveAsDiffInjected = true;

    const html = `
    <div id="creatorSaveAsDiff" class="cl-modal creator-saveas-diff-overlay">
        <div class="cl-modal-content creator-saveas-diff-content">
            <div class="cl-modal-header">
                <h3><i class="fa-solid fa-code-compare"></i> Review Changes</h3>
                <button type="button" class="cl-modal-close" id="saveAsDiffClose" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="cl-modal-body">
                <p class="creator-saveas-diff-subtitle" id="saveAsDiffSubtitle">Changes to be applied:</p>
                <div class="changes-diff" id="saveAsDiffContainer"></div>
            </div>
            <div class="cl-modal-footer">
                <button type="button" class="cl-btn cl-btn-secondary" id="saveAsDiffCancel">Cancel</button>
                <button type="button" class="cl-btn cl-btn-primary" id="saveAsDiffConfirm">
                    <i class="fa-solid fa-floppy-disk"></i> Save Changes
                </button>
            </div>
        </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
    CoreAPI.mountDialogSizing('creatorSaveAsDiff');

    document.getElementById('saveAsDiffClose').addEventListener('click', closeSaveAsDiff);
    document.getElementById('saveAsDiffCancel').addEventListener('click', closeSaveAsDiff);
    document.getElementById('saveAsDiffConfirm').addEventListener('click', confirmSaveAs);
    document.getElementById('creatorSaveAsDiff').addEventListener('click', (e) => {
        if (e.target.id === 'creatorSaveAsDiff') closeSaveAsDiff();
    });
}

function closeSaveAsDiff() {
    saveAsTarget = null;
    document.getElementById('creatorSaveAsDiff')?.classList.remove('visible');
}

function openSaveAsPicker() {
    closeSplitMenu();
    const name = document.getElementById('creatorName')?.value?.trim();
    if (!name) {
        CoreAPI.showToast('Enter a character name first', 'warning');
        document.getElementById('creatorName')?.focus();
        return;
    }
    createImportPicker();
    document.getElementById('importPickerSearch').value = '';
    renderImportList('', true);
    document.getElementById('creatorImportPicker').classList.remove('hidden');
    document.getElementById('creatorImportPicker').dataset.mode = 'saveas';
    document.getElementById('creatorImportPicker').querySelector('h3').innerHTML =
        '<i class="fa-solid fa-floppy-disk"></i> Save As...';
    if (!CoreAPI.isMobileMode()) requestAnimationFrame(() => document.getElementById('importPickerSearch')?.focus());
}

async function handleSaveAsSelection(charId) {
    closeImportPicker();
    // Restore picker title for import use
    const pickerH3 = document.getElementById('creatorImportPicker')?.querySelector('h3');
    if (pickerH3) pickerH3.innerHTML = '<i class="fa-solid fa-file-import"></i> Import from Library';

    const char = await CoreAPI.ensureCharacterById(charId);
    if (!char) { CoreAPI.showToast('Character not found', 'error'); return; }

    await CoreAPI.hydrateCharacter(char);
    if (char._slim) {
        // a swallowed hydrate failure reads heavy fields as '', the diff hides the blanking and the save writes it: refuse
        CoreAPI.showToast('Could not load this character\'s current data; not saving over it', 'error');
        return;
    }
    saveAsTarget = char;

    const currentValues = collectCreatorValues();
    const originalValues = extractOriginalValues(char);
    const changes = generateCreatorDiff(originalValues, currentValues);

    const hasAvatarChange = avatarBuffer && avatarSourceAvatar !== charId;

    if (changes.length === 0 && !hasAvatarChange) {
        CoreAPI.showToast('No changes detected vs. this character', 'info');
        saveAsTarget = null;
        return;
    }

    createSaveAsDiffModal();
    const totalChanges = changes.length + (hasAvatarChange ? 1 : 0);
    document.getElementById('saveAsDiffSubtitle').textContent =
        `${totalChanges} field${totalChanges > 1 ? 's' : ''} changed on "${char.name}":`;

    let diffHtml = '';
    if (hasAvatarChange) {
        const oldSrc = CoreAPI.getCharacterAvatarSmallThumbUrl(charId);
        const newSrc = avatarDataUrl;
        diffHtml += `
        <div class="diff-item">
            <div class="diff-item-label">Avatar</div>
            <div class="diff-avatar-row">
                <div class="diff-avatar-side diff-old">
                    <img src="${CoreAPI.escapeHtml(oldSrc)}" alt="Current">
                    <span>Current</span>
                </div>
                <div class="diff-avatar-arrow"><i class="fa-solid fa-arrow-right"></i></div>
                <div class="diff-avatar-side diff-new">
                    <img src="${CoreAPI.escapeHtml(newSrc)}" alt="New">
                    <span>New</span>
                </div>
            </div>
        </div>`;
    }
    diffHtml += changes.map(c => `
        <div class="diff-item">
            <div class="diff-item-label">${CoreAPI.escapeHtml(c.field)}</div>
            <div class="diff-old">${c.oldHtml}</div>
            <div class="diff-arrow">\u2193</div>
            <div class="diff-new">${c.newHtml}</div>
        </div>
    `).join('');
    document.getElementById('saveAsDiffContainer').innerHTML = diffHtml;
    document.getElementById('creatorSaveAsDiff').classList.add('visible');
}

function collectCreatorValues() {
    return {
        name: document.getElementById('creatorName').value.trim(),
        description: document.getElementById('creatorDescription').value.trim(),
        personality: document.getElementById('creatorPersonality').value.trim(),
        scenario: document.getElementById('creatorScenario').value.trim(),
        first_mes: document.getElementById('creatorFirstMes').value.trim(),
        mes_example: document.getElementById('creatorMesExample').value.trim(),
        system_prompt: document.getElementById('creatorSystemPrompt').value.trim(),
        post_history_instructions: document.getElementById('creatorPostHistory').value.trim(),
        creator_notes: document.getElementById('creatorNotes').value.trim(),
        creator: document.getElementById('creatorAuthor').value.trim(),
        character_version: document.getElementById('creatorVersion').value.trim(),
        tagline: document.getElementById('creatorTagline').value.trim(),
        tags: [...creatorTagsArray],
        alternate_greetings: collectAltGreetings(),
    };
}

function extractOriginalValues(char) {
    const d = char.data || {};
    // Read tagline from the target's active namespace so the diff sees no change when the value already matches.
    const taglineNs = CoreAPI.getActiveTaglineNamespace(char) ?? 'cl';
    return {
        name: char.name || '',
        description: d.description || '',
        personality: d.personality || '',
        scenario: d.scenario || '',
        first_mes: d.first_mes || '',
        mes_example: d.mes_example || '',
        system_prompt: d.system_prompt || '',
        post_history_instructions: d.post_history_instructions || '',
        creator_notes: d.creator_notes || '',
        creator: d.creator || '',
        character_version: d.character_version || '',
        tagline: d.extensions?.[taglineNs]?.tagline || '',
        tags: Array.isArray(d.tags) ? [...d.tags] : [],
        alternate_greetings: Array.isArray(d.alternate_greetings) ? [...d.alternate_greetings] : [],
    };
}

const DIFF_FIELD_LABELS = {
    name: 'Character Name', description: 'Description', personality: 'Personality',
    scenario: 'Scenario', first_mes: 'First Message', mes_example: 'Example Dialogue',
    system_prompt: 'System Prompt', post_history_instructions: 'Post-History Instructions',
    creator_notes: "Creator's Notes", creator: 'Creator', character_version: 'Version',
    tagline: 'Tagline',
    tags: 'Tags', alternate_greetings: 'Alternate Greetings',
};

function generateCreatorDiff(original, current) {
    const changes = [];
    const norm = s => String(s || '').replace(/\r\n/g, '\n').trim();

    for (const key of Object.keys(DIFF_FIELD_LABELS)) {
        // the card's one rule (tags a set without case, as the NOCASE rows store them): a change the write cant make is no change
        if (cardValuesEqual(original[key], current[key], key)) continue;
        if (key === 'tags') {
            const oldT = (original.tags || []).map(t => norm(t)).filter(Boolean).sort((a, b) => a.localeCompare(b));
            const newT = (current.tags || []).map(t => norm(t)).filter(Boolean).sort((a, b) => a.localeCompare(b));
            changes.push({
                field: DIFF_FIELD_LABELS[key],
                oldHtml: CoreAPI.escapeHtml(oldT.join(', ') || '(none)'),
                newHtml: CoreAPI.escapeHtml(newT.join(', ') || '(none)'),
            });
            continue;
        }
        if (key === 'alternate_greetings') {
            const oldG = (original.alternate_greetings || []).map(g => norm(g)).filter(Boolean);
            const newG = (current.alternate_greetings || []).map(g => norm(g)).filter(Boolean);
            changes.push({
                field: DIFF_FIELD_LABELS[key],
                oldHtml: CoreAPI.escapeHtml(oldG.map((g, i) => `#${i+1}: ${g}`).join('\n') || '(none)'),
                newHtml: CoreAPI.escapeHtml(newG.map((g, i) => `#${i+1}: ${g}`).join('\n') || '(none)'),
            });
            continue;
        }
        const oldVal = norm(original[key]);
        const newVal = norm(current[key]);
        changes.push({
            field: DIFF_FIELD_LABELS[key],
            oldHtml: diffHighlight(oldVal, newVal, 'old'),
            newHtml: diffHighlight(oldVal, newVal, 'new'),
        });
    }
    return changes;
}

function diffHighlight(oldStr, newStr, side) {
    if (!oldStr && !newStr) return '<span class="diff-empty">(empty)</span>';
    if (!oldStr) return side === 'old' ? '<span class="diff-empty">(empty)</span>' : `<span class="diff-added">${CoreAPI.escapeHtml(truncDiff(newStr))}</span>`;
    if (!newStr) return side === 'new' ? '<span class="diff-empty">(empty)</span>' : `<span class="diff-removed">${CoreAPI.escapeHtml(truncDiff(oldStr))}</span>`;

    const diffStart = findDiffStart(oldStr, newStr);
    if (diffStart === -1) return CoreAPI.escapeHtml(side === 'old' ? oldStr : newStr);
    const diffEndOld = findDiffEndPos(oldStr, newStr);
    const diffEndNew = findDiffEndPos(newStr, oldStr);

    const str = side === 'old' ? oldStr : newStr;
    const endPos = side === 'old' ? diffEndOld : diffEndNew;
    const cls = side === 'old' ? 'diff-removed' : 'diff-added';

    const MAX = 200;
    if (str.length <= MAX) return buildMarked(str, diffStart, endPos, cls);

    const ctxBefore = 30;
    const start = Math.max(0, diffStart - ctxBefore);
    const end = Math.min(str.length, Math.max(endPos, diffStart) + (MAX - ctxBefore));
    const excerpt = str.substring(start, end);
    const prefix = start > 0 ? '<span class="diff-ellipsis">...</span>' : '';
    const suffix = end < str.length ? '<span class="diff-ellipsis">...</span>' : '';
    return prefix + buildMarked(excerpt, diffStart - start, endPos - start, cls) + suffix;
}

function findDiffStart(a, b) {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) { if (a[i] !== b[i]) return i; }
    return a.length === b.length ? -1 : len;
}

function findDiffEndPos(str, other) {
    let si = str.length - 1, oi = other.length - 1;
    while (si >= 0 && oi >= 0 && str[si] === other[oi]) { si--; oi--; }
    return si + 1;
}

function buildMarked(str, start, end, cls) {
    if (start < 0) start = 0;
    if (end > str.length) end = str.length;
    if (start >= end) return CoreAPI.escapeHtml(str);
    return CoreAPI.escapeHtml(str.substring(0, start)) +
        `<span class="${cls}">${CoreAPI.escapeHtml(str.substring(start, end))}</span>` +
        CoreAPI.escapeHtml(str.substring(end));
}

function truncDiff(s, max = 200) {
    return s.length <= max ? s : s.substring(0, max) + '...';
}

async function confirmSaveAs() {
    if (!saveAsTarget) return;
    // the character the diff was opened over, whatever closes it while this runs
    const target = saveAsTarget;
    const btn = document.getElementById('saveAsDiffConfirm');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';

    try {
        const current = collectCreatorValues();
        const hasAvatarChange = avatarBuffer && avatarSourceAvatar !== target.id;
        const updates = {
            name: current.name,
            description: current.description,
            first_mes: current.first_mes,
            personality: current.personality,
            scenario: current.scenario,
            mes_example: current.mes_example,
            system_prompt: current.system_prompt,
            post_history_instructions: current.post_history_instructions,
            creator_notes: current.creator_notes,
            creator: current.creator,
            character_version: current.character_version,
            tags: current.tags,
            alternate_greetings: current.alternate_greetings,
        };
        // tagline as a dot-path leaf (namespace siblings survive), ONLY when it differs: else an empty box blanks a provider tagline
        const taglineNs = CoreAPI.getActiveTaglineNamespace(target) ?? 'cl';
        const targetTagline = target.data?.extensions?.[taglineNs]?.tagline || '';
        if ((current.tagline || '') !== targetTagline) {
            updates[`extensions.${taglineNs}.tagline`] = current.tagline ?? '';
        }

        // Auto-snapshot before overwrite; embed the old avatar when we're about to replace it so it stays restorable.
        await CoreAPI.autoSnapshotBeforeChange(target, 'edit', { embedAvatar: hasAvatarChange });

        const written = await CoreAPI.writeCardFields(target, updates);
        // a refusal was already said in the server's words; the diff stays open with a working Save
        if (!written.ok) {
            if (!written.told) CoreAPI.showToast('Save failed', 'error');
            return;
        }

        // the fields have landed, so a refused picture is said as its own half
        let pictureError = null;
        if (hasAvatarChange) {
            try { await CoreAPI.editAvatar(target.id, avatarBuffer); } catch (e) { pictureError = e?.message || String(e); }
        }

        await studioMod?.bindSessionTo(target.id);
        await CoreAPI.refreshCharacters(true);
        closeSaveAsDiff();
        if (pictureError) {
            // the creator stays open with its picture, so a second Save As can retry it
            CoreAPI.showToast(`Saved over "${target.name}"; the picture was not saved: ${pictureError}`, 'warning', 8000);
            return;
        }
        CoreAPI.showToast(`Saved over "${target.name}"`, 'success');
        closeModal();
    } catch (err) {
        console.error('[Creator] Save-as failed:', err);
        CoreAPI.showToast(`Save failed: ${err.message}`, 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Changes';
    }
}

// Rebuilt per open: the direct "save over the source" row exists only while the form
// still remembers which library character filled it.
function renderSplitMenu() {
    const menu = document.getElementById('creatorSplitMenu');
    if (!menu) return;
    const sourceRow = importSourceId
        ? `<button type="button" class="dropdown-item" id="creatorSaveOverBtn">
               <i class="fa-solid fa-floppy-disk"></i> Save Over ${CoreAPI.escapeHtml(importSourceName || 'imported character')}
           </button>`
        : '';
    menu.innerHTML = `${sourceRow}
        <button type="button" class="dropdown-item" id="creatorSaveAsBtn">
            <i class="fa-solid fa-user-pen"></i> Save as Existing Character...
        </button>`;
}

function saveOverSource() {
    const name = document.getElementById('creatorName')?.value?.trim();
    if (!name) {
        CoreAPI.showToast('Enter a character name first', 'warning');
        document.getElementById('creatorName')?.focus();
        return;
    }
    if (!importSourceId) { openSaveAsPicker(); return; }
    handleSaveAsSelection(importSourceId);
}

function toggleSplitMenu() {
    const menu = document.getElementById('creatorSplitMenu');
    if (menu?.classList.contains('hidden')) renderSplitMenu();
    menu?.classList.toggle('hidden');
}

function closeSplitMenu() {
    document.getElementById('creatorSplitMenu')?.classList.add('hidden');
}

function buildCharacterCard() {
    const name = document.getElementById('creatorName').value.trim();
    const creator = document.getElementById('creatorAuthor').value.trim();
    const version = document.getElementById('creatorVersion').value.trim();
    const description = document.getElementById('creatorDescription').value.trim();
    const personality = document.getElementById('creatorPersonality').value.trim();
    const scenario = document.getElementById('creatorScenario').value.trim();
    const firstMes = document.getElementById('creatorFirstMes').value.trim();
    const mesExample = document.getElementById('creatorMesExample').value.trim();
    const systemPrompt = document.getElementById('creatorSystemPrompt').value.trim();
    const postHistory = document.getElementById('creatorPostHistory').value.trim();
    const creatorNotes = document.getElementById('creatorNotes').value.trim();
    const tagline = document.getElementById('creatorTagline').value.trim();
    const altGreetings = collectAltGreetings();
    const tags = [...creatorTagsArray];

    // no `fav` (the server strips it) and no `world` (the server lifts it into char_worlds): seeding either is noise
    const extensions = {
        talkativeness: '0.5',
        depth_prompt: { prompt: '', depth: 4, role: 'system' },
        group_only_greetings: [],
    };

    // New cards are unlinked, so tagline lives under the 'cl' namespace; skip when empty to avoid bloating a fresh card.
    if (tagline) extensions.cl = { tagline };

    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name,
            description,
            personality,
            scenario,
            first_mes: firstMes,
            mes_example: mesExample,
            system_prompt: systemPrompt,
            post_history_instructions: postHistory,
            creator_notes: creatorNotes,
            creator,
            character_version: version,
            tags,
            alternate_greetings: altGreetings,
            extensions,
        },
    };
}


// ========================================
// MODULE INIT & EXPORTS
// ========================================

function init() {
    defineCommand('character.create', createCharacterFrom, { title: 'Create a character' });

    // The global Escape handler and the mobile back-button stack both read this
    // registry, so no per-overlay Escape listeners or manual stack entries are needed.
    const reg = window.registerOverlay?.bind(window);
    if (!reg) return;

    reg({ id: 'creatorNotesPreview',          tier: 2, close: () => window.closeNotesPreview?.() });
    reg({ id: 'creatorSaveAsDiff',            tier: 4, close: () => closeSaveAsDiff(), visible: (el) => el.classList.contains('visible') });
    reg({ id: 'creatorCarryConfirm',          tier: 4, close: () => closeCarryConfirm(false), visible: (el) => el.classList.contains('visible') });
    reg({ id: 'creatorImportPicker',          tier: 5, close: () => closeImportPicker?.() });
    reg({ id: 'creatorModal',                 tier: 7, close: () => maybeClose?.() });
}

export { openModal, closeModal, closeNotesPreview };

export default {
    init,
    openModal,
};
