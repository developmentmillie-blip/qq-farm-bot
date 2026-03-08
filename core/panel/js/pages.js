
function renderLandCropImage(land) {
    if (!land || !land.seedImage || !land.plantName) return '';
    const alt = String(land.plantName).replace(/"/g, '&quot;');
    return `<img class="land-crop-image" src="${land.seedImage}" alt="${alt}" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none'">`;
}

let matureCountdownTimer = null;
function ensureMatureCountdownTimer() {
    if (matureCountdownTimer) return;
    matureCountdownTimer = setInterval(() => {
        document.querySelectorAll('.mature-countdown').forEach((el) => {
            const cur = Number(el.dataset.remain || 0);
            if (!Number.isFinite(cur) || cur <= 0) return;
            const next = Math.max(0, cur - 1);
            el.dataset.remain = String(next);
            el.textContent = next > 0 ? `${fmtRemainSec(next)}后成熟` : '即将成熟';
        });
    }, 1000);
}

function renderLandPhaseText(landLevel, land) {
    if (landLevel <= 0) return '未解锁';
    const remain = Number((land && land.matureInSec) || 0);
    if (remain > 0) {
        return `<span class="mature-countdown" data-remain="${remain}">${fmtRemainSec(remain)}后成熟</span>`;
    }
    return '';
}

// 农场加载
async function loadFarm() {
    if (!currentAccountId) {
        clearFarmView('暂无账号，请先添加或选择账号');
        return;
    }
    const data = await api('/api/lands');
    const grid = $('farm-grid');
    const sum = $('farm-summary');

    if (!data || !data.lands) {
        grid.innerHTML = '<div style="padding:20px;text-align:center;color:#666">无法获取数据，请确保账号已登录</div>';
        sum.textContent = '';
        return;
    }

    const statusClass = { locked: 'locked', empty: 'empty', harvestable: 'harvestable', growing: 'growing', dead: 'dead', stealable: 'stealable', harvested: 'empty' };
    grid.innerHTML = data.lands.map(l => {
        let cls = statusClass[l.status] || 'empty';
        if (l.status === 'stealable') cls = 'harvestable'; // 复用样式
        const landLevel = Number(l.level || 0);
        const landLevelClass = `land-level-${Math.max(0, Math.min(4, landLevel))}`;
        const phaseText = renderLandPhaseText(landLevel, l);

        let needs = [];
        if (l.needWater) needs.push('<i class="fas fa-tint" style="color:#4ab1ff" title="需要浇水"></i>');
        if (l.needWeed) needs.push('<i class="fas fa-leaf" style="color:#56d4a0" title="需要除草"></i>');
        if (l.needBug) needs.push('<i class="fas fa-bug" style="color:#f0b84f" title="需要除虫"></i>');

        const statusIconMap = {
            harvestable: '<i class="fas fa-check-circle" style="color:#f3be4f;font-size:10px;vertical-align:middle"></i> ',
            stealable: '<i class="fas fa-check-circle" style="color:#f3be4f;font-size:10px;vertical-align:middle"></i> ',
            dead: '<i class="fas fa-times-circle" style="color:#f06f68;font-size:10px;vertical-align:middle"></i> ',
            growing: '',
            empty: '',
            locked: '<i class="fas fa-lock" style="font-size:10px;vertical-align:middle;opacity:.6"></i> ',
        };
        const statusIcon = statusIconMap[l.status] || '';

        return `
            <div class="land-cell ${cls} ${landLevelClass}">
                <span class="id">#${l.id}</span>
                ${(l.status !== 'locked') ? `<div class="land-quick-btns">
                    <button class="land-quick-btn" title="施无机肥" onclick="event.stopPropagation();doSingleLandOp('fert_normal',${l.id})" ${(l.status !== 'empty' && l.status !== 'dead') ? '' : 'disabled'}>🌱</button>
                    <button class="land-quick-btn" title="施有机肥" onclick="event.stopPropagation();doSingleLandOp('fert_organic',${l.id})" ${(l.status !== 'empty' && l.status !== 'dead') ? '' : 'disabled'}>🍃</button>
                    <button class="land-quick-btn" title="种植" onclick="event.stopPropagation();openPlantModal(${l.id})" ${(l.status === 'empty' || l.status === 'dead') ? '' : 'disabled'}>🌿</button>
                </div>` : ''}
                ${renderLandCropImage(l)}
                <span class="plant-name">${statusIcon}${escapeHtml(l.plantName || (landLevel <= 0 ? '未解锁' : '-'))}</span>
                <span class="phase-name">${phaseText}</span>
                ${needs.length ? `<span class="needs">${needs.join('')}</span>` : ''}
            </div>`;
    }).join('');
    ensureMatureCountdownTimer();

    const s = data.summary || {};
    sum.textContent = `可收:${s.harvestable || 0} 长:${s.growing || 0} 空:${s.empty || 0} 枯:${s.dead || 0}`;
}

// 特别关心切换
async function toggleSpecialCare(e, gid) {
    e.stopPropagation();
    const _sr = await fetch('/api/steal-stats', { headers: { 'x-account-id': currentAccountId, 'x-admin-token': adminToken || '' } }).then(r=>r.json()).catch(()=>null);
    const current = (_sr && _sr.specialCare) ? _sr.specialCare.map(String) : [];
    const gidStr = String(gid);
    const next = current.includes(gidStr) ? current.filter(x => x !== gidStr) : [...current, gidStr];
    await fetch('/api/special-care', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-account-id': currentAccountId, 'x-admin-token': adminToken || '' }, body: JSON.stringify({ gids: next }) }).catch(() => null);
    await loadFriends();
}

// 好友列表加载
async function loadFriends() {
    if (!currentAccountId) {
        clearFriendsView('暂无账号，请先添加或选择账号');
        return;
    }
    const [list, stealRes] = await Promise.all([
        api('/api/friends'),
        fetch('/api/steal-stats', { headers: { 'x-account-id': currentAccountId, 'x-admin-token': adminToken || '' } }).then(r=>r.json()).catch(()=>null),
    ]);
    const stealStatsMap = (stealRes && stealRes.stats) ? stealRes.stats : {};
    const specialCareSet = new Set((stealRes && stealRes.specialCare) ? stealRes.specialCare.map(String) : []);

    // 排序
    const sortBy = (document.getElementById('friend-sort-select') || {}).value || 'default';
    const wrap = $('friends-list');
    const summary = $('friend-summary');

    if (!list || !list.length) {
        if (summary) summary.textContent = '共 0 名好友';
        wrap.innerHTML = '<div style="padding:20px;text-align:center;color:#666">暂无好友或数据加载失败</div>';
        return;
    }

    if (summary) summary.textContent = `共 ${list.length} 名好友`;

    // 应用排序
    function applyFriendSort(arr) {
        const baseSort = (a, b) => {
            const as = stealStatsMap[String(a.gid)] || {};
            const bs = stealStatsMap[String(b.gid)] || {};
            const ac = specialCareSet.has(String(a.gid)) ? 1 : 0;
            const bc = specialCareSet.has(String(b.gid)) ? 1 : 0;
            if (bc !== ac) return bc - ac; // 特别关心置顶
            if (sortBy === 'i_stole_count') return (bs.iStole||0) - (as.iStole||0);
            if (sortBy === 'they_stole_count') return (bs.theyStole||0) - (as.theyStole||0);
            if (sortBy === 'i_stole_gold') return (bs.iStoleGold||0) - (as.iStoleGold||0);
            if (sortBy === 'they_stole_gold') return (bs.theyStoleGold||0) - (as.theyStoleGold||0);
            return 0;
        };
        return [...arr].sort(baseSort);
    }
    const sortedList = applyFriendSort(list || []);

    wrap.innerHTML = sortedList.map(f => {
        const p = f.plant || {};
        const info = [];
        if (p.stealNum) info.push(`偷${p.stealNum}`);
        if (p.dryNum) info.push(`水${p.dryNum}`);
        if (p.weedNum) info.push(`草${p.weedNum}`);
        if (p.insectNum) info.push(`虫${p.insectNum}`);
        const preview = info.length ? info.join(' ') : '无操作';

        // 头像：直接用后端返回的 avatarUrl（已包含 QQ 头像拼接逻辑）
        const avatarUrl = f.avatarUrl || '';
        const firstChar = (f.name || '?').trim().charAt(0).toUpperCase();
        const avatarHtml = avatarUrl
            ? `<img class="friend-avatar" src="${avatarUrl}" alt="${escapeHtml(f.name || '')}" referrerpolicy="no-referrer" onerror="this.style.display='none';this.nextElementSibling.style.display='inline-flex'">`
            : '';
        const avatarFallbackStyle = avatarUrl ? 'style="display:none"' : '';
        const avatarFallback = `<span class="friend-avatar-fallback" ${avatarFallbackStyle}>${escapeHtml(firstChar)}</span>`;

        // 等级 & 金币
        const levelNum = Number(f.level || f.farmLevel || 0);
        const goldNum = Number(f.gold || f.coin || 0);
        const metaTags = [];
        if (levelNum > 0) metaTags.push(`<span class="meta-tag level"><i class="fas fa-star"></i>Lv${levelNum}</span>`);
        if (goldNum > 0) metaTags.push(`<span class="meta-tag gold"><i class="fas fa-coins"></i>${goldNum >= 10000 ? (goldNum / 10000).toFixed(1) + 'w' : goldNum}</span>`);
        const metaHtml = metaTags.length ? `<div class="friend-meta">${metaTags.join('')}</div>` : '';

        return `
            <div class="friend-item">
                <div class="friend-header" onclick="toggleFriend('${f.gid}')">
                    <div class="friend-header-inner">
                        ${avatarHtml}${avatarFallback}
                        <div class="friend-info">
                            <span class="name">${escapeHtml(f.name || f.gid || '未知好友')}</span>
                            ${metaHtml}
                        </div>
                    </div>
                    <span class="preview ${info.length ? 'has-work' : ''}">${preview}</span>
                </div>
                <div class="steal-stat-row">
                    ${(() => { const st = stealStatsMap[String(f.gid)] || {}; const parts = []; if(st.iStole||st.iStoleGold) parts.push('<span class="stat-tag steal-out">我偷他 '+(st.iStole||0)+'次'+(st.iStoleGold?' / '+(st.iStoleGold>=10000?(st.iStoleGold/10000).toFixed(1)+'w':st.iStoleGold)+'金':'')+'</span>'); if(st.theyStole) parts.push('<span class="stat-tag steal-in">他偷我 '+(st.theyStole||0)+'次</span>'); return parts.join('') || ''; })()}
                    <button class="btn btn-xs care-btn ${specialCareSet.has(String(f.gid))?'care-active':''}" onclick="toggleSpecialCare(event,'${f.gid}')">★</button>
                </div>
                <div class="friend-actions">
                    <button class="btn btn-sm" onclick="friendQuickOp(event, '${f.gid}', 'steal')">一键偷取</button>
                    <button class="btn btn-sm" onclick="friendQuickOp(event, '${f.gid}', 'water')">一键浇水</button>
                    <button class="btn btn-sm" onclick="friendQuickOp(event, '${f.gid}', 'weed')">一键除草</button>
                    <button class="btn btn-sm" onclick="friendQuickOp(event, '${f.gid}', 'bug')">一键除虫</button>
                    <button class="btn btn-sm" onclick="friendQuickOp(event, '${f.gid}', 'bad')">一键捣乱</button>
                </div>
                <div id="friend-lands-${f.gid}" class="friend-lands" style="display:none">
                    <div style="padding:10px;text-align:center;color:#888"><i class="fas fa-spinner fa-spin"></i> 加载中...</div>
                </div>
            </div>
        `;
    }).join('');
}

window.toggleFriend = async (gid) => {
    const el = document.getElementById(`friend-lands-${gid}`);
    if (el.style.display === 'block') {
        el.style.display = 'none';
        return;
    }

    // 收起其他
    document.querySelectorAll('.friend-lands').forEach(e => e.style.display = 'none');

    el.style.display = 'block';

    const data = await api(`/api/friend/${gid}/lands`);
    if (!data || !data.lands) {
        el.innerHTML = '<div style="padding:10px;text-align:center;color:#F44336">加载失败</div>';
        return;
    }

    const statusClass = { empty: 'empty', locked: 'empty', stealable: 'harvestable', harvested: 'empty', dead: 'dead', growing: 'growing' };
    el.innerHTML = `
        <div class="farm-grid mini">
            ${data.lands.map(l => {
        let cls = statusClass[l.status] || 'empty';
        const landLevel = Number(l.level || 0);
        const landLevelClass = `land-level-${Math.max(0, Math.min(4, landLevel))}`;
        const phaseText = renderLandPhaseText(landLevel, l);
        let needs = [];
        if (l.needWater) needs.push('<i class="fas fa-tint" style="color:#4ab1ff" title="需要浇水"></i>');
        if (l.needWeed) needs.push('<i class="fas fa-leaf" style="color:#56d4a0" title="需要除草"></i>');
        if (l.needBug) needs.push('<i class="fas fa-bug" style="color:#f0b84f" title="需要除虫"></i>');
        return `
                    <div class="land-cell ${cls} ${landLevelClass}">
                        <span class="id">#${l.id}</span>
                        ${renderLandCropImage(l)}
                        <span class="plant-name">${escapeHtml(l.plantName || '-')}</span>
                        <span class="phase-name">${phaseText}</span>
                         ${needs.length ? `<span class="needs">${needs.join('')}</span>` : ''}
                    </div>`;
    }).join('')}
        </div>
    `;
    ensureMatureCountdownTimer();
};

window.friendQuickOp = async (event, gid, opType) => {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }
    if (!currentAccountId) return;
    const opMap = { steal: '偷取', water: '浇水', weed: '除草', bug: '除虫', bad: '捣乱' };
    const btn = event && event.currentTarget ? event.currentTarget : null;
    if (btn) btn.disabled = true;
    try {
        const ret = await api(`/api/friend/${gid}/op`, 'POST', { opType });
        if (!ret) {
            alert(`一键${opMap[opType] || '操作'}失败`);
            return;
        }
        if (ret.message) alert(ret.message);
        const landsEl = document.getElementById(`friend-lands-${gid}`);
        if (landsEl && landsEl.style.display === 'block') {
            landsEl.innerHTML = '<div style="padding:10px;text-align:center;color:#888"><i class="fas fa-spinner fa-spin"></i> 刷新中...</div>';
            const data = await api(`/api/friend/${gid}/lands`);
                if (data && data.lands) {
                    const statusClass = { empty: 'empty', locked: 'empty', stealable: 'harvestable', harvested: 'empty', dead: 'dead', growing: 'growing' };
                    landsEl.innerHTML = `
                    <div class="farm-grid mini">
                        ${data.lands.map(l => {
                    const cls = statusClass[l.status] || 'empty';
                    const landLevel = Number(l.level || 0);
                    const landLevelClass = `land-level-${Math.max(0, Math.min(4, landLevel))}`;
                    const phaseText = renderLandPhaseText(landLevel, l);
                    const needs = [];
                    if (l.needWater) needs.push('<i class="fas fa-tint" style="color:#4ab1ff" title="需要浇水"></i>');
                    if (l.needWeed) needs.push('<i class="fas fa-leaf" style="color:#56d4a0" title="需要除草"></i>');
                    if (l.needBug) needs.push('<i class="fas fa-bug" style="color:#f0b84f" title="需要除虫"></i>');
                    return `
                                <div class="land-cell ${cls} ${landLevelClass}">
                                    <span class="id">#${l.id}</span>
                                    ${renderLandCropImage(l)}
                                    <span class="plant-name">${escapeHtml(l.plantName || '-')}</span>
                                    <span class="phase-name">${phaseText}</span>
                                    ${needs.length ? `<span class="needs">${needs.join('')}</span>` : ''}
                                </div>`;
                }).join('')}
                    </div>
                `;
                ensureMatureCountdownTimer();
            }
        }
        loadFriends();
    } finally {
        if (btn) btn.disabled = false;
    }
};

// 种子加载
async function loadSeeds(preferredSeed) {
    if (seedLoadPromise) return seedLoadPromise;
    seedLoadPromise = (async () => {
        const list = await api('/api/seeds');
        const sel = $('seed-select');
        sel.innerHTML = '<option value="0">自动选择 (按策略)</option>';
        if (list && list.length) {
            list.forEach(s => {
                const o = document.createElement('option');
                o.value = s.seedId;
                const levelText = (s.requiredLevel === null || s.requiredLevel === undefined) ? 'Lv?' : `Lv${s.requiredLevel}`;
                const priceText = (s.price === null || s.price === undefined) ? '价格未知' : `${s.price}金`;
                let text = `${levelText} ${s.name} (${priceText})`;
                if (s.locked) {
                    text += ' [未解锁]';
                    o.disabled = true;
                    o.style.color = '#666';
                } else if (s.soldOut) {
                    text += ' [售罄]';
                    o.disabled = true;
                    o.style.color = '#666';
                }
                o.textContent = text;
                sel.appendChild(o);
            });
        }
        sel.dataset.loaded = '1';
        if (preferredSeed !== undefined && preferredSeed !== null) {
            const preferredVal = String(preferredSeed || 0);
            if (preferredVal !== '0' && !Array.from(sel.options).some(opt => opt.value === preferredVal)) {
                const fallbackOption = document.createElement('option');
                fallbackOption.value = preferredVal;
                fallbackOption.textContent = `种子${preferredVal} (当前不可购买/详情未知)`;
                sel.appendChild(fallbackOption);
            }
            sel.value = preferredVal;
        }
    })().finally(() => {
        seedLoadPromise = null;
    });
    return seedLoadPromise;
}

function getCurrentLevelFromUi() {
    const raw = String(($('level') && $('level').textContent) || '');
    const m = raw.match(/Lv\s*(\d+)/i);
    return m ? (parseInt(m[1], 10) || 0) : 0;
}

function getStrategySortKey(strategy) {
    const map = {
        max_exp: 'exp',
        max_fert_exp: 'fert',
        max_profit: 'profit',
        max_fert_profit: 'fert_profit',
    };
    return map[String(strategy || '')] || '';
}

function buildSeedOptionText(seed, seedId) {
    if (!seed) return `种子${seedId}`;
    const lv = (seed.requiredLevel === null || seed.requiredLevel === undefined) ? 'Lv?' : `Lv${seed.requiredLevel}`;
    const price = (seed.price === null || seed.price === undefined) ? '价格未知' : `${seed.price}金`;
    return `${lv} ${seed.name} (${price})`;
}

async function resolveStrategySeed(strategy) {
    const list = await api('/api/seeds');
    const seeds = Array.isArray(list) ? list : [];
    const available = seeds.filter(s => !s.locked && !s.soldOut);
    if (!available.length) return null;

    const availableById = new Map(available.map(s => [Number(s.seedId || 0), s]));

    if (strategy === 'level') {
        const sorted = [...available].sort((a, b) => {
            const av = Number(a.requiredLevel || 0);
            const bv = Number(b.requiredLevel || 0);
            if (bv !== av) return bv - av;
            return Number(a.seedId || 0) - Number(b.seedId || 0);
        });
        return sorted[0] || null;
    }

    const sortKey = getStrategySortKey(strategy);
    if (sortKey) {
        const level = getCurrentLevelFromUi();
        const analytics = await api(`/api/analytics?sort=${sortKey}`);
        const ranked = Array.isArray(analytics) ? analytics : [];
        for (const row of ranked) {
            const sid = Number(row && row.seedId) || 0;
            if (sid <= 0) continue;
            const reqLv = Number(row && row.level);
            if (Number.isFinite(reqLv) && reqLv > 0 && level > 0 && reqLv > level) continue;
            const found = availableById.get(sid);
            if (found) return found;
        }
    }

    const fallback = [...available].sort((a, b) => (Number(b.requiredLevel || 0) - Number(a.requiredLevel || 0)));
    return fallback[0] || null;
}

async function refreshSeedSelectByStrategy() {
    const strategy = String(($('strategy-select') && $('strategy-select').value) || 'preferred');
    const sel = $('seed-select');
    if (!sel) return;

    if (strategy === 'preferred') {
        sel.disabled = false;
        if (sel.dataset.loaded !== '1') {
            await loadSeeds(parseInt(sel.value, 10) || 0);
        }
        return;
    }

    sel.disabled = true;
    const matched = await resolveStrategySeed(strategy);
    if (!matched) {
        sel.innerHTML = '<option value="0">当前策略无可用种子</option>';
        sel.value = '0';
        sel.dataset.loaded = 'strategy';
        return;
    }
    const sid = Number(matched.seedId || 0);
    sel.innerHTML = `<option value="${sid}">${buildSeedOptionText(matched, sid)}</option>`;
    sel.value = String(sid);
    sel.dataset.loaded = 'strategy';
}

function markAutomationPending(key) {
    if (!key) return;
    pendingAutomationKeys.add(String(key));
}

// 绑定自动化开关（改为本地待保存，不即时提交）
$('fertilizer-select').addEventListener('change', async () => {
    if (!currentAccountId) return;
    markAutomationPending('fertilizer');
});

['auto-farm', 'auto-farm-push', 'auto-land-upgrade', 'auto-smart-farm-schedule', 'auto-friend', 'auto-task', 'auto-daily-routine', 'auto-fertilizer-gift', 'auto-fertilizer-buy', 'auto-sell', 'auto-friend-steal', 'auto-friend-help', 'auto-friend-bad'].forEach((id, i) => {
    // 这里原来的 id 是数组里的元素，key 需要处理
    // id: auto-farm -> key: farm
    // id: auto-friend-steal -> key: friend_steal
    const key = (id === 'auto-friend')
        ? 'friend_help_exp_limit'
        : id.replace('auto-', '').replace(/-/g, '_');
    const el = document.getElementById(id);
    if (el) {
        el.addEventListener('change', async () => {
            if (id === 'auto-friend') {
                updateFriendSubControlsState();
            }
            if (!currentAccountId) return;
            if (id === 'auto-daily-routine') {
                // daily-routine 对应多个字段，批量即时保存
                const v = el.checked;
                const resp = await api('/api/automation', 'POST', {
                    email: v, free_gifts: v, share_reward: v, vip_gift: v, month_card: v,
                });
                if (resp) updateRevisionState(resp);
            } else {
                queueAutomationUpdate(key, el.checked);
            }
        });
    }
});
updateFriendSubControlsState();

$('strategy-select').addEventListener('change', async () => {
    await refreshSeedSelectByStrategy();
});

$('btn-save-settings').addEventListener('click', async () => {
    const strategy = $('strategy-select').value;
    let farmMin = parseInt($('interval-farm-min').value, 10);
    let farmMax = parseInt($('interval-farm-max').value, 10);
    let friendMin = parseInt($('interval-friend-min').value, 10);
    let friendMax = parseInt($('interval-friend-max').value, 10);
    const seedId = parseInt($('seed-select').value) || 0;
    const friendQuietEnabled = !!$('friend-quiet-enabled').checked;
    const friendQuietStart = $('friend-quiet-start').value || '23:00';
    const friendQuietEnd = $('friend-quiet-end').value || '07:00';

    farmMin = Math.max(1, Number.isFinite(farmMin) ? farmMin : 2);
    farmMax = Math.max(1, Number.isFinite(farmMax) ? farmMax : farmMin);
    if (farmMin > farmMax) {
        alert('农场巡查间隔：最大值不能小于最小值');
        $('interval-farm-max').focus();
        return;
    }

    friendMin = Math.max(1, Number.isFinite(friendMin) ? friendMin : 10);
    friendMax = Math.max(1, Number.isFinite(friendMax) ? friendMax : friendMin);
    if (friendMin > friendMax) {
        alert('好友巡查间隔：最大值不能小于最小值');
        $('interval-friend-max').focus();
        return;
    }

    $('interval-farm-min').value = String(farmMin);
    $('interval-farm-max').value = String(farmMax);
    $('interval-friend-min').value = String(friendMin);
    $('interval-friend-max').value = String(friendMax);

    const saveBtn = $('btn-save-settings');
    if (saveBtn) saveBtn.disabled = true;
    try {
        const settingsResp = await api('/api/settings/save', 'POST', {
            strategy,
            seedId,
            intervals: {
                farm: farmMin,
                friend: friendMin,
                farmMin,
                farmMax,
                friendMin,
                friendMax,
            },
            friendQuietHours: {
                enabled: friendQuietEnabled,
                start: friendQuietStart,
                end: friendQuietEnd,
            }
        });
        updateRevisionState(settingsResp);

        const automationResp = await api('/api/automation', 'POST', {
            farm: !!$('auto-farm').checked,
            farm_push: !!$('auto-farm-push').checked,
            land_upgrade: !!$('auto-land-upgrade').checked,
            smart_farm_schedule: !!$('auto-smart-farm-schedule').checked,
            friend_help_exp_limit: !!$('auto-friend').checked,
            task: !!$('auto-task').checked,
            email: !!$('auto-daily-routine').checked,
            fertilizer_gift: !!$('auto-fertilizer-gift').checked,
            fertilizer_buy: !!$('auto-fertilizer-buy').checked,
            free_gifts: !!$('auto-daily-routine').checked,
            share_reward: !!$('auto-daily-routine').checked,
            vip_gift: !!$('auto-daily-routine').checked,
            month_card: !!$('auto-daily-routine').checked,
            sell: !!$('auto-sell').checked,
            fertilizer: $('fertilizer-select').value,
            friend_steal: !!$('auto-friend-steal').checked,
            friend_help: !!$('auto-friend-help').checked,
            friend_bad: !!$('auto-friend-bad').checked,
        });
        updateRevisionState(automationResp);
        pendingAutomationKeys.clear();

        await loadSettings();
        alert('设置已保存');
    } finally {
        if (saveBtn) saveBtn.disabled = false;
    }
});

const changeAdminPasswordBtn = document.getElementById('btn-change-admin-password');
if (changeAdminPasswordBtn) {
    changeAdminPasswordBtn.addEventListener('click', async () => {
        const oldPwdEl = $('admin-old-password');
        const newPwdEl = $('admin-new-password');
        const newPwd2El = $('admin-new-password2');
        const oldPwd = oldPwdEl ? oldPwdEl.value : '';
        const newPwd = newPwdEl ? newPwdEl.value : '';
        const newPwd2 = newPwd2El ? newPwd2El.value : '';
        if (!oldPwd) {
            alert('请输入当前管理密码');
            if (oldPwdEl) oldPwdEl.focus();
            return;
        }
        if (!newPwd) {
            alert('请输入新密码');
            if (newPwdEl) newPwdEl.focus();
            return;
        }
        if (newPwd.length < 4) {
            alert('新密码长度至少为 4 位');
            if (newPwdEl) newPwdEl.focus();
            return;
        }
        if (newPwd !== newPwd2) {
            alert('两次输入的新密码不一致');
            if (newPwd2El) newPwd2El.focus();
            return;
        }
        changeAdminPasswordBtn.disabled = true;
        try {
            const r = await fetch(API_ROOT + '/api/admin/change-password', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-admin-token': adminToken,
                },
                body: JSON.stringify({ oldPassword: oldPwd, newPassword: newPwd }),
            });
            const j = await r.json().catch(() => null);
            if (!r.ok || !j || !j.ok) {
                const msg = (j && (j.error || j.message)) || '修改失败';
                alert(msg);
                return;
            }
            if (oldPwdEl) oldPwdEl.value = '';
            if (newPwdEl) newPwdEl.value = '';
            if (newPwd2El) newPwd2El.value = '';
            alert('管理密码已更新，请牢记新密码');
        } catch (e) {
            alert('修改失败');
        } finally {
            changeAdminPasswordBtn.disabled = false;
        }
    });
}

