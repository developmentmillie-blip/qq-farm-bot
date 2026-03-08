function updateUptimeDisplay() {
    if (lastSyncTimestamp > 0) {
        const elapsed = (Date.now() - lastSyncTimestamp) / 1000;
        const currentUptime = lastServerUptime + elapsed;
        const el = $('stat-uptime');
        if (el) el.textContent = fmtTime(currentUptime);
    }
}

function updateTime() {
    const now = new Date();
    const el = document.getElementById('sys-time');
    if (el) el.textContent = now.toLocaleTimeString();
}
setInterval(() => {
    updateTime();
    updateUptimeDisplay();
}, 1000);
updateTime();
lockHorizontalSwipeOnMobile();
applyFontScale();
window.addEventListener('resize', applyFontScale);
window.addEventListener('resize', syncOpsRowsMode);
updateTopbarAccount(null);
initTheme();
initPasswordToggles();

// 初始化
$('btn-refresh').addEventListener('click', () => { window.location.reload(); });

$('btn-theme').addEventListener('click', () => {
    const current = String(localStorage.getItem(THEME_STORAGE_KEY) || 'dark');
    const idx = THEMES.indexOf(current);
    const next = THEMES[(idx + 1) % THEMES.length];
    applyTheme(next);
    localStorage.setItem(THEME_STORAGE_KEY, next);
    if (isLoggedIn) {
        api('/api/settings/theme', 'POST', { theme: next });
    }
});

const loginBtn = $('btn-login');
if (loginBtn) loginBtn.addEventListener('click', doLogin);
const regBtn = $('btn-register');
if (regBtn) regBtn.addEventListener('click', doRegister);
const loginInput = $('login-password');
if (loginInput) {
    loginInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const regBtnEl = $('btn-register');
            if (regBtnEl && regBtnEl.style.display !== 'none') doRegister();
            else doLogin();
        }
    });
}
const loginUsernameInput = $('login-username');
if (loginUsernameInput) {
    loginUsernameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const regBtnEl = $('btn-register');
            if (regBtnEl && regBtnEl.style.display !== 'none') doRegister();
            else doLogin();
        }
    });
}
const btnSwitchToReg = $('btn-switch-to-reg');
if (btnSwitchToReg) btnSwitchToReg.addEventListener('click', (e) => { e.preventDefault(); switchLoginMode(true); });
const btnSwitchToLogin = $('btn-switch-to-login');
if (btnSwitchToLogin) btnSwitchToLogin.addEventListener('click', (e) => { e.preventDefault(); switchLoginMode(false); });

// 用户管理事件绑定
const btnAddUserModal = $('btn-add-user-modal');
if (btnAddUserModal) {
    btnAddUserModal.addEventListener('click', openAddUserModal);
}
const btnSaveUser = $('btn-save-user');
if (btnSaveUser) {
    btnSaveUser.addEventListener('click', saveUser);
}
const btnCancelUser = $('btn-cancel-user');
if (btnCancelUser) {
    btnCancelUser.addEventListener('click', () => closeModal('modal-add-user'));
}

// 模态框关闭按钮
document.querySelectorAll('.close-modal').forEach(btn => {
    btn.addEventListener('click', (e) => {
        const modal = e.target.closest('.modal');
        if (modal) modal.classList.remove('show');
    });
});

const logsFilterSel = $('logs-account-filter');
if (logsFilterSel) {
    logsFilterSel.value = logFilterAccountId;
    const onAccountFilterChange = () => {
        logFilterAccountId = logsFilterSel.value || 'all';
        localStorage.setItem('logFilterAccountId', logFilterAccountId);
        pollLogs();
    };
    logsFilterSel.addEventListener('change', onAccountFilterChange);
    logsFilterSel.addEventListener('input', onAccountFilterChange);
    logsFilterSel.addEventListener('blur', onAccountFilterChange);
}

