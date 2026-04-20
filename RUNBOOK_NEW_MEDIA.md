# 新媒体内容中台 2.0 - 本地运行说明

## 1. 环境要求

- Node.js: `22.x`
- pnpm: `10.x`

## 2. 安装依赖

```bash
pnpm install
```

## 3. 初始化 API 环境（SQLite）

```bash
cd api
cp .env.new-media .env
mkdir -p data extensions
mkdir -p uploads
pnpm cli bootstrap
```

说明：

- 会自动创建系统表与默认管理员
- 默认管理员账号来自 `api/.env.new-media`

## 4. 启动开发环境

### 4.0 一键启动（推荐）

```bash
./start_new_media.sh
```

说明：

- 脚本会自动启动 API、执行 `pnpm new-media:init`、再启动 App
- 日志输出到 `.run/new-media/`
- 如只想执行初始化可使用：`./start_new_media.sh --init-only`
- 前台模式会持续占用当前终端（按 `Ctrl+C` 停止）
- 如需后台启动后立即返回终端可使用：`./start_new_media.sh --detach`

### 4.1 启动 API

```bash
cd api
pnpm dev
```

访问：`http://localhost:8055`

### 4.2 启动 App

```bash
cd app
pnpm dev
```

访问：`http://localhost:8080/admin`

## 5. 初始化“新媒体内容中台”业务模型

在 API 启动后，根目录执行：

```bash
pnpm new-media:init
```

该脚本会自动创建：

- 5 个核心集合（信号池、内容卡、版本记录、来源库、资产库）
- 角色与策略（内容创作者、审核者）
- 全局默认语言（`zh-CN`）
- 自定义 i18n 文案包（`scripts/new-media/i18n/zh-CN.json`）
- 演示账号
- 工作台仪表板（我的草稿、待我审核、最近通过、最近采纳）
- 1.1 字段兼容迁移（信号池 `signal_title/signal_type/signal_url/source_ref`）
- 主要字段中文显示名同步（`meta.translations`）
- 来源快捷新建能力（创作者对来源库具备 create/update）
- 1.2 菜单顺序同步（来源库 -> 信号池 -> 内容卡 -> 资产库 -> 版本记录）
- 1.2 浏览器标签标题统一（仅显示产品名 + 版本号）
- 1.2 内容详情页长标题完整显示（取消截断省略）
- 1.3 公众号长文排版编辑（结构化 JSON 正文）
- 1.3 公众号长文手机预览（接近微信阅读端样式）
- 1.3 资产库图片插入正文（内容内图片可追溯到资产）
- 1.3 送审版本快照增加图文结构与图片引用
- 2.0 选题卡增强层（锚点类型、选题角度、与产品关系、用户带走点等）
- 2.0 选题状态流转（待判断/可写/暂缓/不采用/已转内容卡）
- 2.0 带判断信息转内容卡（含快照与回链）
- 2.0 工作台新增选题库存区块与信号池快捷筛选预设

说明：

- 默认不再自动写入信号池/内容卡/版本/来源/资产样例数据
- 如需临时注入样例内容，可手动执行：

```bash
NEW_MEDIA_SEED_CONTENT_DEMO=true pnpm new-media:init
```

## 5.1 1.1 增量迁移（已存在 1.0 数据）

在 API 启动后执行同一条命令即可安全增量升级：

```bash
pnpm new-media:init
```

说明：

- 旧字段不会被直接删除（`title/source_type/source_link` 保留并隐藏）
- 会自动将旧数据迁移/回填到 1.1 主字段
- 内容卡会自动补齐来源快照字段，减少深层关系依赖

## 5.2 全量重置（可选）

```bash
rm -f api/data/new-media.db
cd api && pnpm cli bootstrap
cd .. && pnpm new-media:init
```

说明：仅在你希望重建全新演示库时使用。

## 6. 默认账号

- 管理员：`admin@example.com / admin12345678`
- 内容创作者：`creator@example.com / Demo@123456`
- 审核者：`reviewer@example.com / Demo@123456`