const saveOfflineReminderBtn = document.getElementById('btn-save-offline-reminder');
const PUSHOO_CHANNELS = new Set([
    'webhook', 'qmsg', 'serverchan', 'pushplus', 'pushplushxtrip',
    'dingtalk', 'wecom', 'bark', 'gocqhttp', 'onebot', 'atri',
    'pushdeer', 'igot', 'telegram', 'feishu', 'ifttt', 'wecombot',
    'discord', 'wxpusher',
]);
function syncOfflineReminderChannelUI() {
    const channelEl = $('offline-reminder-channel');
    const endpointEl = $('offline-reminder-endpoint');
    if (!channelEl || !endpointEl) return;
    const channel = String(channelEl.value || 'webhook').trim() || 'webhook';
    const editable = channel === 'webhook';
    endpointEl.disabled = !editable;
}

const offlineReminderChannelEl = document.getElementById('offline-reminder-channel');
if (offlineReminderChannelEl) {
    offlineReminderChannelEl.addEventListener('change', syncOfflineReminderChannelUI);
    syncOfflineReminderChannelUI();
}
if (saveOfflineReminderBtn) {
    saveOfflineReminderBtn.addEventListener('click', async () => {
        const channel = String((($('offline-reminder-channel') || {}).value || 'webhook')).trim() || 'webhook';
        const reloginUrlMode = String((($('offline-reminder-relogin-url-mode') || {}).value || 'none')).trim() || 'none';
        const endpoint = String((($('offline-reminder-endpoint') || {}).value || '')).trim();
        const token = String((($('offline-reminder-token') || {}).value || '')).trim();
        const title = String((($('offline-reminder-title') || {}).value || '')).trim();
        const msg = String((($('offline-reminder-msg') || {}).value || '')).trim();
        let offlineDeleteSec = parseInt((($('offline-delete-seconds') || {}).value || ''), 10);
        if (!Number.isFinite(offlineDeleteSec) || offlineDeleteSec < 1) offlineDeleteSec = 172800;
        const savePayload = { channel, reloginUrlMode, token, title, msg, offlineDeleteSec };
        if (channel === 'webhook') {
            if (endpoint) savePayload.endpoint = endpoint;
        }

        saveOfflineReminderBtn.disabled = true;
        try {
            const ret = await api('/api/settings/offline-reminder', 'POST', savePayload);
            if (!ret) {
                alert('保存下线提醒设置失败');
                return;
            }
            if ($('offline-delete-seconds')) $('offline-delete-seconds').value = String(offlineDeleteSec);
            alert('下线提醒设置已保存');
        } finally {
            saveOfflineReminderBtn.disabled = false;
        }
    });
}