const logsModuleSel = $('logs-module-filter');
if (logsModuleSel) {
    logsModuleSel.value = logFilters.module;
    const onModuleFilterChange = () => {
        logFilters.module = logsModuleSel.value || '';
        localStorage.setItem('logFilterModule', logFilters.module);
        pollLogs();
    };
    logsModuleSel.addEventListener('change', onModuleFilterChange);
    logsModuleSel.addEventListener('input', onModuleFilterChange);
    logsModuleSel.addEventListener('blur', onModuleFilterChange);
}

const logsWarnSel = $('logs-warn-filter');
if (logsWarnSel) {
    logsWarnSel.value = logFilters.isWarn;
    const onWarnFilterChange = () => {
        logFilters.isWarn = logsWarnSel.value || '';
        localStorage.setItem('logFilterIsWarn', logFilters.isWarn);
        pollLogs();
    };
    logsWarnSel.addEventListener('change', onWarnFilterChange);
    logsWarnSel.addEventListener('input', onWarnFilterChange);
    logsWarnSel.addEventListener('blur', onWarnFilterChange);
}

const logsEventFilter = $('logs-event-filter');
if (logsEventFilter) {
    logsEventFilter.value = logFilters.event;
    const onEventFilterChange = () => {
        logFilters.event = String(logsEventFilter.value || '').trim();
        localStorage.setItem('logFilterEvent', logFilters.event);
        pollLogs();
    };
    logsEventFilter.addEventListener('change', onEventFilterChange);
    logsEventFilter.addEventListener('input', onEventFilterChange);
    logsEventFilter.addEventListener('blur', onEventFilterChange);
}

const logsKeywordInput = $('logs-keyword-filter');
if (logsKeywordInput) {
    logsKeywordInput.value = logFilters.keyword;
    let keywordTimer = null;
    const onKeywordChange = () => {
        const next = logsKeywordInput.value.trim();
        if (!next) {
            if (keywordTimer) clearTimeout(keywordTimer);
            logFilters.keyword = '';
            localStorage.setItem('logFilterKeyword', logFilters.keyword);
            pollLogs();
            return;
        }
        if (keywordTimer) clearTimeout(keywordTimer);
        keywordTimer = setTimeout(() => {
            logFilters.keyword = next;
            localStorage.setItem('logFilterKeyword', logFilters.keyword);
            pollLogs();
        }, 250);
    };
    logsKeywordInput.addEventListener('input', onKeywordChange);
    logsKeywordInput.addEventListener('search', onKeywordChange);
    logsKeywordInput.addEventListener('change', onKeywordChange);
}

const logsTimeFromInput = $('logs-time-from-filter');
if (logsTimeFromInput) {
    logsTimeFromInput.value = logFilters.timeFrom;
    const onTimeFromChange = () => {
        logFilters.timeFrom = logsTimeFromInput.value || '';
        localStorage.setItem('logFilterTimeFrom', logFilters.timeFrom);
        pollLogs();
    };
    logsTimeFromInput.addEventListener('change', onTimeFromChange);
    logsTimeFromInput.addEventListener('input', onTimeFromChange);
}

const logsTimeToInput = $('logs-time-to-filter');
if (logsTimeToInput) {
    logsTimeToInput.value = logFilters.timeTo;
    const onTimeToChange = () => {
        logFilters.timeTo = logsTimeToInput.value || '';
        localStorage.setItem('logFilterTimeTo', logFilters.timeTo);
        pollLogs();
    };
    logsTimeToInput.addEventListener('change', onTimeToChange);
    logsTimeToInput.addEventListener('input', onTimeToChange);
}

initLogFiltersUI();