## 7. 数据说明

- 默认初始化只创建系统结构、中文配置、角色权限与演示账号
- 业务内容数据由团队自行录入
- 如需演示样例，可用 `NEW_MEDIA_SEED_CONTENT_DEMO=true pnpm new-media:init` 手动注入

## 8. 关键改动目录

- API 业务约束与自动化 Hook：`api/src/new-media/register-hooks.ts`
- API 启动接入：`api/src/app.ts`
- App 默认语言：`app/src/lang/index.ts`
- 初始化脚本：`scripts/new-media/init.mjs`
- 自定义 i18n 文案包：`scripts/new-media/i18n/zh-CN.json`
- 一键命令：`package.json` (`new-media:init`)
- 本地环境模板：`api/.env.new-media`
- 一键启动脚本：`start_new_media.sh`

## 9. 1.1 重点变化

- 信号池字段优化：
  - `source_ref`（来源主体下拉，支持快捷新建）
  - `signal_type`（文章/视频/推文/报告/公告/其他）
  - `signal_url`（内容链接）
  - `signal_title`（信号标题主字段）
- 关系简化：
  - 去除不必要复杂关联，保留必要单向关系与快照字段
  - `内容卡 -> 版本记录` 一对多保留
  - 资产改为 `资产库 -> 内容卡` 单向关联
- 汉化增强：
  - 全局默认语言 `zh-CN`
  - 自定义 i18n 文案包自动写入 `directus_translations`
  - 主要集合与字段中文显示名通过 `meta.translations` 同步

## 10. 1.2 重点变化

- 菜单顺序统一：
  - 来源库
  - 信号池
  - 内容卡
  - 资产库
  - 版本记录
- 内容详情页标题不再截断：
  - 长中文标题支持完整显示（允许换行）
  - 不再出现 `..` 省略
- 浏览器标签标题规则统一：
  - 只显示 `新媒体内容中台 + 版本号`
  - 版本来源：`app/package.json` 的 `newMedia.productVersion`

## 11. 1.3 重点变化

- 公众号长文专用排版接口：
  - 新增 `nm_content_cards.body_structured`（JSON）
  - `channel_type=公众号长文` 时启用图文排版编辑器
- 手机预览：
  - 支持 `编辑 / 手机预览 / 分栏` 三种模式
  - 预览样式接近微信阅读端（标题层级、段落、引用、分割线、图片说明）
- 资产联动：
  - 编辑器可从资产库选择并插入图片
  - 版本快照会记录图片引用信息
- 兼容迁移：
  - 旧 `body` 文本在公众号长文下可自动回填为结构化正文（段落块）

## 12. 2.0 重点变化

- 选题判断增强：
  - 信号池新增锚点类型、选题角度、与产品关系、用户带走点、发布理由、建议写法、目标读者等字段
  - 引入独立 `topic_status`（待判断/可写/暂缓/不采用/已转内容卡）
- 转卡增强：
  - 从信号转内容卡时自动携带选题判断快照
  - 自动写回 `linked_content / converted_at / converted_by / converted_content_snapshot`
- 工作台增强：
  - 新增“待判断选题 / 已判断可写选题 / 最近转卡选题”区块
  - 信号池新增快捷筛选预设（待判断、可写、品牌锚点、按来源）

## 13. 常见问题排查

### 13.1 `./start_new_media.sh` 为什么不退出？

- 这是默认行为：脚本会以前台方式守护 API 与 App 进程。
- 需要后台运行请改用：`./start_new_media.sh --detach`

### 13.2 8080 出现 `400` 怎么看？

- 常见场景是前端通过 8080 代理访问 `/auth/refresh`，在缺失或失效 refresh token 时 API 会返回 `400`。
- 这不一定代表 8080 端口挂掉，可先检查：
  - `curl -sI http://localhost:8080/admin` 是否 `200`
  - `.run/new-media/api.log` 是否存在 `POST /auth/refresh 400`
- 一般重新登录可恢复；若长期未登录或浏览器清理了 cookie，容易复现该现象。
