
// The role panels (#935): Autoroles, and Reaction Roles with its published
// panel list.
//
// Both lists are redrawn from what the API returns after every mutation rather
// than patched in place (#689), and both are built with createElement and
// textContent: a role or channel name arrives from the bootstrap map and an
// emoji is whatever the admin typed, so neither is concatenated into markup.

async function addAutoRole() {
    const guildId = BOOT.guildId;
    const select = document.getElementById('autorole-select');
    const roleId = select.value;
    if (!roleId) { toast('Please select a role', 'error'); return; }
    if (document.querySelector(`#autorole-list [data-role-id="${roleId}"]`)) {
        toast('Role already added', 'error'); return;
    }
    try {
        const response = await apiFetch(`/api/v1/guild/${guildId}/autorole`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ roleId })
        });
        if (response.ok) {
            const roleName = select.options[select.selectedIndex].text.replace(/^@/, '');
            // Built with DOM nodes, not innerHTML: a role name is attacker-chosen
            // text from Discord, so `@${roleName}` in a template literal turns any
            // role called `<img onerror=...>` into markup that runs for the next
            // admin to open this panel. textContent renders it as the name it is.
            // The remove button goes through data-action for the same reason the
            // rest of this page does — see the delegated handler below.
            const chip = document.createElement('span');
            chip.className = 'role-tag';
            chip.dataset.roleId = roleId;
            chip.appendChild(document.createTextNode('@' + roleName + ' '));
            const removeBtn = document.createElement('button');
            removeBtn.title = 'Remove';
            removeBtn.dataset.action = 'autorole-remove';
            removeBtn.dataset.roleId = roleId;
            removeBtn.textContent = '\u00d7';
            chip.appendChild(removeBtn);
            document.getElementById('autorole-list').appendChild(chip);
            select.value = '';
            toast('Role added', 'success');
        } else toast('Failed to add role', 'error');
    } catch (error) {
        console.error(error);
        toast('An error occurred', 'error');
    }
}

async function removeAutoRole(roleId) {
    const guildId = BOOT.guildId;
    // Every other destructive action on this page goes through showConfirm;
    // this one fired the DELETE straight off the click (#677). It is a
    // one-character × sitting against the role name, so the miss is easy and
    // the undo is not: re-adding the role restores the setting for people who
    // join later, but nobody who joined in between gets the role.
    //
    // Named, because the chips sit in a row and the × the reader hit is not
    // necessarily the one they meant. BOOT.roleNames is the server's list;
    // the chip's own text is the fallback for a role added since the page
    // loaded, and the id is the last resort for one deleted in Discord.
    const named = document.querySelector(`#autorole-list [data-role-id="${CSS.escape(roleId)}"]`);
    const roleName = BOOT.roleNames?.[roleId]
        || named?.textContent.replace(/[\s\u00d7]+$/, '').replace(/^@/, '')
        || roleId;
    const ok = await showConfirm({
        title: 'Remove auto-role',
        body: `Stop giving @${roleName} to new members? People who already have it keep it.`,
        okText: 'Remove role'
    });
    if (!ok) return;
    try {
        const response = await apiFetch(`/api/v1/guild/${guildId}/autorole/${roleId}`, { method: 'DELETE' });
        if (response.ok) {
            const chip = document.querySelector(`#autorole-list [data-role-id="${CSS.escape(roleId)}"]`);
            if (chip) chip.remove();
            toast('Role removed', 'success');
        } else toast('Failed to remove role', 'error');
    } catch (error) {
        console.error(error);
        toast('An error occurred', 'error');
    }
}
// ── Reaction Roles ─────────────────────────────────────────────────────────
var rrRoles = boot('roles');

function addRrMapping() {
    const list = document.getElementById('rr-mappings-list');
    const row = document.createElement('div');
    row.style.cssText = 'display:grid;grid-template-columns:1fr 2fr auto;gap:.5rem;align-items:center;';
    row.innerHTML =
        '<input type="text" placeholder="Emoji (e.g. 👍)" class="rr-emoji" style="font-size:1.1rem;" aria-label="Emoji">' +
        '<select class="rr-role" aria-label="Role to assign"><option value="">Select role</option>' +
        rrRoles.map(function(r) { return '<option value="' + escHtml(r.id) + '">@' + escHtml(r.name) + '</option>'; }).join('') +
        '</select>' +
        '<button class="btn btn-sm btn-danger" type="button" data-action="row-remove" data-row-remove="rr-mapping" aria-label="Remove this reaction role mapping">×</button>';
    list.appendChild(row);
    labelRepeatedRows(list);
}

// See _rssAddInFlight. This one matters more: a duplicate publish posts a second
// embed to the channel and stores a second set of mappings, so the cost of the
// double click is a panel an admin has to go and delete.
let _rrPublishInFlight = false;

