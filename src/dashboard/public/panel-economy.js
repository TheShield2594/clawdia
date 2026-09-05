
// The Economy panel (#935): the shop, the job board and its tiers, the
// activity-item images, and the Health tab.
//
// The one panel whose save is not finished when the POST returns: shop item
// images are multipart and the settings are JSON, so the images go up
// afterwards through the save follow-up registered below, and a failure there
// leaves the section marked unsaved.

// Activity images belong to this guild, not to every guild the bot is in (#561),
// so the guild id is part of the path. `_guildId` is assigned further down this
// file; both callers run on a click, long after the script has finished.
function activityImageUrl(itemId) {
    return '/api/v1/item-image/activity/' + encodeURIComponent(_guildId) + '/' + encodeURIComponent(itemId);
}

async function uploadActivityImage(itemId, input) {
    const file = input.files[0];
    if (!file) return;
    const emojiEl = document.getElementById('gic-emoji-' + itemId);
    let imgEl = document.getElementById('gic-img-' + itemId);
    const fd = new FormData();
    fd.append('image', file);
    try {
        const r = await apiFetch(activityImageUrl(itemId), { method: 'POST', body: fd });
        if (r.ok) {
            const dataUrl = await new Promise(function(res) {
                const reader = new FileReader();
                reader.onload = function(e) { res(e.target.result); };
                reader.readAsDataURL(file);
            });
            // Card was rendered without an <img>; create one and insert before the emoji
            if (!imgEl && emojiEl) {
                imgEl = document.createElement('img');
                imgEl.className = 'game-item-img';
                imgEl.id = 'gic-img-' + itemId;
                imgEl.alt = '';
                emojiEl.parentNode.insertBefore(imgEl, emojiEl);
            }
            if (imgEl) {
                imgEl.src = dataUrl;
                imgEl.style.display = 'block';
            }
            if (emojiEl) emojiEl.style.display = 'none';
            toast('Image uploaded', 'success');
        } else {
            const err = await r.json().catch(function(){ return {}; });
            toast(err.error || 'Upload failed', 'error');
        }
    } catch {
        toast('Upload error', 'error');
    }
    input.value = '';
}

async function removeActivityImage(itemId) {
    const ok = await showConfirm({ title: 'Remove image', body: 'Remove the image for this activity item?', okText: 'Remove' });
    if (!ok) return;
    try {
        const r = await apiFetch(activityImageUrl(itemId), { method: 'DELETE' });
        if (r.ok) {
            const imgEl = document.getElementById('gic-img-' + itemId);
            const emojiEl = document.getElementById('gic-emoji-' + itemId);
            if (imgEl) {
                imgEl.src = '';
                imgEl.style.display = 'none';
            }
            if (emojiEl) emojiEl.style.display = 'flex';
            toast('Image removed', 'success');
        } else {
            const err = await r.json().catch(function(){ return {}; });
            toast(err.error || 'Remove failed', 'error');
        }
    } catch {
        toast('Error removing image', 'error');
    }
}
var storeItems = boot('shop');
var _serverJobs = boot('jobs');
var jobsList = _serverJobs.length > 0 ? _serverJobs.slice() : boot('defaultJobs');

var _savedTiers = boot('jobTiers');
var jobTiersList = _savedTiers.length === 4
    ? _savedTiers.slice().sort(function(a,b){return a.tier-b.tier;})
    : boot('defaultTiers');

var _roleMap = boot('roleNames');
var editingItemIdx = -1;
var editingJobIdx = -1;

var _shopItemPendingImages = {}; // itemId -> { file, dataUrl }
var _shopItemClearedImages = new Set(); // itemIds whose images were explicitly removed
var _guildId = BOOT.guildId;

registerPayloadSources({
    storeItems:   () => storeItems,
    jobsList:     () => jobsList,
    jobTiersList: () => jobTiersList,
});