// 加载额外设置
async function loadSettings() {
    const data = await api('/api/settings');
    if (data) {
        if (data.strategy) $('strategy-select').value = data.strategy;
        if (data.intervals) {
            const farmBase = Number(data.intervals.farm || 2);
            const friendBase = Number(data.intervals.friend || 10);
            const farmMin = Number(data.intervals.farmMin || farmBase || 2);
            const farmMax = Number(data.intervals.farmMax || farmMin || 2);
            const friendMin = Number(data.intervals.friendMin || friendBase || 10);
            const friendMax = Number(data.intervals.friendMax || friendMin || 10);
            $('interval-farm-min').value = String(farmMin);
            $('interval-farm-max').value = String(farmMax);
            $('interval-friend-min').value = String(friendMin);
            $('interval-friend-max').value = String(friendMax);
        }
        if (data.preferredSeed !== undefined) {
            const sel = $('seed-select');
            if (currentAccountId && sel.dataset.loaded !== '1') {
                await loadSeeds(data.preferredSeed);
            } else {
                sel.value = String(data.preferredSeed || 0);
            }
        }
        if (data.automation && typeof data.automation === 'object') {
            const auto = data.automation;
            $('auto-farm').checked = !!auto.farm;
            $('auto-farm-push').checked = !!auto.farm_push;
            $('auto-land-upgrade').checked = !!auto.land_upgrade;
            $('auto-smart-farm-schedule').checked = !!auto.smart_farm_schedule;
            $('auto-friend').checked = !!auto.friend_help_exp_limit;
            $('auto-task').checked = !!auto.task;
            $('auto-daily-routine').checked = !!(auto.email && auto.free_gifts && auto.share_reward && auto.vip_gift && auto.month_card);
            $('auto-fertilizer-gift').checked = !!auto.fertilizer_gift;
            $('auto-fertilizer-buy').checked = !!auto.fertilizer_buy;
            $('auto-sell').checked = !!auto.sell;
            $('auto-friend-steal').checked = !!auto.friend_steal;
            $('auto-friend-help').checked = !!auto.friend_help;
            $('auto-friend-bad').checked = !!auto.friend_bad;
            if (auto.fertilizer) $('fertilizer-select').value = auto.fertilizer;
            updateFriendSubControlsState();
        }
        await refreshSeedSelectByStrategy();
        if (data.friendQuietHours) {
            $('friend-quiet-enabled').checked = !!data.friendQuietHours.enabled;
            $('friend-quiet-start').value = data.friendQuietHours.start || '23:00';
            $('friend-quiet-end').value = data.friendQuietHours.end || '07:00';
        }
        if (data.ui && ['dark','light','harvest','spring','nightfarm'].includes(data.ui.theme)) {
            localStorage.setItem(THEME_STORAGE_KEY, data.ui.theme);
            applyTheme(data.ui.theme);
        }
        const reminder = (data.offlineReminder && typeof data.offlineReminder === 'object') ? data.offlineReminder : {};
        const savedChannel = String(reminder.channel || '').trim().toLowerCase();
        if ($('offline-reminder-channel')) {
            $('offline-reminder-channel').value = PUSHOO_CHANNELS.has(savedChannel) ? savedChannel : 'webhook';
        }
        const reloginUrlMode = String(reminder.reloginUrlMode || 'none').trim();
        if ($('offline-reminder-relogin-url-mode')) {
            const reloginUrlModeEl = $('offline-reminder-relogin-url-mode');
            const allow = new Set(['none', 'qq_link', 'qr_link']);
            reloginUrlModeEl.value = allow.has(reloginUrlMode) ? reloginUrlMode : 'none';
        }
        if ($('offline-reminder-endpoint')) {
            $('offline-reminder-endpoint').value = String(reminder.endpoint || '').trim();
        }
        syncOfflineReminderChannelUI();
        if ($('offline-reminder-token')) $('offline-reminder-token').value = String(reminder.token || '');
        if ($('offline-reminder-title')) $('offline-reminder-title').value = String(reminder.title || '账号下线提醒');
        if ($('offline-reminder-msg')) $('offline-reminder-msg').value = String(reminder.msg || '账号下线');
        if ($('offline-delete-seconds')) $('offline-delete-seconds').value = String(Number(reminder.offlineDeleteSec || 172800));
        const enabled = !!$('friend-quiet-enabled').checked;
        $('friend-quiet-start').disabled = !enabled;
        $('friend-quiet-end').disabled = !enabled;
    }
}