async function publishRrPanel() {
    if (_rrPublishInFlight) return;
    const channelId = document.getElementById('rr-channel').value;
    if (!channelId) { toast('Select a target channel', 'error'); return; }

    const rows = document.querySelectorAll('#rr-mappings-list > div');
    const mappings = [];
    rows.forEach(function(row) {
        const emoji = row.querySelector('.rr-emoji').value.trim();
        const roleId = row.querySelector('.rr-role').value;
        if (emoji && roleId) mappings.push({ emoji: emoji, roleId: roleId });
    });

    if (!mappings.length) { toast('Add at least one emoji → role mapping', 'error'); return; }

    const guildId = BOOT.guildId;
    _rrPublishInFlight = true;
    try {
        const response = await apiFetch('/api/v1/guild/' + guildId + '/reactionrole/panel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                channelId: channelId,
                title: document.getElementById('rr-title').value.trim() || null,
                description: document.getElementById('rr-description').value.trim() || null,
                mappings: mappings
            })
        });
        const data = await response.json();
        if (response.ok) {
            renderRrPanels(data.panels || []);
            // The reload used to empty the create form. Publishing leaves the
            // admin looking at a form still holding the panel they have just
            // posted, which is one accidental second click from a duplicate.
            clearRrForm();
            toast('Panel published', 'success');
        } else {
            toast(data.error || 'Failed to publish panel', 'error');
        }
    } catch (error) {
        console.error(error);
        toast('An error occurred', 'error');
    } finally {
        _rrPublishInFlight = false;
    }
}

async function deleteRrPanel(messageId) {
    const ok = await showConfirm({ title: 'Delete reaction role panel', body: 'Delete this panel? The Discord message will also be permanently deleted and all reaction mappings will be removed.', okText: 'Delete panel' });
    if (!ok) return;
    const guildId = BOOT.guildId;
    try {
        const response = await apiFetch('/api/v1/guild/' + guildId + '/reactionrole/panel/' + encodeURIComponent(messageId), { method: 'DELETE' });
        const data = await response.json().catch(function() { return {}; });
        if (response.ok) {
            renderRrPanels(data.panels || []);
            toast('Panel deleted', 'success');
        } else {
            toast(data.error || 'Failed to delete panel', 'error');
        }
    } catch (error) {
        console.error(error);
        toast('An error occurred', 'error');
    }
}

// ── Reaction role panel list ───────────────────────────────────────────
// Publishing or deleting a panel used to answer with location.reload() (#689).
// The API returns the guild's panels grouped by message — the same shape
// partials/panels/reactionroles.ejs renders on load, produced by the same
// helper in src/dashboard/lib/reactionRolePanels.js — and this redraws
// #rr-panels-list from it.
//
// createElement and textContent throughout: a mapping's emoji is whatever the
// admin typed into the field, and a role or channel that has been renamed
// since the page loaded arrives as a name from the bootstrap map. Neither is
// concatenated into markup.

/** One `.store-card`, matching the markup in partials/panels/reactionroles.ejs. */
function rrPanelCard(panel) {
    const card = document.createElement('div');
    card.className = 'store-card';

    const body = document.createElement('div');
    body.className = 'store-card-body';

    const name = document.createElement('div');
    name.className = 'store-card-name';
    name.textContent = '#' + (BOOT.channelNames[panel.channelId] || panel.channelId);

    const mappings = document.createElement('div');
    mappings.className = 'rr-panel-mappings';
    (panel.mappings || []).forEach(function(m) {
        const tag = document.createElement('span');
        tag.className = 'store-meta-tag role-meta';
        tag.textContent = m.emoji + ' → @' + (BOOT.roleNames[m.roleId] || m.roleId);
        mappings.appendChild(tag);
    });

    const messageId = document.createElement('div');
    messageId.className = 'rr-panel-message-id';
    messageId.textContent = 'Message ID: ' + panel.messageId;

    body.appendChild(name);
    body.appendChild(mappings);
    body.appendChild(messageId);

    const actions = document.createElement('div');
    actions.className = 'store-card-actions';
    const remove = document.createElement('button');
    remove.className = 'btn btn-sm btn-danger';
    remove.dataset.action = 'rr-panel-delete';
    remove.dataset.messageId = panel.messageId;
    remove.textContent = 'Delete panel';
    actions.appendChild(remove);

    card.appendChild(body);
    card.appendChild(actions);
    return card;
}

function renderRrPanels(panels) {
    const list = document.getElementById('rr-panels-list');
    if (!list) return;

    list.textContent = '';

    if (!panels.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        const heading = document.createElement('h3');
        heading.textContent = 'No reaction role panels yet';
        const hint = document.createElement('p');
        hint.textContent = 'Create a panel below and the bot will post it to your chosen channel with reactions automatically added.';
        empty.appendChild(heading);
        empty.appendChild(hint);
        list.appendChild(empty);
        return;
    }

    panels.forEach(function(panel) { list.appendChild(rrPanelCard(panel)); });
}

/** Empties the create-panel form after a successful publish. */
function clearRrForm() {
    ['rr-channel', 'rr-title', 'rr-description'].forEach(function(id) {
        const field = document.getElementById(id);
        if (field) field.value = '';
    });
    const mappings = document.getElementById('rr-mappings-list');
    if (mappings) mappings.textContent = '';
}

registerPanelActions({
    click: {
        'add-auto-role':      () => addAutoRole(),
        'add-rr-mapping':     () => addRrMapping(),
        'publish-rr-panel':   () => publishRrPanel(),
        'autorole-remove':  (el, d) => removeAutoRole(d.roleId),
        'rr-panel-delete':  (el, d) => deleteRrPanel(d.messageId),
    },
});