// Shop item images are uploaded after the settings POST rather than with it:
// they are multipart and the settings are JSON. Reported back as a message so
// the save that carried them is not marked clean.
registerSaveFollowUp('economy', async () => {
    const uploads = Object.entries(_shopItemPendingImages).map(([itemId, info]) => {
        const fd = new FormData();
        fd.append('image', info.file);
        return apiFetch(`/api/v1/item-image/shop/${_guildId}/${itemId}`, { method: 'POST', body: fd })
            .then(r => r.ok ? null : r.json().then(e => e.error || 'Upload failed'))
            .catch(() => 'Upload error');
    });
    const deletes = [..._shopItemClearedImages].map(itemId =>
        apiFetch(`/api/v1/item-image/shop/${_guildId}/${itemId}`, { method: 'DELETE' })
            .then(r => r.ok ? null : 'Delete failed')
            .catch(() => 'Delete error')
    );
    const errors = (await Promise.all([...uploads, ...deletes])).filter(Boolean);
    if (errors.length) return 'image update failed: ' + errors[0];

    Object.keys(_shopItemPendingImages).forEach(k => delete _shopItemPendingImages[k]);
    _shopItemClearedImages.clear();
    return null;
});

function renderStoreItems() {
    const grid = document.getElementById('store-items-grid');
    if (!storeItems.length) {
        grid.innerHTML = '<div class="empty-state"><h3>No store items yet</h3><p>Click <strong>+ Add item</strong> to create your first shop listing.</p></div>';
        return;
    }
    grid.innerHTML = storeItems.map(function(item, i) {
        const roleName = item.roleId ? (_roleMap[item.roleId] || item.roleId) : null;
        const stockText = (item.stock === -1 || item.stock == null) ? '∞ Unlimited' : item.stock + ' left';
        const imgSrc = (item.itemId && _shopItemPendingImages[item.itemId])
            ? _shopItemPendingImages[item.itemId].dataUrl
            : (item.itemId ? '/api/v1/item-image/shop/' + _guildId + '/' + escHtml(item.itemId) : '');
        const thumbHtml = imgSrc ? '<img class="store-card-thumb" src="' + imgSrc + '" alt="" data-hide-on-error>' : '';
        return '<div class="store-card">' +
            (thumbHtml ? '<div class="store-card-thumb-wrap">' + thumbHtml + '</div>' : '') +
            '<div class="store-card-body">' +
                '<div class="store-card-name">' + escHtml(item.name) + '</div>' +
                '<div class="store-card-desc">' + (item.description ? escHtml(item.description) : '<em style="color:var(--text-mute)">No description</em>') + '</div>' +
                '<div class="store-card-meta">' +
                    '<span class="store-meta-tag price-tag">💰 ' + Number(item.price).toLocaleString() + '</span>' +
                    '<span class="store-meta-tag">' + stockText + '</span>' +
                    (roleName ? '<span class="store-meta-tag role-meta">@' + escHtml(roleName) + '</span>' : '') +
                '</div>' +
            '</div>' +
            '<div class="store-card-actions">' +
                '<button class="btn btn-sm" data-action="item-edit" data-idx="' + i + '">Edit</button>' +
                '<button class="btn btn-sm btn-danger" data-action="item-delete" data-idx="' + i + '">Remove</button>' +
            '</div>' +
        '</div>';
    }).join('');
}

function _genItemId() {
    return 'item_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

function previewShopItemImage(input) {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
        const dataUrl = e.target.result;
        document.getElementById('shop-img-preview').src = dataUrl;
        document.getElementById('shop-img-preview').style.display = 'block';
        document.getElementById('shop-img-placeholder').style.display = 'none';
        document.getElementById('shop-img-clear-btn').style.display = 'inline-flex';
        input._pendingFile = file;
        input._pendingDataUrl = dataUrl;
    };
    reader.readAsDataURL(file);
}

function clearShopItemImage() {
    document.getElementById('shop-img-preview').src = '';
    document.getElementById('shop-img-preview').style.display = 'none';
    document.getElementById('shop-img-placeholder').style.display = 'block';
    document.getElementById('shop-img-clear-btn').style.display = 'none';
    const fileInput = document.getElementById('modal-item-image-file');
    fileInput._pendingFile = null;
    fileInput._pendingDataUrl = null;
    fileInput.value = '';
    fileInput._clearExisting = true;
}

