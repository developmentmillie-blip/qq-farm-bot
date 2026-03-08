/**
 * 防挂页面前端逻辑
 * 依赖：core.js 中的 api()、escapeHtml()、showToast()、currentAccountId、currentUser
 */

/* ============ API ============ */

async function _antiafkFetch(path, method, body) {
    const opts = {
        method: method || 'GET',
        headers: {
            'x-admin-token': typeof adminToken !== 'undefined' ? (adminToken || '') : '',
            'x-account-id': typeof currentAccountId !== 'undefined' ? (currentAccountId || '') : '',
            'Content-Type': 'application/json',
        },
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(path, opts);
    return res.json();
}

async function _getAntiafkStatus() {
    return _antiafkFetch('/api/antiafk/status');
}

async function _postAntiafkConfig(cfg) {
    return _antiafkFetch('/api/antiafk/config', 'POST', cfg);
}

async function _removeDog(gid) {
    return _antiafkFetch('/api/antiafk/remove-dog', 'POST', { gid });
}

/* ============ 渲染 ============ */

async function loadAntiafk() {
    const wrap = document.getElementById('page-antiafk');
    if (!wrap) return;

    if (!currentAccountId) {
        wrap.innerHTML = '<div class="antiafk-wrap"><div class="card"><div class="card-body" style="color:var(--text-secondary);text-align:center;padding:40px">请先选择账号</div></div></div>';
        return;
    }

    wrap.innerHTML = '<div class="antiafk-wrap"><div class="card"><div class="card-body" style="text-align:center;padding:40px"><i class="fas fa-spinner fa-spin"></i> 加载中...</div></div></div>';

    let status, smartFarmEnabled = false;
    try {
        const [j, sj] = await Promise.all([
            _getAntiafkStatus(),
            _antiafkFetch('/api/settings'),
        ]);
        if (!j || !j.ok) throw new Error(j && j.error ? j.error : '加载失败');
        status = j.data;
        if (sj && sj.ok && sj.data && sj.data.automation) {
            smartFarmEnabled = !!sj.data.automation.smart_farm_schedule;
        }
    } catch (e) {
        wrap.innerHTML = `<div class="antiafk-wrap"><div class="card"><div class="card-body" style="color:var(--danger);padding:20px">加载失败：${escapeHtml(e.message)}</div></div></div>`;
        return;
    }

    wrap.innerHTML = _renderAntiafkPage(status, smartFarmEnabled);
    _bindAntiafkEvents(status);
}

function _renderAntiafkPage(s, smartFarmEnabled) {
    const cfg = s.config || {};
    const dogs = Array.isArray(s.dogs) ? s.dogs : [];
    const sess = s.activeSession;
    const dogCount = dogs.length;
    const canSmartHarvest = dogCount >= 10;

    // 主动防护：智能采收开关（挂狗<10 置灰，≥10 可直接在此开启）
    let smartBtnHtml;
    if (canSmartHarvest) {
        smartBtnHtml = `
            <label class="toggle-switch" id="antiafk-smart-harvest-wrap" title="开启智能采收">
                <input type="checkbox" id="antiafk-smart-harvest" ${smartFarmEnabled ? 'checked' : ''}>
                <span class="toggle-slider"></span>
            </label>`;
    } else {
        smartBtnHtml = `
            <label class="toggle-switch btn-disabled" title="至少需要 10 个挂狗才能开启（还差 ${10 - dogCount} 个）" style="opacity:0.4;pointer-events:none">
                <input type="checkbox" disabled>
                <span class="toggle-slider"></span>
            </label>`;
    }

    const smartHarvestHtml = `
        <div class="card" style="margin-top:16px">
            <div class="card-head">
                <h3><i class="fas fa-shield-alt"></i> 主动防护</h3>
            </div>
            <div class="card-body">
                <div class="antiafk-row">
                    <div class="antiafk-desc">
                        <strong>智能采收</strong>
                        <p class="antiafk-hint">利用挂狗帮忙采收，当前挂狗：<strong id="antiafk-dog-count-display">${dogCount}</strong> 个${canSmartHarvest ? '' : `，还差 ${10 - dogCount} 个才能开启`}</p>
                    </div>
                    ${smartBtnHtml}
                </div>
            </div>
        </div>`;

    // 主动测挂进度
    let activeProgressHtml = '';
    if (cfg.activeTestEnabled && sess && !sess.done) {
        const bar = Math.round((sess.roundsDone / sess.totalRounds) * 100);
        activeProgressHtml = `
            <div class="antiafk-progress">
                <div class="antiafk-progress-bar" style="width:${bar}%"></div>
            </div>
            <p class="antiafk-hint" style="font-size:12px;color:var(--text-secondary);margin-top:4px">
                已完成 ${sess.roundsDone}/${sess.totalRounds} 轮
                ${sess.pendingRound ? `（第${sess.pendingRound.roundIndex}轮观察中，已记录${sess.pendingRound.stealCount}次被偷）` : ''}
            </p>`;
    } else if (sess && sess.done) {
        activeProgressHtml = `<p class="antiafk-hint" style="font-size:12px;color:var(--success)"><i class="fas fa-check-circle"></i> 上次测挂已完成（共${sess.roundsDone}轮）</p>`;
    }

    // 功能开关区
    const switchesHtml = `
        <div class="card" style="margin-top:16px">
            <div class="card-head">
                <h3><i class="fas fa-cog"></i> 功能设置</h3>
            </div>
            <div class="card-body">
                <div class="antiafk-row" style="margin-bottom:16px">
                    <div class="antiafk-desc">
                        <strong>主动测挂</strong>
                        <p class="antiafk-hint">开启后，系统将在10小时内随机对5块10级以上作物施有机肥并观察（每次不同地块，间隔≥1小时），命中≥3次的好友标记为挂狗</p>
                        ${activeProgressHtml}
                    </div>
                    <label class="toggle-switch">
                        <input type="checkbox" id="antiafk-active-test" ${cfg.activeTestEnabled ? 'checked' : ''}>
                        <span class="toggle-slider"></span>
                    </label>
                </div>
                <div class="antiafk-row">
                    <div class="antiafk-desc">
                        <strong>偷挂狗模式</strong>
                        <p class="antiafk-hint">开启后，每小时对挂狗名单好友执行超级偷菜（仅偷高等级作物），非挂狗好友不受影响</p>
                    </div>
                    <label class="toggle-switch">
                        <input type="checkbox" id="antiafk-steal-dogs" ${cfg.stealDogsEnabled ? 'checked' : ''}>
                        <span class="toggle-slider"></span>
                    </label>
                </div>
            </div>
        </div>`;

    // 被动测挂说明（一直开启，不需要开关）
    const passiveInfoHtml = `
        <div class="card" style="margin-top:16px">
            <div class="card-head">
                <h3><i class="fas fa-eye"></i> 被动测挂 <span class="badge badge-success" style="font-size:11px;margin-left:6px">持续运行</span></h3>
            </div>
            <div class="card-body">
                <p style="color:var(--text-secondary);font-size:13px">
                    自动监控：当10级以上作物被有机化肥催熟后，若某好友在 <strong>30秒内</strong> 偷了，当天累计 <strong>≥5次</strong> 自动标记为挂狗。无需手动开启。
                </p>
            </div>
        </div>`;

    // 挂狗名单
    const dogsHtml = _renderDogList(dogs);

    return `
    <div class="antiafk-wrap">
        ${passiveInfoHtml}
        ${switchesHtml}
        ${smartHarvestHtml}
        ${dogsHtml}
    </div>`;
}

function _renderDogList(dogs) {
    const active = dogs.filter(d => !d.removed);
    const listHtml = active.length === 0
        ? '<div style="text-align:center;color:var(--text-secondary);padding:30px 0"><i class="fas fa-smile"></i> 暂无挂狗记录</div>'
        : active.map(d => {
            const markedDate = d.markedAt ? new Date(d.markedAt).toLocaleDateString('zh-CN') : '未知';
            const reasonText = d.reason === 'active' ? '主动测挂' : '被动测挂';
            return `
            <div class="friend-card antiafk-dog-card" data-gid="${escapeHtml(String(d.gid))}">
                <div class="friend-card-avatar">
                    <i class="fas fa-dog" style="color:var(--danger)"></i>
                </div>
                <div class="friend-card-info">
                    <div class="friend-card-name">${escapeHtml(d.name || String(d.gid))}</div>
                    <div class="friend-card-meta" style="font-size:11px;color:var(--text-secondary)">
                        GID: ${escapeHtml(String(d.gid))} &nbsp;|&nbsp; ${markedDate} &nbsp;|&nbsp; ${reasonText}
                    </div>
                </div>
                <button class="btn btn-danger btn-sm antiafk-remove-dog" data-gid="${escapeHtml(String(d.gid))}" title="移出挂狗名单">
                    <i class="fas fa-times"></i> 移除
                </button>
            </div>`;
        }).join('');

    return `
    <div class="card" style="margin-top:16px">
        <div class="card-head">
            <h3><i class="fas fa-list"></i> 挂狗名单 <span class="badge badge-danger" style="margin-left:6px">${active.length}</span></h3>
        </div>
        <div class="card-body" id="antiafk-dog-list">
            ${listHtml}
        </div>
    </div>`;
}

function _bindAntiafkEvents(status) {
    // 主动测挂开关
    const activeSwitch = document.getElementById('antiafk-active-test');
    if (activeSwitch) {
        activeSwitch.addEventListener('change', async function () {
            const enabled = this.checked;
            try {
                const j = await _postAntiafkConfig({ activeTestEnabled: enabled });
                if (!j || !j.ok) {
                    showToast(j && j.error ? j.error : '设置失败');
                    this.checked = !enabled;
                    return;
                }
                showToast(enabled ? '主动测挂已开启' : '主动测挂已关闭');
                // 刷新页面状态
                setTimeout(() => loadAntiafk(), 500);
            } catch (e) {
                showToast('操作失败：' + e.message);
                this.checked = !enabled;
            }
        });
    }

    // 偷挂狗开关
    const stealSwitch = document.getElementById('antiafk-steal-dogs');
    if (stealSwitch) {
        stealSwitch.addEventListener('change', async function () {
            const enabled = this.checked;
            try {
                const j = await _postAntiafkConfig({ stealDogsEnabled: enabled });
                if (!j || !j.ok) {
                    showToast(j && j.error ? j.error : '设置失败');
                    this.checked = !enabled;
                    return;
                }
                showToast(enabled ? '偷挂狗模式已开启' : '偷挂狗模式已关闭');
            } catch (e) {
                showToast('操作失败：' + e.message);
                this.checked = !enabled;
            }
        });
    }

    // 智能采收开关（直接在防挂页操作）
    const smartSwitch = document.getElementById('antiafk-smart-harvest');
    if (smartSwitch) {
        smartSwitch.addEventListener('change', async function () {
            const enabled = this.checked;
            try {
                const res = await fetch('/api/automation', {
                    method: 'POST',
                    headers: {
                        'x-admin-token': typeof adminToken !== 'undefined' ? (adminToken || '') : '',
                        'x-account-id': typeof currentAccountId !== 'undefined' ? (currentAccountId || '') : '',
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ smart_farm_schedule: enabled }),
                });
                const j = await res.json();
                if (!j || !j.ok) {
                    showToast(j && j.error ? j.error : '设置失败');
                    this.checked = !enabled;
                    return;
                }
                showToast(enabled ? '智能采收已开启' : '智能采收已关闭');
            } catch (e) {
                showToast('操作失败：' + e.message);
                this.checked = !enabled;
            }
        });
    }

    // 移除挂狗按钮（事件委托）
    const dogList = document.getElementById('antiafk-dog-list');
    if (dogList) {
        dogList.addEventListener('click', async function (e) {
            const btn = e.target.closest('.antiafk-remove-dog');
            if (!btn) return;
            const gid = btn.getAttribute('data-gid');
            if (!gid) return;
            if (!confirm('确定将该好友从挂狗名单中移除？')) return;
            try {
                const j = await _removeDog(gid);
                if (!j || !j.ok) {
                    showToast(j && j.msg ? j.msg : '移除失败');
                    return;
                }
                showToast('已从挂狗名单中移除');
                // 移除对应卡片
                const card = dogList.querySelector(`.antiafk-dog-card[data-gid="${gid}"]`);
                if (card) card.remove();
                // 更新计数
                const countEl = document.getElementById('antiafk-dog-count-display');
                const badgeEl = document.querySelector('.badge-danger');
                const remaining = dogList.querySelectorAll('.antiafk-dog-card').length;
                if (countEl) countEl.textContent = remaining;
                if (badgeEl) badgeEl.textContent = remaining;
                if (remaining === 0) {
                    dogList.innerHTML = '<div style="text-align:center;color:var(--text-secondary);padding:30px 0"><i class="fas fa-smile"></i> 暂无挂狗记录</div>';
                }
            } catch (e) {
                showToast('操作失败：' + e.message);
            }
        });
    }
}