// 更新密码设置UI文本（根据用户角色）
function updatePasswordUI() {
    const passwordTitle = $('password-title');
    const passwordHint = $('password-hint');
    const passwordBtnText = $('password-btn-text');
    
    if (currentUser) {
        if (currentUser.role === 'admin') {
            if (passwordTitle) passwordTitle.textContent = '管理员密码';
            if (passwordBtnText) passwordBtnText.textContent = '修改管理员密码';
            // 管理员显示默认密码提示
            if (passwordHint) passwordHint.style.display = '';
        } else {
            if (passwordTitle) passwordTitle.textContent = '用户密码';
            if (passwordBtnText) passwordBtnText.textContent = '修改用户密码';
            // 普通用户不显示默认密码提示
            if (passwordHint) passwordHint.style.display = 'none';
        }
    }
}

// 在页面导航时调用
document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
        updatePasswordUI();
    });
});

const btnLogout = $('btn-logout');
if (btnLogout) {
    btnLogout.addEventListener('click', doLogout);
}

// ===== 植物等级参考弹窗 =====
const PLANT_LEVEL_DATA = [
  {lv:1,name:'白萝卜'},{lv:2,name:'胡萝卜'},{lv:3,name:'大白菜'},{lv:4,name:'大蒜'},{lv:5,name:'大葱'},
  {lv:6,name:'水稻'},{lv:7,name:'小麦'},{lv:8,name:'玉米'},{lv:9,name:'鲜姜'},{lv:10,name:'土豆'},
  {lv:11,name:'小白菜'},{lv:12,name:'生菜'},{lv:13,name:'油菜'},{lv:14,name:'茄子'},{lv:15,name:'红枣'},
  {lv:16,name:'蒲公英'},{lv:17,name:'银莲花'},{lv:18,name:'番茄'},{lv:19,name:'花菜'},{lv:20,name:'韭菜'},
  {lv:21,name:'小雏菊'},{lv:22,name:'豌豆'},{lv:23,name:'莲藕'},{lv:24,name:'红玫瑰'},{lv:25,name:'秋菊（黄色）'},
  {lv:26,name:'满天星'},{lv:27,name:'含羞草'},{lv:28,name:'牵牛花'},{lv:29,name:'秋菊（红色）'},{lv:30,name:'辣椒'},
  {lv:31,name:'黄瓜'},{lv:32,name:'芹菜'},{lv:33,name:'天香百合'},{lv:34,name:'南瓜'},{lv:35,name:'核桃'},
  {lv:36,name:'山楂'},{lv:37,name:'菠菜'},{lv:38,name:'草莓'},{lv:39,name:'苹果'},{lv:40,name:'四叶草'},
  {lv:41,name:'非洲菊'},{lv:42,name:'火绒草'},{lv:43,name:'花香根鸢尾'},{lv:44,name:'虞美人'},{lv:45,name:'向日葵'},
  {lv:46,name:'西瓜'},{lv:47,name:'黄豆'},{lv:48,name:'香蕉'},{lv:49,name:'竹笋'},{lv:50,name:'桃子'},
  {lv:51,name:'甘蔗'},{lv:52,name:'橙子'},{lv:53,name:'茉莉花'},{lv:54,name:'葡萄'},{lv:55,name:'丝瓜'},
  {lv:56,name:'榛子'},{lv:57,name:'迎春花'},{lv:58,name:'石榴'},{lv:59,name:'栗子'},{lv:60,name:'柚子'},
  {lv:61,name:'蘑菇'},{lv:62,name:'菠萝'},{lv:63,name:'箬竹'},{lv:64,name:'无花果'},{lv:65,name:'椰子'},
  {lv:66,name:'花生'},{lv:67,name:'金针菇'},{lv:68,name:'葫芦'},{lv:69,name:'猕猴桃'},{lv:70,name:'梨'},
  {lv:71,name:'睡莲'},{lv:72,name:'火龙果'},{lv:73,name:'枇杷'},{lv:74,name:'樱桃'},{lv:75,name:'李子'},
  {lv:76,name:'荔枝'},{lv:77,name:'香瓜'},{lv:78,name:'木瓜'},{lv:79,name:'桂圆'},{lv:80,name:'月柿'},
  {lv:81,name:'杨桃'},{lv:82,name:'哈密瓜'},{lv:83,name:'桑葚'},{lv:84,name:'柠檬'},{lv:85,name:'芒果'},
  {lv:86,name:'杨梅'},{lv:87,name:'榴莲'},{lv:88,name:'番石榴'},{lv:89,name:'瓶子树'},{lv:90,name:'蓝莓'},
  {lv:91,name:'猪笼草'},{lv:92,name:'山竹'},{lv:93,name:'曼陀罗华'},{lv:94,name:'曼珠沙华'},{lv:95,name:'苦瓜'},
  {lv:96,name:'天堂鸟'},{lv:97,name:'冬瓜'},{lv:98,name:'豹皮花'},{lv:99,name:'杏子'},{lv:100,name:'金桔'},
  {lv:101,name:'红毛丹'},{lv:102,name:'宝华玉兰'},{lv:103,name:'芭蕉'},{lv:104,name:'依米花'},{lv:105,name:'番荔枝'},
  {lv:106,name:'大王花'},{lv:107,name:'橄榄'},{lv:108,name:'人参果'},{lv:109,name:'百香果'},{lv:110,name:'金花茶'},
  {lv:111,name:'灯笼果'},{lv:112,name:'天山雪莲'},{lv:113,name:'芦荟'},{lv:114,name:'金边灵芝'},{lv:115,name:'薄荷'},
  {lv:116,name:'何首乌'},{lv:117,name:'菠萝蜜'},{lv:118,name:'人参'},{lv:119,name:'鳄梨'},{lv:120,name:'似血杜鹃'},
  {lv:121,name:'新春红包'},{lv:1,name:'哈哈南瓜'}
];