function openItemModal(idx) {
    editingItemIdx = idx;
    document.getElementById('item-modal-title').textContent = idx === -1 ? 'Add Store Item' : 'Edit Store Item';
    const item = idx === -1 ? {} : storeItems[idx];
    document.getElementById('modal-item-name').value = item.name || '';
    document.getElementById('modal-item-desc').value = item.description || '';
    document.getElementById('modal-item-price').value = item.price != null ? item.price : '';
    document.getElementById('modal-item-role').value = item.roleId || '';
    const isUnlimited = (item.stock == null || item.stock === -1);
    document.getElementById('modal-item-unlimited').checked = isUnlimited;
    document.getElementById('modal-item-stock').style.display = isUnlimited ? 'none' : '';
    document.getElementById('modal-item-stock').value = isUnlimited ? '' : item.stock;

    // Reset image preview
    const fileInput = document.getElementById('modal-item-image-file');
    fileInput.value = '';
    fileInput._pendingFile = null;
    fileInput._pendingDataUrl = null;
    fileInput._clearExisting = false;
    const preview = document.getElementById('shop-img-preview');
    const placeholder = document.getElementById('shop-img-placeholder');
    const clearBtn = document.getElementById('shop-img-clear-btn');
    const pending = item.itemId && _shopItemPendingImages[item.itemId];
    if (pending) {
        preview.src = pending.dataUrl;
        preview.style.display = 'block';
        placeholder.style.display = 'none';
        clearBtn.style.display = 'inline-flex';
    } else if (item.itemId) {
        const imgSrc = '/api/v1/item-image/shop/' + _guildId + '/' + item.itemId;
        preview.src = imgSrc;
        preview.style.display = 'block';
        placeholder.style.display = 'none';
        clearBtn.style.display = 'inline-flex';
        preview.onerror = function() {
            preview.style.display = 'none';
            placeholder.style.display = 'block';
            clearBtn.style.display = 'none';
        };
    } else {
        preview.style.display = 'none';
        placeholder.style.display = 'block';
        clearBtn.style.display = 'none';
    }
    openModal('item-modal', { initialFocus: 'modal-item-name' });
}

function closeItemModal() { closeModal('item-modal'); }
function toggleStockInput(cb) {
    document.getElementById('modal-item-stock').style.display = cb.checked ? 'none' : '';
}

function saveItemModal() {
    const name = document.getElementById('modal-item-name').value.trim();
    const price = parseInt(document.getElementById('modal-item-price').value, 10);
    if (!name) { toast('Item name is required', 'error'); return; }
    if (!Number.isFinite(price) || price < 0) { toast('Enter a valid price', 'error'); return; }
    const isUnlimited = document.getElementById('modal-item-unlimited').checked;
    const parsedStock = isUnlimited ? -1 : parseInt(document.getElementById('modal-item-stock').value, 10);
    if (!isUnlimited && (!Number.isFinite(parsedStock) || parsedStock < 1)) { toast('Enter a valid stock quantity', 'error'); return; }
    const fileInput = document.getElementById('modal-item-image-file');

    const existingItem = editingItemIdx === -1 ? null : storeItems[editingItemIdx];
    const itemId = (existingItem && existingItem.itemId) ? existingItem.itemId : _genItemId();

    const item = {
        name: name,
        itemId: itemId,
        description: document.getElementById('modal-item-desc').value.trim(),
        price: price,
        roleId: document.getElementById('modal-item-role').value || null,
        stock: Number.isNaN(parsedStock) ? -1 : parsedStock
    };

    if (fileInput._pendingFile) {
        _shopItemPendingImages[itemId] = { file: fileInput._pendingFile, dataUrl: fileInput._pendingDataUrl };
        _shopItemClearedImages.delete(itemId);
    } else if (fileInput._clearExisting) {
        delete _shopItemPendingImages[itemId];
        if (existingItem && existingItem.itemId) _shopItemClearedImages.add(itemId);
    }

    if (editingItemIdx === -1) storeItems.push(item);
    else storeItems[editingItemIdx] = item;
    closeItemModal();
    renderStoreItems();
}

