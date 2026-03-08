/**
 * 用户管理 - 前端逻辑
 */

let users = [];
// 当前展开查看账号的用户 { userId, accounts }
let expandedUserAccounts = {};

async function loadUsers() {
    if (!currentUser || currentUser.role !== 'admin') return;
    
    try {
        const data = await api('/api/users');
        if (data && data.users) {
            users = data.users;
            renderUsers();
        }
    } catch (e) {
        console.error('加载用户列表失败:', e);
    }
}

function getRoleBadge(role) {
    if (role === 'admin') return '<span class="badge badge-admin">管理员</span>';
    if (role === 'vip') return '<span class="badge" style="background:rgba(180,120,0,0.2);color:#d4a017;border:1px solid rgba(180,120,0,0.4);font-size:11px;padding:1px 6px;border-radius:10px"><i class="fas fa-crown" style="font-size:10px"></i> VIP</span>';
    return '<span class="badge badge-user">普通用户</span>';
}

function renderUsers() {
    const list = $('users-list');
    const summary = $('users-summary');
    if (!list || !summary) return;
    
    summary.textContent = `共 ${users.length} 个用户`;
    
    if (users.length === 0) {
        list.innerHTML = '<div style="padding:20px;text-align:center;color:#666">暂无用户</div>';
        return;
    }
    
    list.innerHTML = users.map(user => {
        const roleBadge = getRoleBadge(user.role);
        const expanded = expandedUserAccounts[user.id];
        
        return `
            <div class="user-card" style="flex-direction:column;align-items:stretch;gap:8px">
                <div class="user-info" style="display:flex;align-items:center;gap:10px">
                    <div style="flex:1;min-width:0">
                        <div class="user-name">
                            <i class="fas fa-user"></i>
                            ${escapeHtml(user.username)}
                            ${roleBadge}
                        </div>
                        <div class="user-meta">
                            创建时间: ${formatDate(user.createdAt)}
                        </div>
                    </div>
                </div>
                <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                    <select class="form-control" style="flex:1;min-width:110px;max-width:160px;padding:4px 6px;font-size:12px" onchange="changeUserRole('${user.id}', this.value)" ${user.username === 'admin' ? 'disabled' : ''}>
                        <option value="user" ${user.role === 'user' ? 'selected' : ''}>普通用户</option>
                        <option value="vip" ${user.role === 'vip' ? 'selected' : ''}>超级用户(VIP)</option>
                        <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>管理员</option>
                    </select>
                    <button class="btn btn-sm" onclick="toggleUserAccounts('${user.id}')">
                        <i class="fas fa-list"></i> 账号
                    </button>
                    <button class="btn btn-sm" onclick="resetUserPassword('${user.id}')">
                        <i class="fas fa-key"></i> 重置密码
                    </button>
                    ${user.username !== 'admin' ? `
                        <button class="btn btn-sm btn-danger" onclick="deleteUserConfirm('${user.id}', '${escapeHtml(user.username)}')">
                            <i class="fas fa-trash"></i> 删除
                        </button>
                    ` : ''}
                </div>
                ${expanded ? renderUserAccountList(user.id, expanded) : ''}
            </div>
        `;
    }).join('');
}

function renderUserAccountList(userId, accounts) {
    if (!accounts || accounts.length === 0) {
        return `<div style="padding:8px 4px;font-size:12px;color:#888;border-top:1px solid rgba(255,255,255,0.08);margin-top:4px">该用户暂无账号</div>`;
    }
    const rows = accounts.map(acc => {
        const display = escapeHtml(acc.name || acc.qq || acc.uin || acc.id);
        const qqStr = acc.qq || acc.uin ? `<span style="color:#aaa;font-size:11px">${escapeHtml(acc.qq || acc.uin || '')}</span>` : '';
        return `
            <div style="display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.05)">
                <span style="flex:1;font-size:12px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${display} ${qqStr}</span>
                <button class="btn btn-sm" style="font-size:11px;padding:2px 8px;white-space:nowrap" onclick="openRebindModal('${acc.id}', '${display}', '${userId}')">
                    <i class="fas fa-exchange-alt"></i> 转移
                </button>
            </div>
        `;
    }).join('');
    return `<div style="border-top:1px solid rgba(255,255,255,0.08);margin-top:4px;padding-top:6px">${rows}</div>`;
}

async function toggleUserAccounts(userId) {
    if (expandedUserAccounts[userId]) {
        delete expandedUserAccounts[userId];
        renderUsers();
        return;
    }
    try {
        const data = await api(`/api/users/${userId}/accounts`);
        expandedUserAccounts[userId] = (data && data.accounts) ? data.accounts : [];
        renderUsers();
    } catch (e) {
        alert('获取账号列表失败: ' + (e.message || '未知错误'));
    }
}

// 转移账号 modal
let _rebindAccountId = null;

