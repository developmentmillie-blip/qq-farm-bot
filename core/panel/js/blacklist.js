/**
 * 黑名单管理（植物黑名单 + 好友黑名单）+ 模糊搜索 autocomplete
 */

let plantBlacklist = [];
let friendBlacklist = { noSteal: [], noHelp: [] };

// 候选数据缓存
let _plantCandidates = []; // 所有可选植物名
let _friendCandidates = []; // 所有可选好友 [{name, gid}]

// ======= Autocomplete 通用组件 =======
/**
 * 为某个 input 元素绑定模糊搜索下拉
 * @param {string} inputId - input 的 id
 * @param {Function} getCandidates - 返回候选列表的函数 (query) => string[]
 * @param {Function} onSelect - 选中某项时的回调 (val) => void
 */
function bindAutocomplete(inputId, getCandidates, onSelect) {
    const input = $(inputId);
    if (!input) return;

    // 创建下拉容器
    let dropdown = document.getElementById(inputId + '-ac-dropdown');
    if (!dropdown) {
        dropdown = document.createElement('div');
        dropdown.id = inputId + '-ac-dropdown';
        dropdown.className = 'ac-dropdown';
        dropdown.style.display = 'none';
        input.parentNode.style.position = 'relative';
        input.parentNode.appendChild(dropdown);
    }

    let activeIdx = -1;

    function showDropdown(candidates) {
        if (!candidates.length) { dropdown.style.display = 'none'; return; }
        activeIdx = -1;
        dropdown.innerHTML = candidates.slice(0, 10).map((c, i) =>
            `<div class="ac-item" data-idx="${i}" data-val="${escapeHtml(typeof c === 'string' ? c : c.name)}">${escapeHtml(typeof c === 'string' ? c : c.name)}</div>`
        ).join('');
        dropdown.style.display = 'block';

        dropdown.querySelectorAll('.ac-item').forEach(item => {
            item.addEventListener('mousedown', e => {
                e.preventDefault();
                selectItem(item.dataset.val);
            });
        });
    }

    function hideDropdown() {
        dropdown.style.display = 'none';
        activeIdx = -1;
    }

    function selectItem(val) {
        input.value = val;
        hideDropdown();
        onSelect(val);
        input.value = '';
    }

    input.addEventListener('input', () => {
        const q = input.value.trim();
        if (!q) { hideDropdown(); return; }
        const all = getCandidates(q);
        const filtered = all.filter(c => {
            const name = typeof c === 'string' ? c : c.name;
            return name.toLowerCase().includes(q.toLowerCase());
        });
        showDropdown(filtered);
    });

    input.addEventListener('keydown', e => {
        const items = dropdown.querySelectorAll('.ac-item');
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            activeIdx = Math.min(activeIdx + 1, items.length - 1);
            items.forEach((el, i) => el.classList.toggle('active', i === activeIdx));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            activeIdx = Math.max(activeIdx - 1, 0);
            items.forEach((el, i) => el.classList.toggle('active', i === activeIdx));
        } else if (e.key === 'Enter') {
            if (activeIdx >= 0 && items[activeIdx]) {
                e.preventDefault();
                selectItem(items[activeIdx].dataset.val);
            } else {
                // 直接用输入值
                const val = input.value.trim();
                if (val) { onSelect(val); input.value = ''; hideDropdown(); }
            }
        } else if (e.key === 'Escape') {
            hideDropdown();
        }
    });

    input.addEventListener('blur', () => {
        setTimeout(hideDropdown, 150);
    });
}

// ======= 植物黑名单 =======
async function loadPlantBlacklist() {
    try {
        const data = await api('/api/plant-blacklist');
        plantBlacklist = Array.isArray(data) ? data : [];
        renderPlantBlacklist();
        // 异步加载植物候选列表
        _loadPlantCandidates();
    } catch (e) { console.error('加载植物黑名单失败', e); }
}

async function _loadPlantCandidates() {
    try {
        // 从游戏配置加载植物列表（Plant.json 格式）
        const resp = await fetch('/game-config/Plant.json').catch(() => null);
        if (resp && resp.ok) {
            const plants = await resp.json();
            if (Array.isArray(plants)) {
                _plantCandidates = plants.map(p => p.name || p.plantName || String(p.id || '')).filter(Boolean);
                return;
            }
        }
    } catch (e) { /* 静默失败，用户可手动输入 */ }
}

function renderPlantBlacklist() {
    const container = $('plant-blacklist-tags');
    if (!container) return;
    if (!plantBlacklist.length) {
        container.innerHTML = '<span style="color:var(--sub);font-size:13px">暂无黑名单植物</span>';
        return;
    }
    container.innerHTML = plantBlacklist.map((name, i) => `
        <span class="blacklist-tag">
            ${escapeHtml(name)}
            <button class="blacklist-tag-del" onclick="removePlantBlacklist(${i})" title="移除">×</button>
        </span>
    `).join('');
}

window.addPlantBlacklist = function(valOverride) {
    const input = $('plant-blacklist-input');
    const val = valOverride || (input && input.value.trim());
    if (!val) return;
    if (!plantBlacklist.includes(val)) {
        plantBlacklist.push(val);
        renderPlantBlacklist();
    }
    if (input) input.value = '';
};

window.removePlantBlacklist = function(index) {
    plantBlacklist.splice(index, 1);
    renderPlantBlacklist();
};