async function deleteItem(idx) {
    const ok = await showConfirm({ title: 'Delete store item', body: 'Remove "' + storeItems[idx].name + '" from the store? This cannot be undone.', okText: 'Delete' });
    if (!ok) return;
    storeItems.splice(idx, 1);
    renderStoreItems();
}

var JOB_TIER_COLORS = ['#2ecc71','#3498db','#9b59b6','#f39c12'];
var JOB_TIER_BADGES = ['🟢','🔵','🟣','🟡'];

function renderJobTiers() {
    const grid = document.getElementById('job-tiers-grid');
    grid.innerHTML = jobTiersList.map(function(t, i) {
        const color = JOB_TIER_COLORS[i] || '#888';
        const badge = JOB_TIER_BADGES[i] || '⚪';
        const isFirst = t.minShifts === 0;
        return '<div class="job-tier-row" style="border-left:3px solid ' + color + '">' +
            '<span class="job-tier-row-badge">' + badge + ' Tier ' + t.tier + '</span>' +
            '<input class="job-tier-name-input" data-tier-idx="' + i + '" data-field="name" value="' + escHtml(t.name) + '" placeholder="Tier name">' +
            '<div class="job-tier-row-shifts">' +
                '<input type="number" class="job-tier-shifts-input" data-tier-idx="' + i + '" data-field="minShifts" value="' + t.minShifts + '" min="0"' + (isFirst ? ' disabled title="Tier 1 always starts at 0 shifts"' : '') + '>' +
                '<span class="job-tier-shifts-label">shifts to unlock</span>' +
            '</div>' +
        '</div>';
    }).join('');
}

function updateTierField(el) {
    const idx = parseInt(el.dataset.tierIdx, 10);
    const field = el.dataset.field;
    jobTiersList[idx][field] = field === 'minShifts' ? (parseInt(el.value, 10) || 0) : el.value;
}

function renderJobs() {
    const list = document.getElementById('jobs-list');
    if (!jobsList.length) {
        list.innerHTML = '<p style="color:var(--text-dim);font-size:.88rem;padding:.5rem 0">No jobs — click <strong>+ Add job</strong> to add one.</p>';
        return;
    }

    // Sort by tier then name
    const sorted = jobsList.map(function(j, i) { return { job: j, idx: i }; });
    sorted.sort(function(a, b) {
        const ta = a.job.tier || 1, tb = b.job.tier || 1;
        return ta !== tb ? ta - tb : a.job.name.localeCompare(b.job.name);
    });

    // Build tier name lookup from live jobTiersList so names stay in sync
    const tierNameMap = {};
    jobTiersList.forEach(function(t) { tierNameMap[t.tier] = t.name; });

    // Group into tiers
    let html = '';
    let lastTier = null;
    sorted.forEach(function(entry) {
        const job = entry.job, i = entry.idx;
        const tier = job.tier || 1;
        const color = JOB_TIER_COLORS[tier - 1] || '#888';
        const badge = JOB_TIER_BADGES[tier - 1] || '⚪';
        const tierName = tierNameMap[tier] || ('Tier ' + tier);
        if (tier !== lastTier) {
            if (lastTier !== null) html += '</div>';
            html += '<div class="job-tier-group">' +
                '<div class="job-tier-header" style="border-left:3px solid ' + color + '">' +
                    badge + ' <strong>Tier ' + tier + ' · ' + escHtml(tierName) + '</strong>' +
                '</div>';
            lastTier = tier;
        }
        const minPay = job.minPay != null ? job.minPay : '?';
        const maxPay = job.maxPay != null ? job.maxPay : '?';
        html += '<div class="job-chip">' +
            (job.emoji ? '<span class="job-chip-emoji">' + escHtml(job.emoji) + '</span>' : '') +
            '<span class="job-name">' + escHtml(job.name) + '</span>' +
            '<span class="job-pay-badge">💰 ' + minPay + '–' + maxPay + '</span>' +
            '<button class="job-btn" data-action="job-edit" data-idx="' + i + '" title="Edit" aria-label="Edit the ' + escHtml(job.name) + ' job">✏️</button>' +
            '<button class="job-btn" data-action="job-delete" data-idx="' + i + '" title="Remove" style="font-size:1rem" aria-label="Remove the ' + escHtml(job.name) + ' job">×</button>' +
        '</div>';
    });
    if (lastTier !== null) html += '</div>';
    list.innerHTML = html;
}