function openRebindModal(accountId, accountName, currentUserId) {
    _rebindAccountId = accountId;
    const modal = $('modal-rebind-account');
    if (!modal) return;

    // 填写账号名
    const nameEl = $('rebind-account-name');
    if (nameEl) nameEl.textContent = accountName;

    // 填充目标用户下拉
    const sel = $('rebind-target-user');
    if (sel) {
        sel.innerHTML = `<option value="">-- 清除归属（无主账号）--</option>` +
            users.filter(u => String(u.id) !== String(currentUserId)).map(u =>
                `<option value="${u.id}">${escapeHtml(u.username)} (${u.role})</option>`
            ).join('');
        // 默认选中当前归属用户（下拉里是"其他用户"，所以当前用户不在列表）
    }

    modal.classList.add('show');
}

async function confirmRebind() {
    if (!_rebindAccountId) return;
    const sel = $('rebind-target-user');
    const userId = sel ? sel.value : '';

    try {
        await api(`/api/accounts/${_rebindAccountId}/rebind`, 'PUT', { userId: userId || null });
        alert('账号归属已更新');
        closeModal('modal-rebind-account');
        // 刷新所有已展开用户的账号列表
        const expandedIds = Object.keys(expandedUserAccounts);
        expandedUserAccounts = {};
        for (const uid of expandedIds) {
            try {
                const data = await api(`/api/users/${uid}/accounts`);
                expandedUserAccounts[uid] = (data && data.accounts) ? data.accounts : [];
            } catch {}
        }
        renderUsers();
        if (typeof loadAccounts === 'function') loadAccounts();
    } catch (e) {
        alert('转移失败: ' + (e.message || '未知错误'));
    }
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str || '');
    return div.innerHTML;
}

function formatDate(timestamp) {
    if (!timestamp) return '--';
    const d = new Date(timestamp);
    return d.toLocaleDateString('zh-CN') + ' ' + d.toLocaleTimeString('zh-CN');
}

async function changeUserRole(userId, role) {
    try {
        await api(`/api/users/${userId}`, 'PUT', { role });
        await loadUsers();
    } catch (e) {
        alert('修改角色失败: ' + (e.message || '未知错误'));
        await loadUsers(); // 恢复显示
    }
}

async function openAddUserModal() {
    const modal = $('modal-add-user');
    if (!modal) return;
    
    // 清空表单
    $('user-username').value = '';
    $('user-password').value = '';
    $('user-role').value = 'user';
    
    modal.classList.add('show');
}

async function saveUser() {
    const username = $('user-username').value.trim();
    const password = $('user-password').value;
    const role = $('user-role').value;
    
    if (!username) {
        alert('请输入用户名');
        return;
    }
    
    if (!password || password.length < 4) {
        alert('密码至少需要4位');
        return;
    }
    
    try {
        const data = await api('/api/users', 'POST', { username, password, role });
        if (data) {
            alert('用户添加成功');
            closeModal('modal-add-user');
            await loadUsers();
        }
    } catch (e) {
        alert('添加用户失败: ' + (e.message || '未知错误'));
    }
}

async function resetUserPassword(userId) {
    const newPassword = prompt('请输入新密码 (至少4位):');
    if (!newPassword) return;
    
    if (newPassword.length < 4) {
        alert('密码至少需要4位');
        return;
    }
    
    try {
        const data = await api(`/api/users/${userId}`, 'PUT', { password: newPassword });
        if (data) {
            alert('密码重置成功');
        }
    } catch (e) {
        alert('密码重置失败: ' + (e.message || '未知错误'));
    }
}

async function deleteUserConfirm(userId, username) {
    if (!confirm(`确定要删除用户 "${username}" 吗？\n该用户的所有QQ账号也将被删除。`)) {
        return;
    }
    
    try {
        const data = await api(`/api/users/${userId}`, 'DELETE');
        if (data) {
            alert('用户已删除');
            await loadUsers();
            await loadAccounts(); // 刷新账号列表
        }
    } catch (e) {
        alert('删除用户失败: ' + (e.message || '未知错误'));
    }
}

function closeModal(modalId) {
    const modal = $(modalId);
    if (modal) {
        modal.classList.remove('show');
    }
}

// API 辅助函数 (已在 core.js 定义,这里仅为说明)
async function api(path, method = 'GET', body = null) {
    const headers = { 'Content-Type': 'application/json' };
    if (adminToken) headers['x-admin-token'] = adminToken;
    if (currentAccountId) {
        headers['x-account-id'] = currentAccountId;
    }
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    
    try {
        const r = await fetch(API_ROOT + path, opts);
        if (r.status === 401) {
            setLoginState(false);
            return null;
        }
        if (r.status === 403) {
            alert('权限不足');
            return null;
        }
        const j = await r.json();
        if (!j.ok) {
            throw new Error(j.error || 'unknown error');
        }
        return j.data === undefined ? true : j.data;
    } catch (e) {
        console.error('API Error:', e);
        throw e;
    }
}
