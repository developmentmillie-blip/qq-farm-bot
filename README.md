# QQ 农场多账号挂机 + Web 面板

基于 Node.js 的 QQ / 微信 农场游戏全自动挂机工具，支持多账号并行、可视化 Web 控制面板、实时日志、数据分析与推送通知。

## 技术栈

**后端**

[<img src="https://skillicons.dev/icons?i=nodejs" height="48" title="Node.js 20+" />](https://nodejs.org/)
[<img src="https://skillicons.dev/icons?i=express" height="48" title="Express 4" />](https://expressjs.com/)
[<img src="https://skillicons.dev/icons?i=socketio" height="48" title="Socket.io 4" />](https://socket.io/)

**前端**

[<img src="https://skillicons.dev/icons?i=vue" height="48" title="Vue 3" />](https://vuejs.org/)
[<img src="https://skillicons.dev/icons?i=vite" height="48" title="Vite 7" />](https://vitejs.dev/)
[<img src="https://skillicons.dev/icons?i=ts" height="48" title="TypeScript 5" />](https://www.typescriptlang.org/)
[<img src="https://cdn.simpleicons.org/pinia/FFD859" height="48" title="Pinia 3" />](https://pinia.vuejs.org/)
[<img src="https://skillicons.dev/icons?i=unocss" height="48" title="UnoCSS" />](https://unocss.dev/)

**部署**

[<img src="https://skillicons.dev/icons?i=docker" height="48" title="Docker Compose" />](https://docs.docker.com/compose/)
[<img src="https://skillicons.dev/icons?i=pnpm" height="48" title="pnpm 10" />](https://pnpm.io/)
[<img src="https://skillicons.dev/icons?i=githubactions" height="48" title="GitHub Actions" />](https://github.com/features/actions)

---

## 目录

- [功能特性](#功能特性)
- [环境要求](#环境要求)
- [源码安装与启动](#安装与启动源码方式)
- [Docker 部署（推荐）](#docker-部署推荐)
- [二进制发布版](#二进制发布版无需-nodejs)
- [Web 面板使用说明](#web-面板使用说明)
- [详细功能说明](#详细功能说明)
- [推送通知配置](#推送通知配置)
- [项目结构](#项目结构)
- [常见问题](#常见问题)

---

## 功能特性

### 多账号管理
- 支持 **QQ** 和**微信**平台账号，同一面板统一管理
- 账号新增、编辑、删除、单独启动/停止/重启
- 扫码登录（QQ / 微信）或手动输入授权 Code
- 账号被踢下线后**自动删除**，防止僵尸账号占用资源
- 账号连续离线超过设定阈值后**自动删除**（可配置超时时间）
- 账号下线时通过推送渠道（Bark / Webhook 等）发送**下线提醒**

### 自动化农场（自己农场）
- **收获**：检测到成熟作物立即收割，支持全地块批量收割
- **种植**：收割后自动从商店购买最优种子并种植空地/铲除枯死地块后补种
- **施肥**：
  - **无机化肥**：每生长阶段对未施肥地块施一次，加速成熟
  - **有机化肥**：循环施肥直到耗尽（每轮 100ms 间隔防频控）
  - 支持 `normal`（仅无机）/ `organic`（仅有机）/ `both`（双肥）三种模式
- **浇水**：检测到干旱地块自动浇水
- **除草**：检测到杂草自动清除
- **除虫**：检测到虫害自动杀虫
- **土地解锁**：可解锁的土地自动解锁（开关控制）
- **土地升级**：可升级的土地自动升级（开关控制）
- **铲除枯死**：枯死/无法收割的地块自动铲除后重新种植
- **推送触发**：收到服务器 `LandsNotify` 推送时立即巡田，无需等待定时轮询

### 智能种植策略
收割后选种支持以下策略（可在设置页切换）：

| 策略 | 说明 |
|------|------|
| `level`（默认） | 优先种植当前等级可解锁的最高等级作物 |
| `preferred` | 指定固定种子，找不到时回退到最高等级 |
| `max_exp` | 优先种经验效率最高的作物（分析页数据驱动） |
| `max_fert_exp` | 优先种施普通肥后经验效率最高的作物 |
| `max_profit` | 优先种净利润效率最高的作物 |
| `max_fert_profit` | 优先种施普通肥后净利润效率最高的作物 |

> 活动种子（背包中存在但商店不出售的）也会被自动检测并优先使用。

### 好友互动
- **好友巡查**：定期遍历全部好友，优先处理有动态（成熟/干旱/杂草/虫害）的好友
- **帮助操作**：帮好友除草、除虫、浇水（可开关，支持每日经验上限自动停止）
- **偷菜操作**：自动偷取好友成熟可偷的作物，偷后立即出售获取金币
- **捣乱操作**：向好友农场放虫/放草（可单独开关，支持次数上限控制）
- **智能排序**：优先访问偷菜块数多的好友，其次是帮助需求多的好友
- **植物黑名单**：配置后跳过偷取特定植物（如白萝卜等低价作物）
- **好友黑名单**：全局黑名单（完全跳过）和细分黑名单（分别配置不偷/不帮）
- **帮助白名单**：仅对白名单内的好友进行帮助操作
- **偷菜白名单**：仅对白名单内的好友进行捣乱操作
- **静默时段**：设定时间段内完全跳过好友互动（跨天时段也支持）

### 天王模式（超级偷菜）
天王模式是一套**三层递进偷菜策略**，适合想要最大化偷菜效率的用户：

```
基础巡查（每小时一次）
    ↓ 发现高等级作物
重点巡查（高频轮询重点好友）
    ↓ 发现作物即将成熟（1分钟内）或有有机肥（5分钟内）
蹲点偷菜（高频蹲守单个好友农场）
    ↓ 一旦成熟立即偷取
回到重点巡查
```

详细规则：
- **基础巡查**：遍历所有好友，将种有高等级（可配置最低等级阈值）作物的好友加入重点名单
- **重点巡查**：高频遍历重点好友，发现成熟立即偷取；发现 1 分钟内成熟（或有机肥催熟 5 分钟内）则转入蹲点
- **蹲点巡查**：持续轮询单个好友，一旦检测到地块变动/成熟立即偷取；2 分钟无变动或蹲点超过 10 分钟自动退出
- **偷菜次数保护**：次数用完后自动移出重点名单，防止无效请求
- **不偷菜黑名单**：天王模式单独支持 `不偷菜名单`，即使有成熟作物也跳过
- **邮件通知**：蹲点成功偷取后发送 VIP 邮件通知（需配置 SMTP）
- 天王模式运行期间**普通好友巡查自动暂停**，停止后自动恢复

### 防挂模式（偷挂狗）
- 针对"挂机不在线"的好友（即挂狗）每小时单独巡查并偷取高等级作物
- 与天王模式共用最低等级阈值配置
- 独立开关，不影响普通好友巡查

### 仓库管理
- **自动出售**：偷菜后自动将背包中的果实全部出售换取金币
- **果实黑名单**：配置后跳过出售特定果实（保留收藏）
- **肥料管理**：自动打开化肥礼包，将礼包肥转换为可用肥料
- **免费礼品**：自动领取每日免费礼品
- **背包查看**：Web 面板可实时查看背包中所有物品数量和价值

### 任务系统
- 自动检查并领取可领取的日常任务奖励

### 被动行为追踪
无需主动巡查，实时追踪自己农场的被动事件并记录日志：
- **被偷**：记录是哪位好友偷了哪块地的作物，累计统计金币损失
- **被帮**：记录哪位好友帮你除草/除虫
- **被放草/虫**：记录哪位好友向你的作物放草或放虫

---

## 环境要求

| 方式 | 要求 |
|------|------|
| 源码运行 | Node.js 20+，pnpm（`corepack enable`） |
| Docker 部署 | Docker + Docker Compose |
| 二进制版 | 无需任何运行时 |

---

## 安装与启动（源码方式）

### Windows

```powershell
# 1. 安装 Node.js 20+（https://nodejs.org/）并启用 pnpm
node -v
corepack enable
pnpm -v

# 2. 克隆项目并安装依赖
git clone https://github.com/chuankkk/qq-farm-bot.git
cd qq-farm-bot
pnpm install

# 3. 构建前端
pnpm build:web

# 4. 启动（可选：设置管理密码）
$env:ADMIN_PASSWORD="你的强密码"
pnpm dev:core
```

### Linux / macOS

```bash
# 1. 安装 Node.js 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
corepack enable

# 2. 克隆项目并安装依赖
git clone https://github.com/chuankkk/qq-farm-bot.git
cd qq-farm-bot
pnpm install

# 3. 构建前端
pnpm build:web

# 4. 启动
ADMIN_PASSWORD='你的强密码' pnpm dev:core
```

启动后访问面板：
- 本机：`http://localhost:8080`
- 局域网 / 服务器：`http://<IP>:8080`

---

## Docker 部署（推荐）

Docker Compose 包含三个服务：

| 服务名 | 说明 | 对外端口 |
|--------|------|---------|
| `youxian-qq-farm-bot-ui` | 主服务（核心引擎 + Web 面板） | `8081 → 8080` |
| `youxian-ws-keeper` | QQ WebSocket 保活中间层 | `4001 → 4000` |
| `youxian-ws-keeper-wx` | 微信 WebSocket 保活中间层 | `4002 → 4001` |

> `ws-keeper` 负责接收游戏服务器的 WebSocket 连接，并向主服务转发消息，是扫码登录和实时推送的核心组件。

### 快速启动

```bash
# 1. 克隆项目
git clone https://github.com/chuankkk/qq-farm-bot.git
cd qq-farm-bot

# 2. 修改管理密码（强烈建议！）
#    编辑 docker-compose.yml，将 ADMIN_PASSWORD 改为强密码

# 3. 构建并后台启动全部服务
docker compose up -d --build

# 4. 查看实时日志
docker compose logs -f

# 访问面板
# http://服务器IP:8081
```

### 配置管理密码

编辑 `docker-compose.yml`：

```yaml
services:
  youxian-qq-farm-bot-ui:
    environment:
      ADMIN_PASSWORD: 你的强密码   # ← 修改此处
```

修改后重启：

```bash
docker compose up -d
```

### 数据持久化

账号和配置数据通过 Volume 挂载到宿主机，**重建容器不会丢失数据**：

| 宿主机路径 | 容器内路径 | 说明 |
|-----------|-----------|------|
| `./data/` | `/app/core/data/` | 账号列表、配置、统计数据 |

关键文件：
- `./data/accounts.json` — 账号列表（含 Cookie/Token，**请勿泄露**）
- `./data/store.json` — 全局配置和自动化开关
- `./data/users.json` — 面板用户（管理员账户）

### 常用 Docker 命令

```bash
# 查看容器状态
docker compose ps

# 重启主服务（配置变更后）
docker compose restart youxian-qq-farm-bot-ui

# 进入主容器调试
docker exec -it youxian-qq-farm-bot-ui sh

# 更新到最新版本
git pull && docker compose up -d --build

# 停止并移除容器（数据不会丢失）
docker compose down
```

---

## 二进制发布版（无需 Node.js）

### 构建

```bash
pnpm install
pnpm package:release
```

产物输出在 `dist/` 目录：

| 平台 | 文件名 |
|------|--------|
| Windows x64 | `qq-farm-bot-win-x64.exe` |
| Linux x64 | `qq-farm-bot-linux-x64` |
| macOS Intel | `qq-farm-bot-macos-x64` |
| macOS Apple Silicon | `qq-farm-bot-macos-arm64` |

### 运行

```bash
# Windows：直接双击或在终端执行
.\qq-farm-bot-win-x64.exe

# Linux / macOS
chmod +x ./qq-farm-bot-linux-x64 && ./qq-farm-bot-linux-x64
```

程序会在可执行文件同级目录自动创建 `data/` 目录并初始化配置文件。

---

## Web 面板使用说明

### 登录

- 默认密码：`admin`（请立即修改！）
- 通过环境变量 `ADMIN_PASSWORD` 设置密码，重启生效

### 各页面功能

#### 概览页
- 查看所有账号的运行状态、当前动作、今日统计（收割/偷菜/施肥等次数）
- 一键启动/停止所有账号

#### 农场页
- 实时查看当前账号每块土地的状态（生长阶段、成熟倒计时、是否需要浇水/除草/除虫）
- 手动触发：一键收割、一键种植、一键除草/虫/水、施肥（无机/有机）
- 土地状态颜色说明：
  - 🟢 成熟可收 / 🔵 生长中 / 🟡 需浇水 / 🔴 有草或虫 / ⬜ 空地

#### 背包页
- 查看背包中所有物品（果实、种子、肥料、道具等）
- 显示数量、单价、总价值
- 手动触发出售

#### 好友页
- 查看好友列表及其农场状态（成熟块数、干旱/草/虫数量）
- 单独对某个好友执行：偷菜 / 帮浇水 / 帮除草 / 帮除虫 / 捣乱（放虫放草）
- 进入好友农场查看其每块土地的详细状态

#### 分析页
按多维度排序查看所有作物的收益数据：

| 排序维度 | 说明 |
|---------|------|
| 经验效率 | 每小时获得经验（不施肥） |
| 普通肥经验效率 | 每小时获得经验（施无机肥后） |
| 净利润效率 | 每小时净收益金币（不施肥） |
| 普通肥净利润效率 | 每小时净收益金币（施无机肥后） |
| 等级要求 | 解锁该作物所需的土地等级 |

#### 账号管理页
- 新增账号（填写名称）→ 生成二维码 → 扫码登录（QQ / 微信）
- 支持手动输入 Code（`/code-capture` 接口或 `sniff9988.py` 抓码工具）
- 查看每个账号的详细配置：
  - 通知设置（Bark / Webhook 等渠道和参数）
  - 自动化开关（农场/好友/仓库/任务等细分开关）
  - 好友黑名单 / 白名单
  - 植物黑名单（偷菜时跳过的作物）
  - 天王模式配置（开关、最低作物等级）
  - 偷挂狗模式配置
  - 推送通知 SMTP 配置（VIP 功能）

#### 设置页
- 全局管理密码修改
- SMTP 邮件服务器配置（用于成熟提醒、天王模式蹲点成功通知等）
- 种植策略选择
- 施肥模式选择

#### 日志页
实时日志流，支持多维度筛选：

| 筛选维度 | 说明 |
|---------|------|
| 账号 | 只看指定账号的日志 |
| 模块 | farm / friend / warehouse / task 等 |
| 事件 | harvest_crop / steal / plant_seed 等 |
| 级别 | info / warn / error |
| 关键词 | 任意文本搜索 |
| 时间范围 | 最近 N 分钟 / 自定义时间段 |

---

## 详细功能说明

### 扫码登录流程

1. 面板 → 账号管理 → 新增账号 → 输入账号名称
2. 点击"生成二维码"，用 QQ / 微信 扫码
3. 扫码成功后系统自动完成授权，账号状态变为"在线"

若需要手动抓码（适合无图形界面的服务器环境）：

```bash
# 启动抓码工具（需要 Python 3）
python3 sniff9988.py
# 该工具在 9988 端口监听 QQ 扫码回调，并将 code 转发给主服务
```

### 自动化开关说明

在账号设置页，每个账号独立控制以下开关：

| 开关 | 说明 |
|------|------|
| 农场自动化 | 总开关，关闭后停止所有自己农场的自动操作 |
| 农场推送触发 | 是否在收到服务器推送时立即巡田（否则仅定时轮询） |
| 自动升级土地 | 是否自动解锁/升级土地 |
| 好友互动 | 总开关，关闭后停止所有好友相关操作 |
| 自动偷菜 | 是否偷好友农场成熟作物 |
| 自动帮忙 | 是否帮好友除草/除虫/浇水 |
| 经验上限停帮 | 帮助操作经验达今日上限后自动停止帮忙 |
| 自动捣乱 | 是否向好友农场放虫/放草 |
| 自动任务 | 是否自动领取任务奖励 |
| 自动出售 | 是否自动出售背包果实 |
| 肥料礼包 | 是否自动打开化肥礼包 |
| 自动购买肥料 | 是否自动从商店购买肥料 |
| 免费礼品 | 是否自动领取每日免费礼品 |
| 施肥模式 | `none` / `normal` / `organic` / `both` |

### 好友操作次数限制

游戏服务器对每日操作次数有限制，系统会实时追踪并在达到上限后自动停止对应操作：

| 操作类型 | 限制ID |
|---------|-------|
| 帮好友除草 | 10005 |
| 帮好友除虫 | 10006 |
| 帮好友浇水 | 10007 |
| 偷菜 | 10008 |
| 放草（捣乱） | 10003 |
| 放虫（捣乱） | 10004 |

每天北京时间 0 点自动重置次数计数。

### 静默时段配置

在账号设置中配置静默时段（格式 `HH:MM`），期间不执行任何好友互动操作。支持跨天时段，例如 `22:00 - 08:00` 表示晚上 10 点到早上 8 点不操作。

---

## 推送通知配置

账号下线时可通过以下渠道发送通知：

| 渠道 | 说明 |
|------|------|
| `bark` | iOS Bark 推送，endpoint 填 Bark URL |
| `webhook` | 自定义 Webhook，POST 请求 |
| `qmsg` | QQ 消息推送 |
| `serverchan` | Server 酱 |
| `pushplus` | Push+ |
| `dingtalk` | 钉钉机器人 |
| `wecom` | 企业微信应用推送 |
| `wecombot` | 企业微信群机器人 |
| `telegram` | Telegram Bot |
| `discord` | Discord Webhook |
| `feishu` | 飞书机器人 |
| `wxpusher` | WxPusher 微信推送 |
| `email` | 邮件（token 格式：`发件邮箱:SMTP授权码`，endpoint 为收件地址） |

配置路径：账号管理 → 选择账号 → 通知设置 → 填写渠道、endpoint、token。

### SMTP 邮件配置（天王模式通知）

在全局设置页配置 SMTP 服务器：

```
发件邮箱：xxx@qq.com
SMTP 授权码：（QQ 邮箱 → 设置 → 账户 → 生成授权码）
```

配置后，以下情况会发送邮件通知：
- 天王模式蹲点成功偷取
- 普通巡查发现好友有成熟作物但未开启自动偷菜

---

## 项目结构

```
qq-farm-bot/
├── core/                          # 后端（Node.js 机器人引擎）
│   ├── src/
│   │   ├── config/
│   │   │   ├── config.js          # 全局配置（端口、心跳间隔、平台等）
│   │   │   ├── gameConfig.js      # 游戏数据查询（作物名、价格、经验等）
│   │   │   └── runtime-paths.js   # 运行时路径（data目录适配二进制/Docker/源码）
│   │   ├── controllers/
│   │   │   └── admin.js           # HTTP API（账号管理、配置、统计等接口）
│   │   ├── core/
│   │   │   └── worker.js          # Worker 线程主逻辑（每个账号一个线程）
│   │   ├── gameConfig/
│   │   │   ├── Plant.json         # 作物数据（ID、等级需求、生长时间等）
│   │   │   ├── ItemInfo.json      # 物品数据（名称、价格等）
│   │   │   ├── RoleLevel.json     # 玩家等级数据
│   │   │   └── seed_images_named/ # 种子图片资源
│   │   ├── models/
│   │   │   └── store.js           # 运行时存储（账号、配置、自动化开关）
│   │   ├── proto/                 # Protobuf 协议定义文件
│   │   ├── services/
│   │   │   ├── farm.js            # 自己农场自动化逻辑
│   │   │   ├── friend.js          # 好友互动、天王模式、偷挂狗逻辑
│   │   │   ├── warehouse.js       # 背包/出售/肥料管理逻辑
│   │   │   ├── analytics.js       # 作物收益分析（分析页数据）
│   │   │   ├── antiafk.js         # 防挂/防检测逻辑
│   │   │   ├── push.js            # 多渠道推送通知（Pushoo 封装）
│   │   │   ├── scheduler.js       # 通用调度器（setTimeout 任务管理）
│   │   │   ├── stats.js           # 操作统计记录
│   │   │   ├── steal-stats.js     # 偷菜/被偷金币统计
│   │   │   └── persist-stats.js   # 统计数据持久化
│   │   └── utils/
│   │       ├── network.js         # WebSocket 网络层（消息收发）
│   │       ├── proto.js           # Protobuf 类型注册
│   │       └── utils.js           # 工具函数（时间、日志等）
│   ├── panel/                     # 内嵌前端静态资源（pnpm build:web 产物）
│   ├── Dockerfile                 # 主服务容器构建文件
│   └── client.js                  # 主进程入口（启动 HTTP 服务 + Worker 管理）
│
├── web/                           # 前端（Vue 3 + Vite + TypeScript）
│   ├── src/
│   │   ├── api/                   # API 客户端封装（fetch）
│   │   ├── components/            # 通用 Vue 组件
│   │   ├── stores/                # Pinia 状态管理（账号状态、日志流等）
│   │   └── views/                 # 页面组件
│   │       ├── Overview.vue       # 概览页
│   │       ├── Farm.vue           # 农场详情页
│   │       ├── Ranch.vue          # 背包/仓库页
│   │       ├── Friend.vue         # 好友管理页
│   │       ├── Analytics.vue      # 数据分析页
│   │       ├── Accounts.vue       # 账号管理页
│   │       ├── Settings.vue       # 全局设置页
│   │       └── Logs.vue           # 实时日志页
│   └── vite.config.ts
│
├── ws-keeper/                     # WebSocket 保活中间层
│   ├── index.js                   # 保活服务主逻辑（代理 QQ/微信 WS 连接）
│   ├── utils/
│   │   └── crypto-wasm.js         # 加密工具（登录签名等）
│   └── Dockerfile
│
├── sniff9988.py                   # QQ 扫码登录回调抓取工具（Python 3，监听 9988 端口）
├── docker-compose.yml             # Docker 一键部署配置
├── pnpm-workspace.yaml            # pnpm monorepo 工作空间配置
└── package.json                   # 根包（构建脚本）
```

---

## 常见问题

**Q: 扫码后账号一直显示离线？**

1. 确认 `youxian-ws-keeper` 容器正常运行（`docker compose ps`）
2. 检查防火墙是否放开了 `4001`、`4002` 端口
3. 查看 `docker compose logs youxian-ws-keeper` 是否有报错

**Q: 面板无法访问（8081 端口）？**

检查 `docker compose ps` 中主服务状态是否为 `Up`，并确认服务器安全组/防火墙放开了 `8081` 端口。

**Q: 偷菜不生效？**

1. 确认"自动偷菜"开关已开启
2. 检查是否在静默时段内
3. 检查好友是否在黑名单中，或作物在植物黑名单中
4. 查看日志页过滤 `event=steal` 确认是否有偷菜日志

**Q: 数据丢失了？**

`./data/` 目录已挂载到宿主机，只要宿主机该目录存在，重建容器不会丢失数据。

**Q: 如何迁移到新服务器？**

1. 将旧服务器 `./data/` 目录打包
2. 在新服务器部署项目后，覆盖 `./data/` 目录
3. 重启容器即可

**Q: 如何更新到最新版本？**

```bash
git pull
docker compose up -d --build
```

**Q: 天王模式和普通好友巡查能同时开启吗？**

不能，天王模式启动时会自动暂停普通好友巡查，停止时自动恢复。

**Q: `sniff9988.py` 是干什么的？**

这是一个 Python 辅助工具，在 9988 端口开启 HTTP 服务，拦截 QQ 扫码登录的授权回调并将 code 转发给主服务的 `/api/code-capture` 接口。主要用于无图形界面的服务器环境或自动化扫码场景。

---

## 特别感谢

- 核心功能：[linguo2625469/qq-farm-bot](https://github.com/linguo2625469/qq-farm-bot)
- 部分功能：[QianChenJun/qq-farm-bot](https://github.com/QianChenJun/qq-farm-bot)
- 扫码登录：[lkeme/QRLib](https://github.com/lkeme/QRLib)
- 推送通知：[imaegoo/pushoo](https://github.com/imaegoo/pushoo)

---

## 免责声明

本项目仅供学习与研究用途。使用本工具可能违反游戏服务条款，由此产生的一切后果由使用者自行承担。