// The tier select cannot be static markup. The Careers tab lets an admin rename
// every tier and change how many shifts unlock it, so shipping "Tier 2 — Skilled
// Worker (10 shifts)" in the view meant the job modal contradicted the
// configuration the same page had just saved (#911). Built here instead, from
// the same jobTiersList the Careers tab edits — so an unsaved rename shows up
// too, rather than only after a round trip.
function renderJobTierOptions(selectedTier) {
    const select = document.getElementById('modal-job-tier');
    select.innerHTML = jobTiersList.map(function(t) {
        const shifts = t.minShifts || 0;
        const name = t.name || ('Tier ' + t.tier);
        return '<option value="' + escHtml(String(t.tier)) + '">' +
            escHtml('Tier ' + t.tier + ' — ' + name + ' (' + shifts + ' shift' + (shifts === 1 ? '' : 's') + ')') +
            '</option>';
    }).join('');

    select.value = String(selectedTier);
    // Assigning a value no option carries leaves the select on '', which would
    // then save as tier 1 without the admin ever seeing which tier was picked.
    if (!select.value && jobTiersList.length) select.value = String(jobTiersList[0].tier);
}

function openJobModal(idx) {
    editingJobIdx = idx;
    document.getElementById('job-modal-title').textContent = idx === -1 ? 'Add Job' : 'Edit Job';
    const job = idx === -1 ? {} : jobsList[idx];
    document.getElementById('modal-job-name').value = job.name || '';
    document.getElementById('modal-job-emoji').value = job.emoji || '';
    renderJobTierOptions(job.tier || 1);
    document.getElementById('modal-job-min-pay').value = job.minPay != null ? job.minPay : '';
    document.getElementById('modal-job-max-pay').value = job.maxPay != null ? job.maxPay : '';
    openModal('job-modal', { initialFocus: 'modal-job-name' });
}

function closeJobModal() { closeModal('job-modal'); }

function saveJobModal() {
    const name = document.getElementById('modal-job-name').value.trim();
    if (!name) { toast('Job name is required', 'error'); return; }
    const minPay = parseInt(document.getElementById('modal-job-min-pay').value, 10);
    const maxPay = parseInt(document.getElementById('modal-job-max-pay').value, 10);
    if (!Number.isFinite(minPay) || minPay < 0) { toast('Enter a valid min pay', 'error'); return; }
    if (!Number.isFinite(maxPay) || maxPay < minPay) { toast('Max pay must be ≥ min pay', 'error'); return; }
    const job = {
        name: name,
        emoji: document.getElementById('modal-job-emoji').value.trim(),
        tier: parseInt(document.getElementById('modal-job-tier').value, 10) || 1,
        minPay: minPay,
        maxPay: maxPay
    };
    if (editingJobIdx === -1) jobsList.push(job);
    else jobsList[editingJobIdx] = job;
    closeJobModal();
    renderJobs();
}

function deleteJob(idx) {
    jobsList.splice(idx, 1);
    renderJobs();
}

onPanel('economy', function() {
    renderStoreItems();
    renderJobTiers();
    renderJobs();
});
document.addEventListener('input', function(e) {
    const el = e.target.closest && e.target.closest('[data-tier-idx][data-field]');
    if (el) updateTierField(el);
});
// ── Economy Health ────────────────────────────────────────────────────
let _ecoCmdChart = null;