function renderPlantLevelTable(keyword) {
    const tbody = document.getElementById('plant-level-table-body');
    if (!tbody) return;
    const kw = (keyword || '').trim();
    const filtered = kw ? PLANT_LEVEL_DATA.filter(p => p.name.includes(kw) || String(p.lv).includes(kw)) : PLANT_LEVEL_DATA;
    if (!filtered.length) {
        tbody.innerHTML = '<tr><td colspan="2" class="plant-level-no-result">没有找到匹配的植物</td></tr>';
        return;
    }
    tbody.innerHTML = filtered.map(p => {
        const cls = p.lv >= 100 ? 'lv-badge lv-max' : p.lv >= 50 ? 'lv-badge lv-high' : 'lv-badge';
        return `<tr><td><span class="${cls}">${p.lv}</span></td><td>${p.name}</td></tr>`;
    }).join('');
}

window.filterPlantLevelRef = function() {
    const kw = (document.getElementById('plant-level-ref-search') || {}).value || '';
    renderPlantLevelTable(kw);
};

const btnPlantLevelRef = document.getElementById('btn-plant-level-ref');
if (btnPlantLevelRef) {
    btnPlantLevelRef.addEventListener('click', () => {
        const modal = document.getElementById('modal-plant-level-ref');
        if (!modal) return;
        const searchEl = document.getElementById('plant-level-ref-search');
        if (searchEl) searchEl.value = '';
        renderPlantLevelTable('');
        modal.classList.add('show');
    });
}

checkLogin();

// ===== 问号提示气泡：只在鼠标悬停问号按钮本身时显示 =====
document.querySelectorAll('.setting-hint-btn').forEach(btn => {
    const popup = btn.nextElementSibling;
    if (!popup || !popup.classList.contains('setting-hint-popup')) return;
    btn.addEventListener('mouseenter', () => {
        popup.classList.add('visible');
        btn.style.background = 'var(--accent)';
        btn.style.borderColor = 'var(--accent)';
        btn.style.color = '#fff';
    });
    btn.addEventListener('mouseleave', () => {
        popup.classList.remove('visible');
        btn.style.background = '';
        btn.style.borderColor = '';
        btn.style.color = '';
    });
});


