/**
 * 牧场模块前端逻辑
 * 依赖：core.js 中的 api()、escapeHtml()、showToast()、currentAccountId
 */

/* ============ 状态 ============ */
let _ranchConfig = null;   // 静态品种配置（一次加载）
let _ranchState  = null;   // 当前账号牧场状态
let _quizState   = null;   // 当前测验状态 { breedId, questions, answers }

/* ============ 数据加载 ============ */

async function loadRanchConfig() {
    if (_ranchConfig) return _ranchConfig;
    try {
        const res = await fetch('/api/ranch/config', {
            headers: {
                'x-admin-token': adminToken || '',
                'Content-Type': 'application/json',
            },
        });
        const j = await res.json();
        if (j && j.ok && j.data) _ranchConfig = j.data;
    } catch (e) {
        console.error('[Ranch] 加载配置失败', e);
    }
    return _ranchConfig;
}

async function loadRanchState() {
    if (!currentAccountId) return null;
    try {
        const res = await fetch('/api/ranch/state', {
            headers: {
                'x-admin-token': adminToken || '',
                'x-account-id': currentAccountId,
                'Content-Type': 'application/json',
            },
        });
        const j = await res.json();
        if (j && j.ok && j.data) _ranchState = j.data;
    } catch (e) {
        console.error('[Ranch] 加载状态失败', e);
    }
    return _ranchState;
}

async function loadRanch() {
    const wrap = $('ranch-tab-content');
    if (wrap) wrap.innerHTML = '<div class="ranch-empty"><i class="fas fa-spinner fa-spin"></i> 加载中...</div>';

    if (!currentAccountId) {
        if (wrap) wrap.innerHTML = '<div class="ranch-empty"><i class="fas fa-user-slash"></i> 请先选择账号</div>';
        return;
    }

    _ranchState = null; // 切换账号时重置状态
    _currentRanchTab = 'encyclopedia'; // 切换账号时重置到默认 tab
    await Promise.all([loadRanchConfig(), loadRanchState()]);
    renderRanchPage();
}

/* ============ 主渲染 ============ */

function renderRanchPage() {
    const cfg = _ranchConfig;
    const state = _ranchState;
    const wrap = $('ranch-tab-content');

    if (!cfg) {
        if (wrap) wrap.innerHTML = '<div class="ranch-empty"><i class="fas fa-exclamation-triangle"></i> 品种配置加载失败，请检查服务器是否已重启</div>';
        return;
    }
    if (!state) {
        if (wrap) wrap.innerHTML = '<div class="ranch-empty"><i class="fas fa-exclamation-triangle"></i> 牧场状态加载失败，请先选择账号或刷新重试</div>';
        return;
    }

    renderRanchHeader(state);
    renderRanchTabs();
}

function renderRanchHeader(state) {
    const goldEl = $('ranch-gold');
    if (goldEl) goldEl.textContent = (state.gold || 0).toLocaleString();
    // 邮件红点
    const badge = $('ranch-mail-badge');
    if (badge) {
        const unread = state.mailUnread || 0;
        badge.style.display = unread > 0 ? '' : 'none';
        badge.textContent = unread > 9 ? '9+' : (unread > 0 ? String(unread) : '●');
    }
}

/* ============ Tab 切换 ============ */

let _currentRanchTab = 'encyclopedia';

function renderRanchTabs() {
    switchRanchTab(_currentRanchTab, false);
}