async function loadEcoHealth() {
    const guildId = BOOT.guildId;
    document.getElementById('eco-top-earners-loading').style.display = '';
    document.getElementById('eco-top-earners-error').style.display = 'none';
    document.getElementById('eco-top-earners-empty').style.display = 'none';
    setTableVisible('eco-top-earners-table', false);
    try {
        const resp = await apiFetch(`/api/v1/guild/${guildId}/economy/stats`);
        if (!resp.ok) throw new Error('Non-OK');
        const stats = await resp.json();
        document.getElementById('eco-stat-total-coins').textContent = (stats.totalCoins || 0).toLocaleString();
        document.getElementById('eco-stat-active-users').textContent = (stats.activeUsers || 0).toLocaleString();
        document.getElementById('eco-top-earners-loading').style.display = 'none';
        const topEarners = stats.topEarners || [];
        if (!topEarners.length) {
            document.getElementById('eco-top-earners-empty').style.display = '';
        } else {
            setTableVisible('eco-top-earners-table', true);
        }
        const tbody = document.getElementById('eco-top-earners-tbody');
        tbody.innerHTML = '';
        for (let i = 0; i < topEarners.length; i++) {
            const u = topEarners[i];
            const userCell = u.userTag
                ? `<span title="${escHtml(u.userId)}">${u.avatarUrl ? `<img src="${escHtml(u.avatarUrl)}" alt="" style="width:16px;height:16px;border-radius:50%;margin-right:4px;vertical-align:middle" data-hide-on-error>` : ''}${escHtml(u.userTag)}</span>`
                : `<span style="font-size:.8em">${escHtml(u.userId)}</span>`;
            tbody.insertAdjacentHTML('beforeend', `<tr><td>#${i+1}</td><td>${userCell}</td><td>${(u.balance||0).toLocaleString()}</td><td>${(u.bank||0).toLocaleString()}</td><td>${(u.total||0).toLocaleString()}</td></tr>`);
        }
        // Command frequency chart
        const cmds = stats.commandFrequency || [];
        if (_ecoCmdChart) _ecoCmdChart.destroy();
        const ctx = document.getElementById('eco-cmd-chart')?.getContext('2d');
        describeChart('eco-cmd-chart', {
            title:   'Most-used economy commands',
            summary: cmds.length
                ? `Most-used economy commands: ${cmds.map(c => `/${c.cmd}, ${c.count} uses`).join('; ')}.`
                : 'Most-used economy commands — no data yet',
            columns: ['Command', 'Uses'],
            rows:    cmds.map(c => [`/${c.cmd}`, c.count || 0]),
        });
        if (ctx && cmds.length) {
            // Its own try, inside the tab's: Chart.js is fetched on demand now
            // (#685), and a library that would not load must not take down the
            // totals and the top-earners table that already rendered above.
            try {
                await loadChartJs();
                _ecoCmdChart = new Chart(ctx, {
                    type: 'bar',
                    data: {
                        labels: cmds.map(c => `/${c.cmd}`),
                        datasets: [{ label: 'Uses', data: cmds.map(c => c.count), backgroundColor: 'rgba(217,119,66,0.75)', borderRadius: 4 }]
                    },
                    options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#b8a898' } }, y: { ticks: { color: '#b8a898' } } } }
                });
            } catch (err) {
                chartsUnavailable(err);
            }
        }
    } catch {
        document.getElementById('eco-top-earners-loading').style.display = 'none';
        document.getElementById('eco-top-earners-error').style.display = '';
    }
}