async function savePlantBlacklist() {
    try {
        await api('/api/plant-blacklist', 'POST', { plantIds: plantBlacklist });
        showToast('植物黑名单已保存');
    } catch (e) { alert('保存失败: ' + e.message); }
}

// ======= 好友黑名单 =======
async function loadFriendBlacklist() {
    try {
        const data = await api('/api/friend-blacklist');
        friendBlacklist = { noSteal: data.noSteal || [], noHelp: data.noHelp || [] };
        renderFriendBlacklist();
        // 异步加载好友候选列表
        _loadFriendCandidates();
    } catch (e) { console.error('加载好友黑名单失败', e); }
}

async function _loadFriendCandidates() {
    try {
        if (!currentAccountId) return;
        const list = await api('/api/friends');
        if (Array.isArray(list)) {
            _friendCandidates = list.map(f => ({
                name: f.name || f.gid || '',
                gid: f.gid || '',
            })).filter(f => f.name);
        }
    } catch (e) { /* 静默失败 */ }
}

function renderFriendBlacklist() {
    renderTagList('no-steal-list', friendBlacklist.noSteal, 'noSteal');
    renderTagList('no-help-list', friendBlacklist.noHelp, 'noHelp');
}

function renderTagList(containerId, list, type) {
    const container = $(containerId);
    if (!container) return;
    if (!list.length) {
        container.innerHTML = '<span style="color:var(--sub);font-size:13px">暂无</span>';
        return;
    }
    container.innerHTML = list.map((name, i) => `
        <span class="blacklist-tag">
            ${escapeHtml(name)}
            <button class="blacklist-tag-del" onclick="removeFriendBlacklist('${type}', ${i})" title="移除">×</button>
        </span>
    `).join('');
}

window.addNoSteal = function(valOverride) {
    const input = $('no-steal-input');
    const val = valOverride || (input && input.value.trim());
    if (!val) return;
    if (!friendBlacklist.noSteal.includes(val)) {
        friendBlacklist.noSteal.push(val);
        renderFriendBlacklist();
    }
    if (input) input.value = '';
};

window.addNoHelp = function(valOverride) {
    const input = $('no-help-input');
    const val = valOverride || (input && input.value.trim());
    if (!val) return;
    if (!friendBlacklist.noHelp.includes(val)) {
        friendBlacklist.noHelp.push(val);
        renderFriendBlacklist();
    }
    if (input) input.value = '';
};

window.removeFriendBlacklist = function(type, index) {
    if (friendBlacklist[type]) {
        friendBlacklist[type].splice(index, 1);
        renderFriendBlacklist();
    }
};

async function saveFriendBlacklist() {
    try {
        await api('/api/friend-blacklist', 'POST', friendBlacklist);
        showToast('好友黑名单已保存');
    } catch (e) { alert('保存失败: ' + e.message); }
}

// ======= 注册配置（管理员） =======
async function loadRegisterConfig() {
    const section = $('register-config-section');
    if (!section || !currentUser || currentUser.role !== 'admin') return;
    try {
        const data = await api('/api/register-config');
        const enabled = $('reg-enabled');
        const code = $('reg-invite-code-cfg');
        const maxUsers = $('reg-max-users');
        if (enabled) enabled.checked = !!data.enabled;
        if (code) code.value = data.inviteCode || '';
        if (maxUsers) maxUsers.value = data.maxUsers || 0;
    } catch (e) { console.error('加载注册配置失败', e); }
}

async function saveRegisterConfig() {
    try {
        const enabled = !!($('reg-enabled') && $('reg-enabled').checked);
        const inviteCode = ($('reg-invite-code-cfg') && $('reg-invite-code-cfg').value) || '';
        const maxUsers = parseInt(($('reg-max-users') && $('reg-max-users').value) || '0', 10) || 0;
        await api('/api/register-config', 'POST', { enabled, inviteCode, maxUsers });
        showToast('注册设置已保存');
    } catch (e) { alert('保存失败: ' + e.message); }
}

// ======= 初始化绑定 =======
document.addEventListener('DOMContentLoaded', () => {
    // 植物黑名单 autocomplete
    bindAutocomplete(
        'plant-blacklist-input',
        (q) => _plantCandidates.filter(n => n.toLowerCase().includes(q.toLowerCase())),
        (val) => { window.addPlantBlacklist(val); }
    );

    // 好友黑名单 autocomplete（不偷取）
    bindAutocomplete(
        'no-steal-input',
        (q) => _friendCandidates.filter(f => f.name.toLowerCase().includes(q.toLowerCase())),
        (val) => { window.addNoSteal(val); }
    );

    // 好友黑名单 autocomplete（不帮助）
    bindAutocomplete(
        'no-help-input',
        (q) => _friendCandidates.filter(f => f.name.toLowerCase().includes(q.toLowerCase())),
        (val) => { window.addNoHelp(val); }
    );

    const savePlantBtn = $('btn-save-plant-blacklist');
    if (savePlantBtn) savePlantBtn.addEventListener('click', savePlantBlacklist);
    const saveFriendBtn = $('btn-save-friend-blacklist');
    if (saveFriendBtn) saveFriendBtn.addEventListener('click', saveFriendBlacklist);
    const saveRegBtn = $('btn-save-reg-config');
    if (saveRegBtn) saveRegBtn.addEventListener('click', saveRegisterConfig);
});