function switchRanchTab(tab, scroll) {
    _currentRanchTab = tab;
    document.querySelectorAll('.ranch-tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    const content = $('ranch-tab-content');
    if (!content) return;

    if (tab === 'encyclopedia') renderEncyclopedia(content);
    else if (tab === 'shop') renderShop(content);
    else if (tab === 'mylivestock') renderMyLivestock(content);
    else if (tab === 'education') renderEducation(content);
    else if (tab === 'warehouse') renderWarehouse(content);
    else if (tab === 'mailbox') renderMailbox(content);

    if (scroll) content.scrollTop = 0;
}

/* ============ 图鉴 ============ */

function renderEncyclopedia(container) {
    const cfg = _ranchConfig;
    const state = _ranchState;
    if (!cfg || !state) return;

    let html = '';
    for (const cat of cfg.categories) {
        const breeds = cfg.breeds.filter(b => b.categoryId === cat.id)
            .sort((a, b) => a.unlockOrder - b.unlockOrder);
        if (!breeds.length) continue;

        html += `<div class="ranch-category-block">
            <div class="ranch-cat-title">
                <span class="ranch-cat-icon">${cat.icon}</span>
                <span>${escapeHtml(cat.name)}</span>
            </div>
            <div class="ranch-breed-grid">`;

        for (const breed of breeds) {
            const entry = state.encyclopedia[breed.id] || {};
            const unlocked = !!entry.unlocked;
            const breedSuccess = !!entry.breedSuccess;
            const bookOwned = !!entry.bookOwned;
            const needFeed = !!entry.needFeed;
            const diseased = !!entry.diseased;
            const breedCount = entry.breedCount || 0;
            const target = breed.breedTarget || 4;

            // 稀有度星星（原有）
            const stars = '★'.repeat(breed.rarity || 1) + '☆'.repeat(Math.max(0, 3 - (breed.rarity || 1)));

            // 繁育难度星星（与稀有度同格式：5格，filled+empty）
            const diff = breed.breedDifficulty || 1;
            const diffStars = '★'.repeat(diff) + '☆'.repeat(5 - diff);

            // 锁定原因提示
            let lockHint = '';
            if (!unlocked) {
                const req = breed.unlockRequires;
                if (!req) {
                    lockHint = '点击解锁';
                } else if (req.type === 'prevConserved') {
                    const prevBreed = cfg.breeds.find(b => b.id === req.breedId);
                    lockHint = `需「${prevBreed ? prevBreed.name : ''}」保种✓`;
                } else if (req.type === 'anyConserved') {
                    const ed = req.exactDiff || req.maxDiff || 2;
                    lockHint = `需任意${ed}★品种保种✓`;
                }
            }

            // 状态角标
            let badges = '';
            if (breedSuccess) badges += '<span class="breed-badge success">保种✓</span>';
            if (bookOwned) badges += '<span class="breed-badge book">📖</span>';
            if (diseased) badges += `<span class="breed-badge disease" title="点击治病" style="cursor:pointer" onclick="event.stopPropagation();switchRanchTab('mylivestock',true)">病</span>`;
            if (needFeed && unlocked) badges += `<span class="breed-badge hungry" title="点击喂食" style="cursor:pointer" onclick="event.stopPropagation();doFeedBreed('${escapeHtml(breed.id)}')">饿</span>`;

            html += `<div class="ranch-breed-card ${unlocked ? 'unlocked' : 'locked'}" data-breed="${escapeHtml(breed.id)}">
                <div class="breed-card-img-wrap">
                    ${unlocked
                        ? `<img src="${escapeHtml(breed.image)}" alt="${escapeHtml(breed.name)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none'">`
                        : `<div class="breed-locked-icon">🔒<div class="lock-hint">${escapeHtml(lockHint)}</div></div>`
                    }
                    <div class="breed-badges">${badges}</div>
                </div>
                <div class="breed-card-body">
                    <div class="breed-name">${escapeHtml(breed.name)}</div>
                    <div class="breed-stars">${diffStars}</div>
                    <div class="breed-origin">📍${escapeHtml(breed.origin)}</div>
                    ${unlocked ? `<div class="breed-progress">
                        <div class="breed-prog-bar"><div class="breed-prog-fill" style="width:${Math.min(100, breedCount / target * 100)}%"></div></div>
                        <span class="breed-prog-text">${breedCount}/${target}</span>
                    </div>` : ''}
                    <div class="breed-actions">
                        ${!unlocked ? `<button class="btn btn-sm btn-primary" onclick="doUnlockBreed('${escapeHtml(breed.id)}')">解锁</button>` : ''}
                        ${unlocked && !breedSuccess ? `<button class="btn btn-sm btn-primary" onclick="doBreed('${escapeHtml(breed.id)}')">繁殖</button>` : ''}
                        ${unlocked ? `<button class="btn btn-sm" onclick="showBreedDetail('${escapeHtml(breed.id)}')">详情</button>` : ''}
                        ${unlocked ? `<button class="btn btn-sm" onclick="openQuiz('${escapeHtml(breed.id)}')">答题</button>` : ''}
                    </div>
                </div>
            </div>`;
        }
        html += '</div></div>';
    }

    container.innerHTML = html || '<div class="ranch-empty">暂无品种数据</div>';
}

/* ============ 仓库 ============ */

async function renderWarehouse(container) {
    container.innerHTML = '<div class="ranch-empty"><i class="fas fa-spinner fa-spin"></i> 加载仓库...</div>';
    const res = await _ranchFetch('/api/ranch/warehouse');
    if (!res || !res.ok) {
        container.innerHTML = '<div class="ranch-empty">加载失败，请重试</div>';
        return;
    }
    const cfg = _ranchConfig;
    const own = res.own || [];
    const received = res.received || [];

    let html = '<div class="warehouse-wrap">';

    // 自购物品
    html += '<div class="warehouse-section-title"><i class="fas fa-shopping-bag"></i> 自购物品</div>';
    if (!own.length) {
        html += '<div class="warehouse-empty-tip">暂无物品，前往商店购买</div>';
    } else {
        html += '<div class="warehouse-grid">';
        for (const item of own) {
            html += `<div class="warehouse-item">
                <div class="warehouse-item-icon">${escapeHtml(item.icon)}</div>
                <div class="warehouse-item-name">${escapeHtml(item.name)}</div>
                <div class="warehouse-item-count">x${item.count}</div>
            </div>`;
        }
        html += '</div>';
    }

    // 收到的保种书籍
    html += '<div class="warehouse-section-title" style="margin-top:16px"><i class="fas fa-book"></i> 收到的保种书籍</div>';
    if (!received.length) {
        html += '<div class="warehouse-empty-tip">暂无收到的书籍</div>';
    } else {
        html += '<div class="warehouse-book-list">';
        for (const book of received) {
            const d = new Date(book.receivedAt);
            const dateStr = `${d.getMonth()+1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')}`;
            html += `<div class="warehouse-book-item">
                <div class="warehouse-book-icon">📖</div>
                <div class="warehouse-book-info">
                    <div class="warehouse-book-name">《${escapeHtml(book.breedName)}保种经验》</div>
                    <div class="warehouse-book-from">来自：${escapeHtml(book.fromName)} · ${dateStr}</div>
                </div>
                <div class="warehouse-book-bonus">+25%</div>
            </div>`;
        }
        html += '</div>';
    }
    html += '</div>';
    container.innerHTML = html;
}

/* ============ 邮件箱 ============ */

async function renderMailbox(container) {
    container.innerHTML = '<div class="ranch-empty"><i class="fas fa-spinner fa-spin"></i> 加载邮件...</div>';
    const res = await _ranchFetch('/api/ranch/mailbox');
    if (!res || !res.ok) {
        container.innerHTML = '<div class="ranch-empty">加载失败，请重试</div>';
        return;
    }
    const mails = res.mails || [];
    if (!mails.length) {
        container.innerHTML = '<div class="ranch-empty"><i class="fas fa-envelope-open"></i> 暂无邮件</div>';
        return;
    }

    let html = '<div class="mailbox-wrap">';
    for (const mail of [...mails].reverse()) {
        const d = new Date(mail.sentAt);
        const dateStr = `${d.getMonth()+1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')}`;
        html += `<div class="mail-item ${mail.claimed ? 'claimed' : 'unclaimed'}">
            <div class="mail-icon">${mail.type === 'book' ? '📖' : '📬'}</div>
            <div class="mail-info">
                <div class="mail-title">${mail.type === 'book' ? `《${escapeHtml(mail.breedName)}保种经验》` : escapeHtml(mail.type)}</div>
                <div class="mail-from">来自：${escapeHtml(mail.fromName)} · ${dateStr}</div>
                ${mail.type === 'book' ? '<div class="mail-desc">领取后该品种繁育加成 +25%</div>' : ''}
            </div>
            <div class="mail-action">
                ${mail.claimed
                    ? '<span class="mail-claimed-tag">已领取</span>'
                    : `<button class="btn btn-sm btn-primary" onclick="doClaimMail('${escapeHtml(mail.id)}')">领取</button>`
                }
            </div>
        </div>`;
    }
    html += '</div>';
    container.innerHTML = html;
}

async function doClaimMail(mailId) {
    const res = await _ranchFetch('/api/ranch/mail/claim', 'POST', { mailId });
    if (!res) { showToast('网络错误', 'error'); return; }
    showToast(res.msg || (res.ok ? '领取成功' : '领取失败'), res.ok ? 'success' : 'error');
    if (res.ok) {
        await loadRanchState();
        renderRanchHeader(_ranchState);
        renderMailbox($('ranch-tab-content'));
    }
}

/* ============ 商店 ============ */

function renderShop(container) {
    const cfg = _ranchConfig;
    const state = _ranchState;
    if (!cfg || !state) return;

    const gold = state.gold || 0;
    let html = `<div class="shop-gold-bar"><i class="fas fa-coins"></i> 当前牧场金币：<strong>${gold.toLocaleString()}</strong></div>`;

    html += '<div class="shop-section-title">饲料</div><div class="shop-grid">';
    for (const feed of cfg.feeds) {
        const owned = state.inventory[feed.id] || 0;
        html += renderShopItem(feed, owned);
    }
    html += '</div>';

    html += '<div class="shop-section-title">兽药</div><div class="shop-grid">';
    for (const med of cfg.medicines) {
        const owned = state.inventory[med.id] || 0;
        html += renderShopItem(med, owned);
    }
    html += '</div>';

    container.innerHTML = html;
}

function renderShopItem(item, owned) {
    return `<div class="shop-item">
        <div class="shop-item-icon">${escapeHtml(item.icon || '📦')}</div>
        <div class="shop-item-name">${escapeHtml(item.name)}</div>
        <div class="shop-item-desc">${escapeHtml(item.desc || '')}</div>
        <div class="shop-item-footer">
            <span class="shop-item-price"><i class="fas fa-coins"></i> ${item.price}</span>
            <span class="shop-item-owned">库存 ${owned}</span>
        </div>
        <div class="shop-item-buy">
            <input type="number" class="shop-qty" id="qty-${escapeHtml(item.id)}" value="1" min="1" max="99" style="width:48px">
            <button class="btn btn-sm btn-primary" onclick="doBuyItem('${escapeHtml(item.id)}')">购买</button>
        </div>
    </div>`;
}

/* ============ 我的牲畜 ============ */

function renderMyLivestock(container) {
    const cfg = _ranchConfig;
    const state = _ranchState;
    if (!cfg || !state) return;

    const unlockedBreeds = cfg.breeds.filter(b => {
        const e = state.encyclopedia[b.id];
        return e && e.unlocked;
    });

    if (!unlockedBreeds.length) {
        container.innerHTML = '<div class="ranch-empty">还未解锁任何品种，前往「图鉴」解锁第一个品种吧！</div>';
        return;
    }

    let html = '';
    for (const breed of unlockedBreeds) {
        const entry = state.encyclopedia[breed.id];
        const diseaseInfo = state.disease && state.disease[breed.id];
        const cat = cfg.categories.find(c => c.id === breed.categoryId);
        const feedItem = cat ? cfg.feeds.find(f => f.id === cat.feedType) : null;
        const feedOwned = feedItem ? (state.inventory[feedItem.id] || 0) : 0;
        const needFeed = !!entry.needFeed;

        // 繁殖冷却
        const cdSec = entry.breedCdRemainSec || 0;
        const cdText = cdSec > 0 ? `冷却 ${fmtRanchSec(cdSec)}` : '可繁殖';

        // 状态标签
        let statusBadges = '';
        if (needFeed) statusBadges += '<span class="breed-badge hungry" title="需要喂食">饿</span>';
        if (diseaseInfo) statusBadges += '<span class="breed-badge disease" title="牲畜患病">病</span>';

        html += `<div class="livestock-card ${diseaseInfo ? 'diseased' : ''}">
            <div class="livestock-header">
                <img src="${escapeHtml(breed.image)}" alt="${escapeHtml(breed.name)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none'" class="livestock-avatar">
                <div class="livestock-info">
                    <div class="livestock-name">${cat ? cat.icon : ''} ${escapeHtml(breed.name)}${statusBadges ? ' ' + statusBadges : ''}</div>
                    <div class="livestock-origin">📍${escapeHtml(breed.origin)}</div>
                    ${diseaseInfo ? `<div class="livestock-disease">⚠️ 患病：${escapeHtml(diseaseInfo.disease)}</div>` : ''}
                </div>
            </div>
            <div class="livestock-stats">
                <div class="stat-row">
                    <span>公 🐾 健康</span>
                    <div class="health-bar"><div class="health-fill" style="width:${entry.male.health || 0}%"></div></div>
                    <span>${entry.male.health || 0}%</span>
                </div>
                <div class="stat-row">
                    <span>母 🐾 健康</span>
                    <div class="health-bar"><div class="health-fill female" style="width:${entry.female.health || 0}%"></div></div>
                    <span>${entry.female.health || 0}%</span>
                </div>
                <div class="stat-row">
                    <span>繁殖进度</span>
                    <div class="breed-prog-bar"><div class="breed-prog-fill" style="width:${Math.min(100,(entry.breedCount||0)/(breed.breedTarget||4)*100)}%"></div></div>
                    <span>${entry.breedCount || 0}/${breed.breedTarget || 4}</span>
                </div>
                ${entry.growthBonus > 0 ? `<div class="stat-bonus">🚀 繁育加成 +${entry.growthBonus}%</div>` : ''}
                ${entry.bookOwned ? '<div class="stat-bonus">📖 持有保种书籍（可赠出）</div>' : ''}
            </div>
            <div class="livestock-actions">
                <button class="btn btn-sm" onclick="doFeedBreed('${escapeHtml(breed.id)}')"
                    title="${feedItem ? feedItem.name + ' 库存:' + feedOwned : '喂食'}">
                    🌾 喂食${feedOwned > 0 ? '' : '（缺料）'}
                </button>
                ${diseaseInfo ? renderMedicineButtons(breed, cfg) : ''}
                ${!entry.breedSuccess ? `<button class="btn btn-sm btn-primary" onclick="doBreed('${escapeHtml(breed.id)}')" title="${cdText}">
                    🐣 繁殖${cdSec > 0 ? '（' + cdText + '）' : ''}
                </button>` : '<span class="breed-done-tag">✅ 保种完成</span>'}
                <button class="btn btn-sm" onclick="openQuiz('${escapeHtml(breed.id)}')">📝 答题</button>
                ${entry.bookOwned ? `<button class="btn btn-sm" onclick="openGiftBook('${escapeHtml(breed.id)}')">🎁 赠书</button>` : ''}
            </div>
        </div>`;
    }

    container.innerHTML = html;
}

function renderMedicineButtons(breed, cfg) {
    const meds = cfg.medicines.filter(m => m.targetCategories.includes(breed.categoryId));
    return meds.map(m => {
        const owned = (_ranchState.inventory[m.id] || 0);
        return `<button class="btn btn-sm btn-danger" onclick="doTreat('${escapeHtml(breed.id)}','${escapeHtml(m.id)}')"
            title="${m.desc}（库存:${owned}）">${m.icon} ${escapeHtml(m.name)}</button>`;
    }).join('');
}

/* ============ 教育/答题 ============ */

function renderEducation(container) {
    const cfg = _ranchConfig;
    const state = _ranchState;
    if (!cfg || !state) return;

    // 只取有题目的品种
    const breedsWithQuiz = cfg.breeds.filter(b => b.quiz && b.quiz.length > 0);
    if (!breedsWithQuiz.length) {
        container.innerHTML = '<div class="ranch-empty">暂无可答题品种</div>';
        return;
    }

    const now = Date.now();
    const QUIZ_CD_MS = 2 * 60 * 1000;

    let html = '<div class="edu-list">';
    for (const breed of breedsWithQuiz) {
        const entry = state.encyclopedia[breed.id] || {};
        const unlocked = !!entry.unlocked;

        if (!unlocked) {
            // 未解锁：显示锁定占位，不暴露任何详情
            html += `<div class="edu-item edu-item-locked">
                <div class="edu-item-img edu-locked-img">
                    <span class="edu-lock-icon">🔒</span>
                </div>
                <div class="edu-item-info">
                    <div class="edu-item-name" style="color:var(--text-muted)">未解锁品种</div>
                    <div class="edu-item-meta" style="color:var(--text-muted)">解锁图鉴后可参与答题</div>
                </div>
                <div class="edu-item-action">
                    <button class="btn btn-sm" disabled style="opacity:.45">未解锁</button>
                </div>
            </div>`;
            continue;
        }

        const passed = !!entry.quizPassed;
        const bonus = entry.growthBonus || 0;
        const lastAt = entry.lastQuizAt || 0;
        const cdRemainMs = lastAt ? Math.max(0, QUIZ_CD_MS - (now - lastAt)) : 0;
        const onCd = cdRemainMs > 0;
        const cdText = onCd ? `冷却 ${fmtRanchSec(Math.ceil(cdRemainMs / 1000))}` : '';
        const lastAtText = lastAt ? new Date(lastAt).toLocaleString() : '从未答题';

        html += `<div class="edu-item">
            <div class="edu-item-img">
                <img src="${escapeHtml(breed.image)}" alt="${escapeHtml(breed.name)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none'">
            </div>
            <div class="edu-item-info">
                <div class="edu-item-name">${escapeHtml(breed.name)}</div>
                <div class="edu-item-meta">📍${escapeHtml(breed.origin)} · ${breed.quiz.length} 道题</div>
                <div class="edu-item-status">
                    ${passed ? '<span class="edu-passed">✅ 已通关</span>' : '<span class="edu-notpass">待挑战</span>'}
                    ${bonus > 0 ? `<span class="edu-bonus">🚀 加成 +${bonus}%</span>` : ''}
                    ${onCd
                        ? `<span class="edu-cd">⏳ ${cdText}</span>`
                        : `<span class="edu-last">上次：${lastAtText}</span>`
                    }
                </div>
            </div>
            <div class="edu-item-action">
                ${onCd
                    ? `<button class="btn btn-sm" disabled style="opacity:.45" title="冷却中，${cdText}">${cdText}</button>`
                    : `<button class="btn btn-sm btn-primary" onclick="openQuiz('${escapeHtml(breed.id)}')">开始答题</button>`
                }
            </div>
        </div>`;
    }
    html += '</div>';

    container.innerHTML = html;
}

/* ============ 品种详情弹窗 ============ */

function showBreedDetail(breedId) {
    const cfg = _ranchConfig;
    const state = _ranchState;
    if (!cfg || !state) return;
    const breed = cfg.breeds.find(b => b.id === breedId);
    if (!breed) return;
    const entry = state.encyclopedia[breedId] || {};
    const cat = cfg.categories.find(c => c.id === breed.categoryId);

    const modal = $('ranch-detail-modal');
    const body = $('ranch-detail-body');
    if (!modal || !body) return;

    const stars = '★'.repeat(breed.rarity || 1) + '☆'.repeat(Math.max(0, 3 - (breed.rarity || 1)));
    const diff = breed.breedDifficulty || 1;
    const diffStars = '★'.repeat(diff) + '☆'.repeat(5 - diff);
    body.innerHTML = `
        <div class="breed-detail-wrap">
            <div class="breed-detail-top">
                <img src="${escapeHtml(breed.image)}" alt="${escapeHtml(breed.name)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none'" class="breed-detail-img">
                <div class="breed-detail-meta">
                    <div class="breed-detail-name">${cat ? cat.icon : ''} ${escapeHtml(breed.name)}</div>
                    <div class="breed-detail-diff">繁育难度：<span class="diff-val">${diffStars}</span></div>
                    <div class="breed-detail-origin">📍 产地：${escapeHtml(breed.origin)}</div>
                    <div class="breed-detail-traits">${(breed.traits || []).map(t => `<span class="trait-tag">${escapeHtml(t)}</span>`).join('')}</div>
                    <a href="${escapeHtml(breed.wikiUrl)}" target="_blank" class="wiki-link">📖 查看百科</a>
                </div>
            </div>
            <div class="breed-detail-desc">${escapeHtml(breed.desc || '')}</div>
            <div class="breed-detail-game">
                <div class="detail-stat"><span>繁殖冷却</span><strong>${breed.breedDays} 天</strong></div>
                <div class="detail-stat"><span>保种目标</span><strong>${breed.breedTarget} 次</strong></div>
                <div class="detail-stat"><span>每日饲料</span><strong>${breed.feedPerDay} 份</strong></div>
                <div class="detail-stat"><span>常见疾病</span><strong>${(breed.diseaseRisk || []).join('、')}</strong></div>
                <div class="detail-stat"><span>当前繁殖</span><strong>${entry.breedCount || 0}/${breed.breedTarget || 4}</strong></div>
                <div class="detail-stat"><span>答题加成</span><strong>+${entry.quizBonus || 0}%</strong></div>
                <div class="detail-stat"><span>笔记加成</span><strong>+${entry.bookBonus || 0}%</strong></div>
                <div class="detail-stat"><span>总繁育加成</span><strong>+${entry.growthBonus || 0}%</strong></div>
            </div>
            ${entry.bookOwned ? `<div class="breed-strategy-block" style="display:flex;align-items:center;justify-content:space-between">
                <div><div class="strategy-title">📖 持有保种书籍</div><div class="strategy-text">可赠送给其他账号，对方领取后繁育加成 +25%（赠出后书籍从本账号消耗）</div></div>
                <button class="btn btn-sm btn-primary" style="margin-left:12px;white-space:nowrap" onclick="closeRanchDetailModal();openGiftBook('${escapeHtml(breed.id)}')">赠送书籍</button>
            </div>` : ''}
            ${breed.breedStrategy ? `<div class="breed-strategy-block"><div class="strategy-title">🌱 繁育要点</div><div class="strategy-text">${escapeHtml(breed.breedStrategy)}</div></div>` : ''}
            ${breed.conserveStrategy ? `<div class="breed-strategy-block"><div class="strategy-title">🛡️ 保种策略</div><div class="strategy-text">${escapeHtml(breed.conserveStrategy.replace(/(累计繁殖|繁殖)\d+次/, '$1' + breed.breedTarget + '次'))}</div></div>` : ''}
        </div>`;
    document.body.appendChild(modal);
    modal.classList.add('show');
}

function closeRanchDetailModal() {
    const modal = $('ranch-detail-modal');
    if (modal) modal.classList.remove('show');
}

/* ============ 答题弹窗 ============ */

async function _ranchFetch(path, method = 'GET', body = null) {
    const headers = { 'Content-Type': 'application/json' };
    if (adminToken) headers['x-admin-token'] = adminToken;
    if (currentAccountId) headers['x-account-id'] = currentAccountId;
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    try {
        const r = await fetch(path, opts);
        if (r.status === 401) { setLoginState(false); return null; }
        return await r.json();
    } catch (e) {
        console.error('[Ranch] fetch error', e);
        return null;
    }
}

async function openQuiz(breedId) {
    const res = await _ranchFetch(`/api/ranch/quiz/${breedId}`);
    if (!res) { showToast('网络错误，请重试', 'error'); return; }
    if (!res.ok) { showToast(res.msg || '获取题目失败', 'warn'); return; }
    _quizState = { breedId, questions: res.questions, answers: new Array(res.questions.length).fill(null) };
    renderQuizModal(res.breedName, res.questions);
    const modal = $('ranch-quiz-modal');
    if (modal) {
        // 确保弹窗在 body 直接子级，避免被父容器 overflow/stacking context 影响
        document.body.appendChild(modal);
        modal.classList.add('show');
    }
}

function renderQuizModal(breedName, questions) {
    const body = $('ranch-quiz-body');
    if (!body) return;
    let html = `<div class="quiz-breed-name">📝 ${escapeHtml(breedName)} · 知识测验</div>
        <div class="quiz-tip">全部答对可获得该品种繁育速度 +50% 加成（每2分钟可答一次）</div>`;
    questions.forEach((q, i) => {
        html += `<div class="quiz-question" id="quiz-q-${i}">
            <div class="quiz-q-text">${i + 1}. ${escapeHtml(q.q)}</div>
            <div class="quiz-options">
                ${q.options.map((opt, j) => `
                    <label class="quiz-option" id="quiz-opt-${i}-${j}">
                        <input type="radio" name="quiz-q-${i}" value="${j}" onchange="selectQuizAnswer(${i},${j})">
                        <span>${escapeHtml(opt)}</span>
                    </label>`).join('')}
            </div>
        </div>`;
    });
    html += `<div class="quiz-footer">
        <button class="btn btn-primary" onclick="submitQuizAnswers()">提交答案</button>
        <button class="btn" onclick="closeQuizModal()">取消</button>
    </div>`;
    body.innerHTML = html;
}

function selectQuizAnswer(qIdx, optIdx) {
    if (!_quizState) return;
    _quizState.answers[qIdx] = optIdx;
}

async function submitQuizAnswers() {
    if (!_quizState) return;
    const unanswered = _quizState.answers.findIndex(a => a === null);
    if (unanswered >= 0) {
        showToast(`请先回答第 ${unanswered + 1} 题`, 'warn');
        return;
    }
    const res = await _ranchFetch(`/api/ranch/quiz/${_quizState.breedId}`, 'POST', { answers: _quizState.answers });
    if (!res) { showToast('提交失败，请重试', 'error'); return; }
    if (!res.ok) { showToast(res.msg || '提交失败', 'warn'); return; }

    // 显示每题对错高亮
    const body = $('ranch-quiz-body');
    if (body && res.results) {
        res.results.forEach((r, i) => {
            const qEl = document.getElementById(`quiz-q-${i}`);
            if (qEl) qEl.classList.add(r.correct ? 'quiz-correct' : 'quiz-wrong');
        });
    }
    showToast(res.msg || (res.allCorrect ? '全部答对！' : '未全对'), res.allCorrect ? 'success' : 'warn');

    setTimeout(() => {
        closeQuizModal();
        loadRanchState().then(renderRanchPage);
    }, 2000);
}

function closeQuizModal() {
    const modal = $('ranch-quiz-modal');
    if (modal) modal.classList.remove('show');
    _quizState = null;
}

/* ============ 赠书弹窗 ============ */

let _giftBookState = { breedId: null, breedName: null, allAccounts: [], selectedId: null };

async function openGiftBook(breedId) {
    const modal = $('ranch-giftbook-modal');
    if (!modal) return;

    // 找品种名称
    const breed = _ranchConfig && _ranchConfig.breeds.find(b => b.id === breedId);
    const breedName = breed ? breed.name : breedId;

    _giftBookState = { breedId, breedName, allAccounts: [], selectedId: null };

    // 展示品种信息
    const infoEl = $('giftbook-breed-info');
    if (infoEl) infoEl.innerHTML = `<div class="giftbook-breed-tag">📖 《${escapeHtml(breedName)}保种经验》</div>`;

    const searchEl = $('giftbook-search');
    if (searchEl) searchEl.value = '';

    const confirmBtn = $('giftbook-confirm-btn');
    if (confirmBtn) confirmBtn.disabled = true;

    const listEl = $('giftbook-account-list');
    if (listEl) listEl.innerHTML = '<div class="ranch-empty"><i class="fas fa-spinner fa-spin"></i> 加载账号列表...</div>';

    document.body.appendChild(modal);
    modal.classList.add('show');

    // 加载全服账号
    const res = await _ranchFetch('/api/ranch/all-accounts');
    if (!res || !res.ok) {
        if (listEl) listEl.innerHTML = '<div class="ranch-empty">加载失败，请重试</div>';
        return;
    }
    _giftBookState.allAccounts = res.accounts || [];
    renderGiftBookAccountList(_giftBookState.allAccounts);
}

function renderGiftBookAccountList(accounts) {
    const listEl = $('giftbook-account-list');
    if (!listEl) return;
    if (!accounts.length) {
        listEl.innerHTML = '<div class="ranch-empty">没有其他账号</div>';
        return;
    }
    listEl.innerHTML = accounts.map(a => `
        <div class="giftbook-account-item ${_giftBookState.selectedId === a.id ? 'selected' : ''}"
             onclick="selectGiftBookAccount('${escapeHtml(a.id)}','${escapeHtml(a.name)}')">
            <div class="giftbook-acc-name">${escapeHtml(a.name)}</div>
            ${a.uin ? `<div class="giftbook-acc-uin">QQ: ${escapeHtml(a.uin)}</div>` : ''}
        </div>`).join('');
}

function filterGiftBookAccounts() {
    const q = ($('giftbook-search') || {}).value || '';
    const filtered = _giftBookState.allAccounts.filter(a =>
        !q || a.name.toLowerCase().includes(q.toLowerCase()) || (a.uin || '').includes(q)
    );
    renderGiftBookAccountList(filtered);
}

function selectGiftBookAccount(id, name) {
    _giftBookState.selectedId = id;
    _giftBookState.selectedName = name;
    const confirmBtn = $('giftbook-confirm-btn');
    if (confirmBtn) confirmBtn.disabled = false;
    renderGiftBookAccountList(
        _giftBookState.allAccounts.filter(a => {
            const q = ($('giftbook-search') || {}).value || '';
            return !q || a.name.toLowerCase().includes(q.toLowerCase()) || (a.uin || '').includes(q);
        })
    );
}

async function confirmGiftBook() {
    const { breedId, selectedId } = _giftBookState;
    if (!breedId || !selectedId) { showToast('请选择收书账号', 'warn'); return; }

    // 当前账号名称作为赠送人
    const fromAccount = (typeof accounts !== 'undefined' && accounts) ? accounts.find(a => String(a.id) === String(currentAccountId)) : null;
    const fromName = fromAccount ? (fromAccount.name || fromAccount.uin || String(currentAccountId)) : String(currentAccountId);

    const res = await _ranchFetch('/api/ranch/gift-book', 'POST', { breedId, toAccountId: selectedId, fromName });
    showToast(res && res.msg || (res && res.ok ? '赠送成功' : '赠送失败'), res && res.ok ? 'success' : 'error');
    if (res && res.ok) closeGiftBookModal();
}

function closeGiftBookModal() {
    const modal = $('ranch-giftbook-modal');
    if (modal) modal.classList.remove('show');
    _giftBookState = { breedId: null, breedName: null, allAccounts: [], selectedId: null };
}

/* ============ 操作函数 ============ */

async function doUnlockBreed(breedId) {
    const res = await _ranchFetch('/api/ranch/unlock', 'POST', { breedId });
    if (!res) { showToast('网络错误，请重试', 'error'); return; }
    showToast(res.msg || (res.ok ? '解锁成功' : '解锁失败'), res.ok ? 'success' : 'error');
    if (res.ok) { await loadRanchState(); renderRanchPage(); }
}

async function doBreed(breedId) {
    const res = await _ranchFetch('/api/ranch/breed', 'POST', { breedId });
    if (!res) { showToast('网络错误，请重试', 'error'); return; }
    // bred: true = 本次繁殖计数+1；breedSuccess = 达成保种；ok: false = 操作失败（如未解锁等）
    let toastType = 'warn';
    if (!res.ok) toastType = 'error';
    else if (res.breedSuccess) toastType = 'success';
    else if (res.bred === false) toastType = 'info'; // 本次未成功，属于正常游戏事件
    else toastType = 'success';
    showToast(res.msg || (res.ok ? '操作完成' : '操作失败'), toastType);
    await loadRanchState();
    renderRanchPage();
}

async function doFeedBreed(breedId) {
    const res = await _ranchFetch('/api/ranch/feed', 'POST', { breedId });
    if (!res) { showToast('网络错误，请重试', 'error'); return; }
    showToast(res.msg || (res.ok ? '喂食成功' : '喂食失败'), res.ok ? 'success' : 'error');
    if (res.ok) { await loadRanchState(); renderRanchPage(); }
}

async function doTreat(breedId, medicineId) {
    const res = await _ranchFetch('/api/ranch/treat', 'POST', { breedId, medicineId });
    if (!res) { showToast('网络错误，请重试', 'error'); return; }
    showToast(res.msg || (res.ok ? '治疗成功' : '治疗失败'), res.ok ? 'success' : 'error');
    if (res.ok) { await loadRanchState(); renderRanchPage(); }
}

async function doBuyItem(itemId) {
    const qtyEl = document.getElementById(`qty-${itemId}`);
    const qty = qtyEl ? Math.max(1, parseInt(qtyEl.value) || 1) : 1;
    const res = await _ranchFetch('/api/ranch/buy', 'POST', { itemId, quantity: qty });
    if (!res) { showToast('网络错误，请重试', 'error'); return; }
    showToast(res.msg || (res.ok ? '购买成功' : '购买失败'), res.ok ? 'success' : 'error');
    if (res.ok) { await loadRanchState(); renderRanchPage(); }
}

/* ============ 工具函数 ============ */

function fmtRanchSec(sec) {
    if (sec <= 0) return '0s';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}h${m > 0 ? m + 'm' : ''}`;
    if (m > 0) return `${m}m${s > 0 ? s + 's' : ''}`;
    return `${s}s`;
}
