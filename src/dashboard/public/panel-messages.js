
// The message panels — Welcome, Farewell and Birthdays (#935).
//
// Three panels with one behaviour between them: a textarea whose template
// variables are echoed into a preview box as they are typed, plus the Welcome
// panel's "send a real card to the channel" button. Everything else about them
// is markup and a Save button.

// ── Welcome card preview ──────────────────────────────────────────────
async function sendWelcomeCardPreview() {
    const btn = document.getElementById('welcome-preview-btn');
    const guildId = BOOT.guildId;
    const channelId = document.getElementById('welcome-channel').value;
    if (!channelId) { toast('Select a welcome channel first', 'error'); return; }
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
        const resp = await apiFetch(`/api/v1/guild/${guildId}/welcome/preview`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channelId })
        });
        if (resp.ok) {
            toast('Preview sent to channel', 'success');
        } else {
            const d = await resp.json().catch(() => ({}));
            toast(d.error || 'Failed to send preview', 'error');
        }
    } catch { toast('Network error', 'error'); } finally {
        btn.disabled = false;
        btn.textContent = 'Send card preview to channel';
    }
}
// Message preview helper — substitutes template variables with sample values
const PREVIEW_VARS = {
    user: '@SampleUser',
    username: 'SampleUser',
    tag: 'SampleUser#0000',
    server: BOOT.guildName,
    memberCount: '1,234',
    age: '25'
};
function updateMsgPreview(textareaId, previewId) {
    const ta = document.getElementById(textareaId);
    const box = document.getElementById(previewId);
    if (!ta || !box) return;
    const raw = ta.value;
    if (!raw.trim()) { box.textContent = ''; return; }
    const rendered = raw.replace(/\{(\w+)\}/g, (_, key) => PREVIEW_VARS[key] !== undefined ? PREVIEW_VARS[key] : `{${key}}`);
    box.textContent = rendered;
}
// Initialise each preview when its panel arrives
onPanel('welcome',   () => updateMsgPreview('welcome-message', 'welcome-preview'));
onPanel('farewell',  () => updateMsgPreview('farewell-message', 'farewell-preview'));
onPanel('birthdays', () => updateMsgPreview('birthday-message', 'birthday-preview'));

registerPanelActions({
    click: { 'send-welcome-card-preview': () => sendWelcomeCardPreview() },
    input: { 'msg-preview': (el, d) => updateMsgPreview(d.previewSource, d.previewTarget) },
});