let _ecoActionInFlight = false;
async function ecoAdminAction(action) {
    if (_ecoActionInFlight) return;
    const guildId = BOOT.guildId;
    const userId = document.getElementById('eco-admin-user-id').value.trim();
    const amount = parseInt(document.getElementById('eco-admin-amount').value, 10);
    const msgEl = document.getElementById('eco-admin-msg');
    if (!userId) { msgEl.textContent = 'Enter a user ID.'; msgEl.style.color = 'var(--red)'; return; }
    if (['give', 'take'].includes(action) && (!amount || amount <= 0)) { msgEl.textContent = 'Enter a valid amount > 0.'; msgEl.style.color = 'var(--red)'; return; }
    if (action === 'reset') {
        const ok = await showConfirm({ title: 'Reset balance', body: `This will permanently wipe the wallet and bank balance for user ${userId}. This cannot be undone.`, okText: 'Reset balance', typeRequired: 'RESET' });
        if (!ok) return;
    }

    _ecoActionInFlight = true;
    const controls = ['eco-admin-user-id', 'eco-admin-amount'];
    controls.forEach(id => { const el = document.getElementById(id); if (el) el.disabled = true; });
    document.querySelectorAll('#eco-tab-health .btn').forEach(b => b.disabled = true);
    msgEl.textContent = '';

    try {
        const body = { userId, action };
        if (['give', 'take'].includes(action)) body.amount = amount;
        const resp = await apiFetch(`/api/v1/guild/${guildId}/economy/adjust`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await resp.json();
        if (!resp.ok) { msgEl.textContent = data.error || 'Failed'; msgEl.style.color = 'var(--red)'; }
        else {
            msgEl.style.color = 'var(--green)';
            if (action === 'freeze') msgEl.textContent = 'Account frozen.';
            else if (action === 'unfreeze') msgEl.textContent = 'Account unfrozen.';
            else if (action === 'reset') msgEl.textContent = 'Balance reset. Wallet: 0, Bank: 0.';
            else msgEl.textContent = `Done. New wallet balance: ${(data.balance||0).toLocaleString()}`;
            loadEcoHealth();
        }
    } catch {
        msgEl.textContent = 'Request failed';
        msgEl.style.color = 'var(--red)';
    } finally {
        _ecoActionInFlight = false;
        controls.forEach(id => { const el = document.getElementById(id); if (el) el.disabled = false; });
        document.querySelectorAll('#eco-tab-health .btn').forEach(b => b.disabled = false);
    }
}

// Clicking the backdrop closes the dialog it belongs to. Registered here rather
// than in the shared dialog machinery because these are this panel's dialogs.
document.addEventListener('click', function(e) {
    if (e.target.id === 'item-modal') closeItemModal();
    if (e.target.id === 'job-modal') closeJobModal();
});

registerPanelActions({
    click: {
        'clear-shop-item-image': () => clearShopItemImage(),
        'close-item-modal':      () => closeItemModal(),
        'save-item-modal':       () => saveItemModal(),
        'close-job-modal':       () => closeJobModal(),
        'save-job-modal':        () => saveJobModal(),
        'load-eco-health':       () => loadEcoHealth(),
        'item-edit':        (el, d) => openItemModal(Number(d.idx)),
        'item-delete':      (el, d) => deleteItem(Number(d.idx)),
        'job-edit':         (el, d) => openJobModal(Number(d.idx)),
        'job-delete':       (el, d) => deleteJob(Number(d.idx)),
        'eco-admin':        (el, d) => ecoAdminAction(d.ecoAction),
        'activity-image-remove': (el, d) => removeActivityImage(d.itemId),
    },
    change: {
        'shop-item-image': el => previewShopItemImage(el),
        'stock-toggle':    el => toggleStockInput(el),
        'activity-image-upload': (el, d) => uploadActivityImage(d.itemId, el),
    },
});

onShown('eco-tab-health', () => loadEcoHealth());

// The one setting on this page that lives nowhere in the DOM: a shop item's
// chosen image waits here until the save follow-up above uploads it, so the
// shell's dirty check cannot see it by reading the panel's controls. Both id
// sets are emptied only by a save that succeeded, so any entry at all means
// unsaved work.
registerScopeSignature('#store-items-grid', () => [
    ...Object.keys(_shopItemPendingImages).sort().map(id => 'img+' + id),
    ...[..._shopItemClearedImages].sort().map(id => 'img-' + id),
]);