const friendQuietEnabledEl = document.getElementById('friend-quiet-enabled');
if (friendQuietEnabledEl) {
    friendQuietEnabledEl.addEventListener('change', () => {
        const enabled = !!friendQuietEnabledEl.checked;
        $('friend-quiet-start').disabled = !enabled;
        $('friend-quiet-end').disabled = !enabled;
    });
}

async function loadBag() {
    const listEl = $('bag-list');
    const sumEl = $('bag-summary');
    if (!listEl || !sumEl) return;
    if (!currentAccountId) {
        sumEl.textContent = '请选择账号';
        listEl.innerHTML = '<div style="padding:20px;text-align:center;color:#666">请选择账号后查看背包</div>';
        return;
    }
    sumEl.textContent = '加载中...';
    listEl.innerHTML = '<div style="padding:20px;text-align:center;color:#888"><i class="fas fa-spinner fa-spin"></i> 加载中...</div>';
    const data = await api('/api/bag');
    const items = data && Array.isArray(data.items) ? data.items : [];
    const hiddenIds = new Set([1, 1001, 1002, 1101, 1011, 1012, 3001, 3002]);
    const allDisplay = items.filter(it => !hiddenIds.has(Number(it.id || 0)));

    const fruits = allDisplay.filter(it => Number(it.itemType) === 6);
    const seeds  = allDisplay.filter(it => Number(it.itemType) === 5);
    const props  = allDisplay.filter(it => Number(it.itemType) !== 5 && Number(it.itemType) !== 6);

    sumEl.textContent = `共 ${allDisplay.length} 条（果实 ${fruits.length} · 种子 ${seeds.length} · 道具 ${props.length}）`;

    if (!allDisplay.length) {
        listEl.innerHTML = '<div style="padding:20px;text-align:center;color:#666">无可展示物品</div>';
        return;
    }

    // 生成唯一 key：id+uid
    function itemKey(it) { return `${it.id}_${it.uid || 0}`; }

    function renderBagItem(it, tabId) {
        const idNum = Number(it.id || 0);
        const uidNum = Number(it.uid || 0);
        const cnt = Number(it.count || 0);
        const price = Number(it.price || 0);
        const lvInfo = Number(it.level || 0) > 0 ? ` Lv.${Number(it.level)}` : '';
        const priceHtml = price > 0
            ? `<div class="bag-price-tag"><i class="fas fa-coins"></i> ${price}/个</div>`
            : '';
        const hoursHtml = it.hoursText
            ? `<div class="count bag-count-right" style="color:var(--primary)">${escapeHtml(String(it.hoursText))}</div>`
            : `<div class="count bag-count-right">x${cnt}</div>`;
        const key = itemKey(it);
        const cbId = `bag-cb-${tabId}-${key}`;
        return `
      <div class="bag-item bag-item-selectable" data-key="${key}" data-id="${idNum}" data-uid="${uidNum}" data-tab="${tabId}" data-maxcount="${cnt}" data-price="${price}">
        <label class="bag-select-wrap">
          <input type="checkbox" class="bag-cb" id="${cbId}" data-key="${key}" data-id="${idNum}" data-uid="${uidNum}" data-tab="${tabId}">
        </label>
        <div class="bag-top">
          <div class="thumb-wrap ${it.image ? '' : 'fallback'}">
            ${it.image ? `<img class="bag-thumb" src="${escapeHtml(String(it.image))}" alt="${escapeHtml(String(it.name || '物品'))}" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none';this.closest('.thumb-wrap').classList.add('fallback')">` : ''}
            <span class="bag-thumb-fallback">${escapeHtml(String((it.name || '物').slice(0,1)))}</span>
          </div>
          ${hoursHtml}
        </div>
        <div class="name">${escapeHtml(String(it.name || ('物品'+idNum)))}${lvInfo}</div>
        ${priceHtml}
      </div>`;
    }

    function renderTab(tabId, tabItems, actionType) {
        if (!tabItems.length) return '<div style="padding:16px;text-align:center;color:#888">暂无物品</div>';
        const isSell = actionType === 'sell';
        const actionLabel = isSell ? '出售选中' : '使用选中';
        const actionIcon  = isSell ? 'fa-coins' : 'fa-bolt';
        return `
        <div class="bag-tab-body" data-tab="${tabId}">
          <div class="bag-section-head">
            <div class="bag-section-actions">
              <label class="bag-sel-all-label">
                <input type="checkbox" class="bag-sel-all" data-tab="${tabId}" title="全选/取消全选"> 全选
              </label>
              <button class="btn btn-sm btn-primary bag-action-btn" data-tab="${tabId}" data-action="${actionType}">
                <i class="fas ${actionIcon}"></i> ${actionLabel}
              </button>
            </div>
          </div>
          <div class="bag-list-inner">${tabItems.map(it => renderBagItem(it, tabId)).join('')}</div>
        </div>`;
    }

    // 渲染 tab 导航（插入到 card-head 右侧）+ 内容
    const cardHead = listEl.closest('.card') && listEl.closest('.card').querySelector('.card-head');
    let tabsEl = cardHead && cardHead.querySelector('.bag-tabs');
    if (!tabsEl && cardHead) {
        tabsEl = document.createElement('div');
        tabsEl.className = 'bag-tabs';
        cardHead.appendChild(tabsEl);
    }
    if (tabsEl) {
        tabsEl.innerHTML = `
          <button class="bag-tab-btn active" data-tab="fruit"><i class="fas fa-apple-alt"></i> 果实 (${fruits.length})</button>
          <button class="bag-tab-btn" data-tab="seed"><i class="fas fa-seedling"></i> 种子 (${seeds.length})</button>
          <button class="bag-tab-btn" data-tab="prop"><i class="fas fa-box"></i> 道具 (${props.length})</button>`;
    }
    listEl.innerHTML = `
      <div id="bag-tab-fruit" class="bag-tab-panel" style="display:block">
        ${renderTab('fruit', fruits, 'sell')}
      </div>
      <div id="bag-tab-seed" class="bag-tab-panel" style="display:none">
        ${renderTab('seed', seeds, 'sell')}
      </div>
      <div id="bag-tab-prop" class="bag-tab-panel" style="display:none">
        ${renderTab('prop', props, 'use')}
      </div>`;

    // tab 切换（tabs 已移入 card-head）
    const tabContainer = cardHead || listEl;
    tabContainer.querySelectorAll('.bag-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            tabContainer.querySelectorAll('.bag-tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const tab = btn.dataset.tab;
            listEl.querySelectorAll('.bag-tab-panel').forEach(p => {
                p.style.display = p.id === `bag-tab-${tab}` ? 'block' : 'none';
            });
        });
    });

    // 点击物品卡片 → 选中并默认填满该条全部数量
    listEl.querySelectorAll('.bag-item-selectable').forEach(card => {
        card.addEventListener('click', (e) => {
            if (e.target.tagName === 'INPUT') return; // checkbox 自己处理
            const cb = card.querySelector('.bag-cb');
            if (!cb) return;
            cb.checked = !cb.checked;
            cb.dispatchEvent(new Event('change', { bubbles: true }));
        });
    });

    // 全选逻辑
    listEl.querySelectorAll('.bag-sel-all').forEach(cb => {
        cb.addEventListener('change', () => {
            const tab = cb.dataset.tab;
            listEl.querySelectorAll(`.bag-cb[data-tab="${tab}"]`).forEach(c => { c.checked = cb.checked; });
        });
    });
    // 单项勾选同步全选
    listEl.querySelectorAll('.bag-cb').forEach(cb => {
        cb.addEventListener('change', () => {
            const tab = cb.dataset.tab;
            const all = listEl.querySelectorAll(`.bag-cb[data-tab="${tab}"]`);
            const allCb = listEl.querySelector(`.bag-sel-all[data-tab="${tab}"]`);
            if (allCb) allCb.checked = [...all].every(c => c.checked);
        });
    });

    // 操作按钮
    listEl.querySelectorAll('.bag-action-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const tab = btn.dataset.tab;
            const action = btn.dataset.action;
            const checked = [...listEl.querySelectorAll(`.bag-cb[data-tab="${tab}"]:checked`)];
            if (!checked.length) { alert('请先选择物品'); return; }
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 处理中...';
            try {
                if (action === 'sell') {
                    const sellItems = checked.map(c => {
                        const card = listEl.querySelector(`.bag-item-selectable[data-key="${c.dataset.key}"][data-tab="${tab}"]`);
                        const maxCount = Number((card && card.dataset.maxcount) || 1);
                        const uid = Number((card && card.dataset.uid) || 0);
                        const item = { id: Number(c.dataset.id), count: maxCount };
                        if (uid > 0) item.uid = uid;
                        return item;
                    });
                    const res = await api('/api/bag/sell', 'POST', { items: sellItems });
                    // 尝试从返回结果里获取金币收益
                    const gold = res && res.result && res.result.gold != null ? Number(res.result.gold) : null;
                    if (gold != null && gold > 0) {
                        showToast(`出售成功，获得 ${gold.toLocaleString()} 金币`);
                    } else {
                        showToast('出售成功');
                    }
                } else {
                    for (const c of checked) {
                        const card = listEl.querySelector(`.bag-item-selectable[data-key="${c.dataset.key}"][data-tab="${tab}"]`);
                        const maxCount = Number((card && card.dataset.maxcount) || 1);
                        await api('/api/bag/use', 'POST', { itemId: Number(c.dataset.id), count: maxCount });
                    }
                    showToast('使用成功');
                }
                await loadBag();
            } catch(e) {
                alert('操作失败: ' + (e.message || e));
                btn.disabled = false;
                btn.innerHTML = action === 'sell'
                    ? '<i class="fas fa-coins"></i> 出售选中'
                    : '<i class="fas fa-bolt"></i> 使用选中';
            }
        });
    });
}

async function loadDailyGifts() {
    const listEl = $('daily-gifts-list');
    const sumEl = $('daily-gifts-summary');
    const growthListEl = $('growth-task-list');
    const growthFillEl = $('growth-task-fill');
    if (!listEl || !sumEl || !growthListEl || !growthFillEl) return;
    if (!currentAccountId) {
        sumEl.textContent = '请选择账号';
        listEl.innerHTML = '<div class="op-stat"><span class="label"><i class="fas fa-info-circle"></i> 暂无账号</span><span class="count">--</span></div>';
        growthFillEl.style.width = '0%';
        growthListEl.innerHTML = '<div class="growth-task-row"><span class="growth-task-name"><i class="fas fa-info-circle"></i> 暂无账号</span><span class="growth-task-status">--</span></div>';
        return;
    }
    growthFillEl.style.width = '0%';
    sumEl.textContent = '加载中...';
    const data = await api('/api/daily-gifts');
    const growth = (data && data.growth && typeof data.growth === 'object') ? data.growth : null;
    const growthTasks = growth && Array.isArray(growth.tasks) ? growth.tasks : [];
    const growthCompleted = Number(growth && growth.completedCount || 0);
    const growthTotal = Number(growth && growth.totalCount || 0);
    let growthPct = 0;
    if (growthTasks.length > 0) {
        let sumProgress = 0;
        let sumTotal = 0;
        for (const t of growthTasks) {
            const progress = Math.max(0, Number(t && t.progress || 0));
            const total = Math.max(0, Number(t && t.totalProgress || 0));
            if (total > 0) {
                sumProgress += Math.min(progress, total);
                sumTotal += total;
            }
        }
        if (sumTotal > 0) growthPct = Math.max(0, Math.min(100, (sumProgress / sumTotal) * 100));
    }
    if (growthPct <= 0 && growthTotal > 0) {
        // 兜底：无明细 total 时沿用完成数量口径
        growthPct = Math.max(0, Math.min(100, (growthCompleted / growthTotal) * 100));
    }
    growthFillEl.style.width = `${growthPct}%`;
    if (!growthTasks.length) {
        growthListEl.innerHTML = '<div class="growth-task-row"><span class="growth-task-name"><i class="fas fa-info-circle"></i> 暂无数据</span><span class="growth-task-status">--</span></div>';
    } else {
        growthListEl.innerHTML = growthTasks.map((t) => {
            const progress = Math.max(0, Number(t && t.progress || 0));
            const total = Math.max(0, Number(t && t.totalProgress || 0));
            const isUnlocked = !!(t && t.isUnlocked);
            const isCompleted = !!(t && t.isCompleted);
            const status = isUnlocked ? (total > 0 ? `${progress}/${total}` : (isCompleted ? '✓' : '✕')) : '-';
            const cls = isUnlocked ? (isCompleted ? 'color:var(--ok)' : '') : 'opacity:.65';
            return `<div class="growth-task-row"><span class="growth-task-name"><i class="fas fa-seedling"></i>${escapeHtml(String((t && t.desc) || '成长任务'))}</span><span class="growth-task-status" style="${cls}">${status}</span></div>`;
        }).join('');
    }

    const gifts = (data && Array.isArray(data.gifts)) ? data.gifts : [];
    const doneCount = gifts.filter(g => !!g.doneToday).length;
    sumEl.textContent = `今日完成 ${doneCount}/${gifts.length || 0}`;
    if (!gifts.length) {
        listEl.innerHTML = '<div class="op-stat"><span class="label"><i class="fas fa-info-circle"></i> 暂无数据</span><span class="count">--</span></div>';
        return;
    }
    const rows = gifts.map((g) => {
        let status = g.doneToday ? '✓' : (g.enabled ? '✕' : '-');
        if (g.key === 'task_claim') {
            const done = Math.max(0, Number(g.completedCount || 0));
            const total = Math.max(1, Number(g.totalCount || 3));
            status = `${done}/${total}`;
        }
        if (g.key === 'fertilizer_buy' && !g.doneToday && g.pausedNoGoldToday) status = '点券不足暂停';
        const cls = g.key === 'task_claim'
            ? ((Number(g.completedCount || 0) >= Number(g.totalCount || 3)) ? 'color:var(--ok)' : '')
            : (g.doneToday ? 'color:var(--ok)' : (g.enabled ? '' : 'opacity:.65'));
        return `<div class="op-stat"><span class="label"><i class="fas fa-gift"></i>${g.label || g.key}</span><span class="count" style="${cls}">${status}</span></div>`;
    });
    listEl.innerHTML = rows.join('');
}

// ============ UI 交互 ============
function activatePage(pageName) {
    const target = String(pageName || '').trim();
    if (!target) return;

    // 防挂页面权限：仅 admin / vip 可进
    if (target === 'antiafk') {
        const canEnter = currentUser && (currentUser.role === 'admin' || currentUser.role === 'vip');
        if (!canEnter) { showToast('该功能仅限超级会员使用', 2000); return; }
    }

    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));

    const nav = document.querySelector(`.nav-item[data-page="${target}"]`);
    if (nav) nav.classList.add('active');
    const page = document.getElementById('page-' + target);
    if (page) page.classList.add('active');

    const titleEl = $('page-title');
    if (titleEl) {
        if (nav) titleEl.textContent = nav.textContent.trim();
        else {
            const fallbackMap = {
                dashboard: '概览',
                personal: '个人',
                friends: '好友',
                accounts: '账号',
                analytics: '分析',
                settings: '设置',
                ranch: '牧场',
                antiafk: '防挂',
            };
            titleEl.textContent = fallbackMap[target] || '概览';
        }
    }

    if (target === 'dashboard') renderOpsList(lastOperationsData);
    if (target === 'personal') {
        loadDailyGifts();
        loadBag();
        loadFarm();
    }
    if (target === 'friends') loadFriends();
    if (target === 'analytics') loadAnalytics();
    if (target === 'ranch') {
        if (typeof loadRanch === 'function') loadRanch();
    }
    if (target === 'antiafk') {
        if (typeof loadAntiafk === 'function') loadAntiafk();
    }
    if (target === 'settings') {
        loadSettings();
        if (typeof loadPlantBlacklist === 'function') loadPlantBlacklist();
        loadTheftKingConfig();
        if (typeof loadAdminSmtpConfig === 'function') loadAdminSmtpConfig();
        if (typeof loadVipSmtpConfig === 'function') loadVipSmtpConfig();
        if (typeof loadFruitSellBlacklist === 'function') loadFruitSellBlacklist();
    }
    if (target === 'accounts') {
        renderAccountManager();
        pollAccountLogs();
        if (currentUser && currentUser.role === 'admin') {
            loadUsers();
            if (typeof loadRegisterConfig === 'function') loadRegisterConfig();
        }
        if (typeof loadFriendBlacklist === 'function') loadFriendBlacklist();
    }
}

// 导航切换
document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', e => {
        e.preventDefault();
        activatePage(item.dataset.page);
    });
});

const goAnalyticsBtn = $('btn-go-analytics');
if (goAnalyticsBtn) {
    goAnalyticsBtn.addEventListener('click', () => activatePage('analytics'));
}

// 数据分析
async function loadAnalytics() {
    const container = $('analytics-list');
    if (!container) return;
    container.innerHTML = '<div style="padding:20px;text-align:center;color:#888"><i class="fas fa-spinner fa-spin"></i> 加载中...</div>';

    const sort = $('analytics-sort').value;
    const list = await api(`/api/analytics?sort=${sort}`);

    if (!list || !list.length) {
        container.innerHTML = '<div style="padding:24px;text-align:center;color:#666;font-size:16px">暂无数据</div>';
        return;
    }

    // 前端兜底：始终按当前指标倒序显示
    const metricMap = {
        exp: 'expPerHour',
        fert: 'normalFertilizerExpPerHour',
        profit: 'profitPerHour',
        fert_profit: 'normalFertilizerProfitPerHour',
        level: 'level',
    };
    const metric = metricMap[sort];
    if (metric) {
        list.sort((a, b) => {
            const av = Number(a && a[metric]);
            const bv = Number(b && b[metric]);
            if (!Number.isFinite(av) && !Number.isFinite(bv)) return 0;
            if (!Number.isFinite(av)) return 1;
            if (!Number.isFinite(bv)) return -1;
            return bv - av;
        });
    }

    // 表格头
    let html = `
    <table style="width:100%;border-collapse:collapse;color:var(--text-main)">
        <thead>
            <tr style="border-bottom:1px solid var(--border);text-align:left;color:var(--text-sub)">
                <th>作物 (Lv)</th>
                <th>时间</th>
                <th>经验/时</th>
                <th>普通肥经验/时</th>
                <th>净利润/时</th>
                <th>普通肥净利润/时</th>
            </tr>
        </thead>
        <tbody>
    `;

    list.forEach((item, index) => {
        const lvText = (item.level === null || item.level === undefined || item.level === '' || Number(item.level) < 0)
            ? '未知'
            : String(item.level);
        html += `
            <tr style="border-bottom:1px solid var(--border);">
                <td>
                    <div>${item.name}</div>
                    <div style="font-size:13px;color:var(--text-sub)">Lv${lvText}</div>
                </td>
                <td>${item.growTimeStr}</td>
                <td style="font-weight:bold;color:var(--accent)">${item.expPerHour}</td>
                <td style="font-weight:bold;color:var(--primary)">${item.normalFertilizerExpPerHour ?? '-'}</td>
                <td style="font-weight:bold;color:#f0b84f">${item.profitPerHour ?? '-'}</td>
                <td style="font-weight:bold;color:#74d39a">${item.normalFertilizerProfitPerHour ?? '-'}</td>
            </tr>
        `;
    });

    html += '</tbody></table>';
    container.innerHTML = html;
}

$('analytics-sort').addEventListener('change', loadAnalytics);

// 单块土地快捷操作
window.doSingleLandOp = async (opType, landId) => {
    if (!currentAccountId) return;
    try {
        const resp = await api('/api/farm/operate', 'POST', { opType: opType + '_land:' + landId });
        loadFarm();
        const actions = resp && resp.result && Array.isArray(resp.result.actions) ? resp.result.actions : null;
        const msg = (actions && actions.length > 0) ? actions.join('/') + '完成' : '操作完成';
        if (typeof showToast === 'function') showToast('#' + landId + ' ' + msg, 'success');
    } catch (e) {
        if (typeof showToast === 'function') showToast('操作失败: ' + (e.message || e), 'error');
    }
};

// 农场操作
window.doFarmOp = async (type) => {
    if (!currentAccountId) return;
    const opLabels = {
        harvest: '收获',
        clear: '浇水/除草/虫',
        water: '浇水',
        fert_normal: '施无机肥',
        fert_organic: '施有机肥',
        upgrade: '升级土地',
        all: '一键全收',
        plant: '种植',
    };
    // 快捷操作（浇水/施肥/收获）直接执行无需确认
    const quickOps = ['water', 'fert_normal', 'fert_organic', 'harvest'];
    if (!quickOps.includes(type) && !confirm('确定执行此操作吗?')) return;
    try {
        const resp = await api('/api/farm/operate', 'POST', { opType: type });
        loadFarm();
        const actions = resp && resp.result && Array.isArray(resp.result.actions) ? resp.result.actions : null;
        if (actions && actions.length > 0) {
            if (typeof showToast === 'function') showToast(actions.join('／') + '完成', 'success');
        } else if (actions && actions.length === 0) {
            const label = opLabels[type] || type;
            if (typeof showToast === 'function') showToast('无需要' + label + '的地块', 'info');
        } else {
            const label = opLabels[type] || type;
            if (typeof showToast === 'function') showToast(label + '完成', 'success');
        }
    } catch (e) {
        if (typeof showToast === 'function') showToast('操作失败: ' + (e.message || e), 'error');
        else alert('操作失败: ' + (e.message || e));
    }
};

// 一键种植弹窗
window.openPlantModal = async (landId) => {
    landId = landId || 0;
    if (!currentAccountId) return;
    // 创建弹窗
    let modal = document.getElementById('plant-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'plant-modal';
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;';
        modal.innerHTML = `
            <div style="background:var(--card-bg,#fff);border-radius:12px;padding:20px;width:360px;max-width:94vw;max-height:80vh;display:flex;flex-direction:column;gap:12px;box-shadow:0 8px 32px rgba(0,0,0,0.3);">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <b style="font-size:16px;">🌱 一键种植</b>
                    <span onclick="document.getElementById('plant-modal').remove()" style="cursor:pointer;font-size:20px;opacity:0.6;">✕</span>
                </div>
                <div id="plant-modal-body" style="overflow-y:auto;flex:1;">加载中...</div>
                <div style="display:flex;gap:8px;justify-content:flex-end;">
                    <button class="btn btn-sm" onclick="document.getElementById('plant-modal').remove()">取消</button>
                    <button class="btn btn-primary btn-sm" id="plant-modal-confirm" disabled>种植</button>
                </div>
            </div>`;
        document.body.appendChild(modal);
        modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    }
    document.body.appendChild(modal);

    const body = document.getElementById('plant-modal-body');
    const confirmBtn = document.getElementById('plant-modal-confirm');
    let selectedSeedId = 0;
    confirmBtn.disabled = true;
    body.innerHTML = '加载中...';

    try {
        const res = await api('/api/seeds', 'GET');
        const seeds = Array.isArray(res) ? res : (res && res.data) || [];
        if (seeds.length === 0) {
            body.innerHTML = '<p style="color:#e87;text-align:center;padding:16px;">获取种子列表失败，请检查账号连接状态</p>';
            return;
        }
        const unlocked = seeds.filter(s => !s.locked);
        const locked = seeds.filter(s => s.locked);
        const renderItem = (s) => {
            const lockedStyle = s.locked ? 'opacity:0.45;pointer-events:none;' : '';
            const lockTip = s.locked ? ` (Lv${s.requiredLevel}解锁)` : '';
            const soldTip = s.soldOut ? ' [售罄]' : '';
            const priceStr = s.price != null ? `${s.price}金币` : '?';
            return `<label style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;cursor:pointer;border:2px solid transparent;transition:border-color 0.15s;${lockedStyle}" data-seed="${s.seedId}" class="plant-seed-item">
                <input type="radio" name="seed_pick" value="${s.seedId}" ${s.locked || s.soldOut ? 'disabled' : ''} style="accent-color:#4caf50;width:16px;height:16px;">
                <span style="flex:1;">${s.name}${lockTip}${soldTip}</span>
                <span style="font-size:12px;opacity:0.7;">${priceStr}/个</span>
            </label>`;
        };
        let html = '';
        if (unlocked.length > 0) {
            html += `<div style="font-size:12px;opacity:0.6;margin-bottom:4px;">已解锁（${unlocked.length}种）</div>`;
            html += unlocked.map(renderItem).join('');
        }
        if (locked.length > 0) {
            html += `<div style="font-size:12px;opacity:0.6;margin:8px 0 4px;">未解锁</div>`;
            html += locked.map(renderItem).join('');
        }
        body.innerHTML = html;

        body.querySelectorAll('input[name=seed_pick]').forEach(radio => {
            radio.addEventListener('change', () => {
                selectedSeedId = Number(radio.value);
                confirmBtn.disabled = selectedSeedId <= 0;
                body.querySelectorAll('.plant-seed-item').forEach(el => {
                    el.style.borderColor = Number(el.dataset.seed) === selectedSeedId ? '#4caf50' : 'transparent';
                    el.style.background = Number(el.dataset.seed) === selectedSeedId ? 'rgba(76,175,80,0.08)' : '';
                });
            });
        });

        confirmBtn.onclick = async () => {
            if (!selectedSeedId) return;
            confirmBtn.disabled = true;
            confirmBtn.textContent = '种植中...';
            try {
                const plantOp = landId > 0 ? `plant_specific_land:${selectedSeedId}:${landId}` : `plant_specific:${selectedSeedId}`;
                await api('/api/farm/operate', 'POST', { opType: plantOp });
                modal.remove();
                loadFarm();
            } catch (e) {
                alert('种植失败: ' + (e.message || e));
                confirmBtn.disabled = false;
                confirmBtn.textContent = '种植';
            }
        };
    } catch (e) {
        body.innerHTML = `<p style="color:#e55;text-align:center;">加载失败: ${e.message || e}</p>`;
    }
};


// 一键种植全收弹窗
window.openPlantHarvestModal = async () => {
    if (!currentAccountId) return;
    let modal = document.getElementById('plant-harvest-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'plant-harvest-modal';
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;';
        modal.innerHTML = `
            <div style="background:var(--card-bg,#fff);border-radius:12px;padding:20px;width:360px;max-width:94vw;max-height:80vh;display:flex;flex-direction:column;gap:12px;box-shadow:0 8px 32px rgba(0,0,0,0.3);">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <b style="font-size:16px;">🌾 一键种植全收</b>
                    <span onclick="document.getElementById('plant-harvest-modal').remove()" style="cursor:pointer;font-size:20px;opacity:0.6;">✕</span>
                </div>
                <div id="plant-harvest-modal-body" style="overflow-y:auto;flex:1;">加载中...</div>
                <div style="display:flex;gap:8px;justify-content:flex-end;">
                    <button class="btn btn-sm" onclick="document.getElementById('plant-harvest-modal').remove()">取消</button>
                    <button class="btn btn-primary btn-sm" id="plant-harvest-modal-confirm" disabled>全收并种植</button>
                </div>
            </div>`;
        document.body.appendChild(modal);
        modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    }
    document.body.appendChild(modal);

    const body = document.getElementById('plant-harvest-modal-body');
    const confirmBtn = document.getElementById('plant-harvest-modal-confirm');
    let selectedSeedId = 0;
    confirmBtn.disabled = true;
    body.innerHTML = '加载中...';

    try {
        const res = await api('/api/seeds', 'GET');
        const seeds = Array.isArray(res) ? res : (res && res.data) || [];
        if (seeds.length === 0) {
            body.innerHTML = '<p style="color:#e87;text-align:center;padding:16px;">获取种子列表失败，请检查账号连接状态</p>';
            return;
        }
        const unlocked = seeds.filter(s => !s.locked);
        const locked = seeds.filter(s => s.locked);
        const renderItem = (s) => {
            const lockedStyle = s.locked ? 'opacity:0.45;pointer-events:none;' : '';
            const lockTip = s.locked ? ` (Lv${s.requiredLevel}解锁)` : '';
            const soldTip = s.soldOut ? ' [售罄]' : '';
            const priceStr = s.price != null ? `${s.price}金币` : '?';
            return `<label style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;cursor:pointer;border:2px solid transparent;transition:border-color 0.15s;${lockedStyle}" data-seed="${s.seedId}" class="plant-harvest-seed-item">
                <input type="radio" name="seed_harvest_pick" value="${s.seedId}" ${s.locked || s.soldOut ? 'disabled' : ''} style="accent-color:#4caf50;width:16px;height:16px;">
                <span style="flex:1;">${s.name}${lockTip}${soldTip}</span>
                <span style="font-size:12px;opacity:0.7;">${priceStr}/个</span>
            </label>`;
        };
        let html = '';
        if (unlocked.length > 0) {
            html += `<div style="font-size:12px;opacity:0.6;margin-bottom:4px;">已解锁（${unlocked.length}种）</div>`;
            html += unlocked.map(renderItem).join('');
        }
        if (locked.length > 0) {
            html += `<div style="font-size:12px;opacity:0.6;margin:8px 0 4px;">未解锁</div>`;
            html += locked.map(renderItem).join('');
        }
        body.innerHTML = html;

        body.querySelectorAll('input[name=seed_harvest_pick]').forEach(radio => {
            radio.addEventListener('change', () => {
                selectedSeedId = Number(radio.value);
                confirmBtn.disabled = selectedSeedId <= 0;
                body.querySelectorAll('.plant-harvest-seed-item').forEach(el => {
                    el.style.borderColor = Number(el.dataset.seed) === selectedSeedId ? '#4caf50' : 'transparent';
                    el.style.background = Number(el.dataset.seed) === selectedSeedId ? 'rgba(76,175,80,0.08)' : '';
                });
            });
        });

        confirmBtn.onclick = async () => {
            if (!selectedSeedId) return;
            confirmBtn.disabled = true;
            confirmBtn.textContent = '执行中...';
            try {
                // 先全收（harvest only，不种植）
                await api('/api/farm/operate', 'POST', { opType: 'all' });
                // 再用指定种子种植空地
                await api('/api/farm/operate', 'POST', { opType: `plant_specific:${selectedSeedId}` });
                modal.remove();
                loadFarm();
                if (typeof showToast === 'function') showToast('全收并种植完成', 'success');
            } catch (e) {
                alert('操作失败: ' + (e.message || e));
                confirmBtn.disabled = false;
                confirmBtn.textContent = '全收并种植';
            }
        };
    } catch (e) {
        body.innerHTML = `<p style="color:#e55;text-align:center;">加载失败: ${e.message || e}</p>`;
    }
};

// 任务列表相关代码已删除

// 账号管理页面
function renderAccountManager() {
    const wrap = $('accounts-list');
    const summary = $('account-summary');
    const activeAccounts = accounts.filter(a => !a._pendingDelete);
    if (summary) summary.textContent = `共 ${activeAccounts.length} 个账号`;
    const isAdmin = currentUser && currentUser.role === 'admin';
    // 控制"清除待删除账号"按钮
    const btnClear = document.getElementById('btn-clear-pending-accounts');
    if (btnClear) {
        const hasPending = accounts.some(a => a._pendingDelete);
        btnClear.style.display = (isAdmin && hasPending) ? '' : 'none';
        btnClear.onclick = () => {
            const count = accounts.filter(a => a._pendingDelete).length;
            if (confirm(`确定立即删除全部 ${count} 个待删除账号？此操作不可撤销。`)) {
                clearAllPendingAccounts();
            }
        };
    }

    wrap.innerHTML = accounts.map(a => {
        const isPending = !!a._pendingDelete;
        const pendingBadge = isPending
            ? `<span class="pending-delete-badge"><i class="fas fa-clock"></i> 待删除 ${a._deleteRemainHours || 0}h后清除</span>`
            : '';
        // 管理员显示账号归属用户名
        let ownerBadge = '';
        if (isAdmin && a.userId) {
            const owner = (typeof users !== 'undefined' ? users : []).find(u => u.id === a.userId);
            const ownerName = owner ? owner.username : a.userId;
            ownerBadge = `<span class="acc-owner-badge"><i class="fas fa-user"></i> ${escapeHtml(ownerName)}</span>`;
        }
        return `
        <div class="acc-item${isPending ? ' pending-delete' : ''}">
            <div class="name">${escapeHtml(a.name)}${pendingBadge}${ownerBadge}</div>
            <div class="acc-actions">
                ${isPending ? '' : (a.running
                    ? `<button class="btn acc-btn acc-btn-stop" onclick="stopAccount('${a.id}')">停止</button>`
                    : `<button class="btn btn-primary acc-btn" onclick="startAccount('${a.id}')">启动</button>`
                )}
                ${isPending ? '' : `<button class="btn btn-primary acc-btn" onclick="editAccount('${a.id}')">编辑</button>`}
                ${isPending
                    ? (isAdmin ? `<button class="btn acc-btn acc-btn-danger" onclick="forceDeleteAccount('${a.id}')">立即删除</button>` : '')
                    : `<button class="btn acc-btn acc-btn-danger" onclick="deleteAccount('${a.id}')">删除</button>`
                }
            </div>
        </div>`;
    }).join('');
}

async function pollAccountLogs() {
    return runDedupedRequest('pollAccountLogs', async () => {
        const wrap = $('account-logs-list');
        if (!wrap) return;
        const list = await api('/api/account-logs?limit=100');
        const normalized = Array.isArray(list) ? list : [];
        if (!normalized.length) {
            lastAccountLogsRenderKey = '';
            wrap.innerHTML = '<div class="log-row">暂无账号日志</div>';
            return;
        }
        const renderKey = JSON.stringify(normalized.map(l => [l.time, l.action, l.msg, l.reason || '']));
        if (renderKey === lastAccountLogsRenderKey) return;
        lastAccountLogsRenderKey = renderKey;
        wrap.innerHTML = normalized.slice().reverse().map(l => {
            const actionMap = {
                add: '添加',
                update: '更新',
                delete: '删除',
                kickout_delete: '踢下线删除',
                ws_400: '登录失效',
            };
            const action = actionMap[l.action] || l.action || '操作';
            const timeStr = ((l.time || '').split(' ')[1] || (l.time || ''));
            const reason = l.reason ? ` (原因: ${escapeHtml(String(l.reason))})` : '';
            return `<div class="log-row">
                <span class="log-time">${escapeHtml(timeStr)}</span>
                <span class="log-tag">[${action}]</span>
                <span class="log-msg">${escapeHtml(l.msg || '')}${reason}</span>
            </div>`;
        }).join('');
    });
}

window.startAccount = async (id) => {
    await api(`/api/accounts/${id}/start`, 'POST');
    loadAccounts();
    pollAccountLogs();
    setTimeout(loadAccounts, 1000);
};

window.stopAccount = async (id) => {
    await api(`/api/accounts/${id}/stop`, 'POST');
    loadAccounts();
    pollAccountLogs();
    setTimeout(loadAccounts, 1000);
};

// ============ 天王模式 ============
function updateTheftKingOptionsVisibility() {
    const enabled = !!($('theft-king-enabled') && $('theft-king-enabled').checked);
    const optionsEl = $('theft-king-options');
    const statusEl = $('theft-king-status');
    if (optionsEl) optionsEl.style.display = enabled ? '' : 'none';
    if (statusEl) statusEl.style.display = enabled ? '' : 'none';
}

async function loadTheftKingConfig() {
    // 普通用户（user角色）完全不显示天王模式卡片
    const card = document.getElementById('card-theft-king');
    if (card) {
        const canSeeCard = currentUser && (currentUser.role === 'admin' || currentUser.role === 'vip');
        card.style.display = canSeeCard ? '' : 'none';
        if (!canSeeCard) return;
    }
    const tkEnabledEl = $('theft-king-enabled');
    if (!tkEnabledEl) return;
    const data = await api('/api/theft-king');
    if (data) {
        // 检查 VIP 权限
        const vipTip = $('theft-king-vip-tip');
        const canUse = data.canUse !== false; // 默认允许（兼容旧接口）
        if (vipTip) vipTip.style.display = canUse ? 'none' : '';
        tkEnabledEl.disabled = !canUse;
        const saveBtn = $('btn-save-theft-king');
        if (saveBtn) saveBtn.disabled = !canUse;

        tkEnabledEl.checked = !!data.enabled;
        if ($('theft-king-min-level')) $('theft-king-min-level').value = String(data.minPlantLevel || 10);
    }
    updateTheftKingOptionsVisibility();
    if ($('theft-king-enabled') && $('theft-king-enabled').checked) {
        await loadTheftKingStatus();
    }
}

async function loadTheftKingStatus() {
    const statusEl = $('theft-king-status');
    if (!statusEl) return;
    const data = await api('/api/theft-king/status');
    if (data) {
        if ($('theft-king-focus-count')) $('theft-king-focus-count').textContent = `重点: ${data.focusCount || 0} 人`;
        if ($('theft-king-camp-count')) $('theft-king-camp-count').textContent = `蹲点: ${data.campCount || 0} 人`;
        window._theftKingRunning = !!data.running;
        updateFriendActionsState();
    }
}

/** 根据天王模式状态更新好友操作按钮的可用状态 */
function updateFriendActionsState() {
    const running = !!window._theftKingRunning;
    document.querySelectorAll('.friend-actions .btn-help-op').forEach(btn => {
        btn.disabled = running;
        btn.title = running ? '天王模式运行中，帮助操作已暂停' : '';
    });
}

const tkEnabledEl = document.getElementById('theft-king-enabled');
if (tkEnabledEl) {
    tkEnabledEl.addEventListener('change', updateTheftKingOptionsVisibility);
}

const btnSaveTheftKing = document.getElementById('btn-save-theft-king');
if (btnSaveTheftKing) {
    btnSaveTheftKing.addEventListener('click', async () => {
        btnSaveTheftKing.disabled = true;
        try {
            const enabled = !!($('theft-king-enabled') && $('theft-king-enabled').checked);
            const minPlantLevel = Math.max(1, parseInt($('theft-king-min-level') && $('theft-king-min-level').value, 10) || 10);
            const ret = await api('/api/theft-king', 'POST', { enabled, minPlantLevel });
            if (!ret) { alert('保存失败'); return; }
            // 开启天王模式时自动开启智能采收
            if (enabled) {
                const smartEl = $('auto-smart-farm-schedule');
                if (smartEl && !smartEl.checked) {
                    smartEl.checked = true;
                    await api('/api/automation', 'POST', { smart_farm_schedule: true });
                }
            }
            updateTheftKingOptionsVisibility();
            if (enabled) await loadTheftKingStatus();
            else { window._theftKingRunning = false; updateFriendActionsState(); }
            alert('天王配置已保存');
        } finally {
            btnSaveTheftKing.disabled = false;
        }
    });
}

const btnRefreshTheftKingStatus = document.getElementById('btn-refresh-theft-king-status');
if (btnRefreshTheftKingStatus) {
    btnRefreshTheftKingStatus.addEventListener('click', loadTheftKingStatus);
}

// ============ 管理员 SMTP 发件配置 ============
async function loadAdminSmtpConfig() {
    const card = document.getElementById('card-admin-smtp');
    if (!card) return;
    const isAdmin = currentUser && currentUser.role === 'admin';
    card.style.display = isAdmin ? '' : 'none';
    if (!isAdmin) return;
    try {
        const data = await api('/api/admin-smtp');
        if (data) {
            if ($('admin-smtp-from')) $('admin-smtp-from').value = data.fromEmail || '';
            if ($('admin-smtp-pass')) $('admin-smtp-pass').value = data.smtpPassSet ? '••••••••••••••••' : '';
        }
    } catch (e) {
        console.error('加载管理员SMTP配置失败:', e);
    }
}

const btnSaveAdminSmtp = document.getElementById('btn-save-admin-smtp');
if (btnSaveAdminSmtp) {
    btnSaveAdminSmtp.addEventListener('click', async () => {
        const fromEmail = ($('admin-smtp-from') || {}).value || '';
        const rawPass = ($('admin-smtp-pass') || {}).value || '';
        if (!fromEmail.trim()) { alert('请填写发件邮箱'); return; }
        btnSaveAdminSmtp.disabled = true;
        try {
            const payload = { fromEmail: fromEmail.trim() };
            if (rawPass && !rawPass.startsWith('•')) {
                payload.smtpPass = rawPass.trim();
            }
            const ret = await api('/api/admin-smtp', 'POST', payload);
            if (ret) alert('邮件服务配置已保存');
        } catch (e) {
            alert('保存失败: ' + (e.message || ''));
        } finally {
            btnSaveAdminSmtp.disabled = false;
        }
    });
}

// ============ VIP SMTP 邮件配置 ============
async function loadVipSmtpConfig() {
    const card = $('card-qq-smtp');
    if (!card) return;
    // 只有 vip 和 admin 才显示此卡片
    const isVipOrAdmin = currentUser && (currentUser.role === 'vip' || currentUser.role === 'admin');
    card.style.display = isVipOrAdmin ? '' : 'none';
    if (!isVipOrAdmin) return;
    try {
        const data = await api('/api/vip-smtp');
        if (data) {
            if ($('vip-qq-num')) $('vip-qq-num').value = data.qq || '';
            if ($('vip-notify-offline')) $('vip-notify-offline').checked = !!data.notifyOffline;
            if ($('vip-notify-mature')) $('vip-notify-mature').checked = !!data.notifyMature;
        }
    } catch (e) {
        console.error('加载VIP SMTP配置失败:', e);
    }
}

const btnSaveVipSmtp = document.getElementById('btn-save-vip-smtp');
if (btnSaveVipSmtp) {
    btnSaveVipSmtp.addEventListener('click', async () => {
        const qq = ($('vip-qq-num') || {}).value || '';
        const notifyOffline = !!($('vip-notify-offline') || {}).checked;
        const notifyMature = !!($('vip-notify-mature') || {}).checked;
        if (!qq.trim()) { alert('请填写QQ号'); return; }
        btnSaveVipSmtp.disabled = true;
        try {
            const payload = { qq: qq.trim(), notifyOffline, notifyMature };
            const ret = await api('/api/vip-smtp', 'POST', payload);
            if (ret) alert('邮件提醒配置已保存');
        } catch (e) {
            alert('保存失败: ' + (e.message || ''));
        } finally {
            btnSaveVipSmtp.disabled = false;
        }
    });
}

// ============ 果实出售黑名单 ============
let fruitSellBlacklist = [];

window.loadFruitSellBlacklist = async function() {
    const tagsEl = $('fruit-sell-blacklist-tags');
    if (!tagsEl) return;
    try {
        const data = await api('/api/fruit-sell-blacklist');
        fruitSellBlacklist = Array.isArray(data) ? data : [];
        renderFruitSellBlacklistTags();
    } catch (e) { console.error(e); }
};

function renderFruitSellBlacklistTags() {
    const tagsEl = $('fruit-sell-blacklist-tags');
    if (!tagsEl) return;
    if (!fruitSellBlacklist.length) {
        tagsEl.innerHTML = '<span style="color:#888;font-size:12px">无（出售全部果实）</span>';
        return;
    }
    tagsEl.innerHTML = fruitSellBlacklist.map(name => `
        <span class="blacklist-tag">
            ${escapeHtml(name)}
            <span class="tag-remove" onclick="removeFruitSellBlacklist('${escapeHtml(name)}')" style="cursor:pointer;margin-left:4px;color:#f06f68">×</span>
        </span>
    `).join('');
}

window.addFruitSellBlacklist = function() {
    const input = $('fruit-sell-blacklist-input');
    if (!input) return;
    const name = input.value.trim();
    if (!name) return;
    if (!fruitSellBlacklist.includes(name)) fruitSellBlacklist.push(name);
    input.value = '';
    renderFruitSellBlacklistTags();
};

window.removeFruitSellBlacklist = function(name) {
    fruitSellBlacklist = fruitSellBlacklist.filter(n => n !== name);
    renderFruitSellBlacklistTags();
};

const btnSaveFruitSellBlacklist = document.getElementById('btn-save-fruit-sell-blacklist');
if (btnSaveFruitSellBlacklist) {
    btnSaveFruitSellBlacklist.addEventListener('click', async () => {
        btnSaveFruitSellBlacklist.disabled = true;
        try {
            await api('/api/fruit-sell-blacklist', 'POST', { fruitNames: fruitSellBlacklist });
            alert('不出售果实黑名单已保存');
        } finally {
            btnSaveFruitSellBlacklist.disabled = false;
        }
    });
}

const fruitSellInput = document.getElementById('fruit-sell-blacklist-input');
if (fruitSellInput) {
    fruitSellInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); window.addFruitSellBlacklist(); }
    });
}

// ============ 注册配置多邀请码管理 ============
let _inviteCodes = [];

window.loadRegisterConfig = async function() {
    const section = $('register-config-section');
    if (!section) return;
    try {
        const data = await api('/api/register-config');
        if (data) {
            if ($('reg-enabled')) $('reg-enabled').checked = !!data.enabled;
            if ($('reg-max-users')) $('reg-max-users').value = String(data.maxUsers || 0);
            _inviteCodes = Array.isArray(data.inviteCodes) ? data.inviteCodes : [];
            renderInviteCodes();
        }
    } catch (e) { console.error('加载注册配置失败:', e); }
};

function renderInviteCodes() {
    const list = $('invite-codes-list');
    if (!list) return;
    if (!_inviteCodes.length) {
        list.innerHTML = '<div style="color:#888;font-size:12px;margin-bottom:4px">无邀请码（公开注册）</div>';
        return;
    }
    list.innerHTML = _inviteCodes.map((ic, idx) => `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
            <span class="blacklist-tag" style="font-size:13px">${escapeHtml(ic.code)}</span>
            <span style="font-size:12px;color:#888">已用 ${ic.usedCount || 0}${ic.maxUses > 0 ? ` / ${ic.maxUses}` : ' / 不限'} 次</span>
            <button class="btn btn-sm" style="padding:1px 8px;font-size:12px" onclick="removeInviteCode(${idx})">删除</button>
        </div>
    `).join('');
}

window.addInviteCode = function() {
    const codeEl = $('new-invite-code');
    const maxEl = $('new-invite-max-uses');
    if (!codeEl) return;
    const code = codeEl.value.trim();
    if (!code) { alert('邀请码不能为空'); return; }
    if (_inviteCodes.some(ic => ic.code === code)) { alert('邀请码已存在'); return; }
    const maxUses = Math.max(0, parseInt(maxEl ? maxEl.value : 0, 10) || 0);
    _inviteCodes.push({ code, maxUses, usedCount: 0 });
    codeEl.value = '';
    if (maxEl) maxEl.value = '0';
    renderInviteCodes();
};

window.removeInviteCode = function(idx) {
    _inviteCodes.splice(idx, 1);
    renderInviteCodes();
};

const btnSaveRegConfig = document.getElementById('btn-save-reg-config');
if (btnSaveRegConfig) {
    btnSaveRegConfig.addEventListener('click', async () => {
        const enabled = !!($('reg-enabled') && $('reg-enabled').checked);
        const maxUsers = parseInt(($('reg-max-users') || {}).value || '0', 10) || 0;
        btnSaveRegConfig.disabled = true;
        try {
            await api('/api/register-config', 'POST', { enabled, inviteCodes: _inviteCodes, maxUsers });
            alert('注册设置已保存');
        } catch (e) {
            alert('保存失败: ' + (e.message || ''));
        } finally {
            btnSaveRegConfig.disabled = false;
        }
    });
}

// 模态框逻辑
const modal = $('modal-add-acc');

function showToast(msg, duration) {
    duration = (typeof duration === 'number' && duration > 0) ? duration : 2000;
    let t = document.getElementById('__bag_toast__');
    if (!t) {
        t = document.createElement('div');
        t.id = '__bag_toast__';
        t.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,0.82);color:#fff;padding:16px 32px;border-radius:16px;font-size:18px;font-weight:600;z-index:9999;pointer-events:none;transition:opacity 0.3s;text-align:center;max-width:80vw;line-height:1.5;box-shadow:0 4px 24px rgba(0,0,0,0.4)';
        document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(t.__timer);
    t.__timer = setTimeout(() => { t.style.opacity = '0'; }, duration);
}
