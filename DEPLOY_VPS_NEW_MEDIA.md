# 新媒体内容中台（VPS 部署手册）

本文基于当前仓库源码（Directus monorepo + 新媒体定制）编写，目标是让你在 VPS 上稳定部署并长期运行。

## 1. 部署目标

- 单机部署（1 台 VPS）
- Node.js `22.x`，pnpm `10.x`
- 默认数据库：SQLite（适合 5 人以内团队）
- 进程守护：`systemd`
- 初始化策略：`new-media:init` 独立执行（可重复、幂等）
- 支持不使用 Nginx：Directus API 可直接托管管理端页面（`SERVE_APP=true`），通过 `域名/IP:端口` 访问
- 启动方式支持两种：
  - 方式 A：使用 Nginx 反向代理（推荐）
  - 方式 B：不使用 Nginx，直接暴露 `:8055`

## 2. VPS 环境准备（Ubuntu 22.04/24.04）

```bash
sudo apt update
sudo apt install -y git curl build-essential
```

若使用 Nginx 反代，再安装：

```bash
sudo apt install -y nginx
```

安装 Node.js 22（示例使用 fnm）：

```bash
curl -fsSL https://fnm.vercel.app/install | bash
source ~/.bashrc
fnm install 22
fnm default 22
node -v
```

安装 pnpm 10：

```bash
corepack enable
corepack prepare pnpm@10.27.0 --activate
pnpm -v
```

## 3. 拉取代码

```bash
sudo mkdir -p /srv
sudo chown -R $USER:$USER /srv
cd /srv
git clone https://github.com/Seep2026/directus_xy.git
cd directus_xy
git checkout main
git pull origin main
```

## 4. 配置 API 环境变量（生产）

```bash
cd /srv/directus_xy/api
cp env.new-media.example .env.new-media
cp .env.new-media .env
```

编辑 `api/.env`，至少确认：

```env
KEY=<32字节以上随机字符串>
SECRET=<32字节以上随机字符串>

HOST=0.0.0.0
PORT=8055
PUBLIC_URL=<按下面“方式A/方式B”设置>

DB_CLIENT=sqlite3
DB_FILENAME=./data/new-media.db

SERVE_APP=true
WEBSOCKETS_ENABLED=true

ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=<请改成强密码>
```

`PUBLIC_URL` 设置规则：

- 方式 A（Nginx 反代）：`https://your-domain.com`
- 方式 B（无反代直连）：`http://<VPS公网IP>:8055`

## 5. 安装依赖并构建

```bash
cd /srv/directus_xy
pnpm install --frozen-lockfile
pnpm build
```

## 6. 首次初始化（统一步骤）

### 6.1 初始化 Directus 系统表与管理员

```bash
cd /srv/directus_xy/api
mkdir -p data uploads extensions
pnpm cli bootstrap
```

### 6.2 配置并启动 systemd 常驻 API

创建服务文件：

```bash
sudo tee /etc/systemd/system/new-media.service >/dev/null <<'EOF'
[Unit]
Description=New Media Directus Service
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/srv/directus_xy/api
ExecStart=/usr/bin/env node /srv/directus_xy/api/dist/start.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
```

启动服务：

```bash
sudo systemctl daemon-reload
sudo systemctl enable new-media
sudo systemctl restart new-media
sudo systemctl status new-media
curl -sSf http://127.0.0.1:8055/server/ping
```

### 6.3 执行新媒体业务初始化（关键）

不要直接裸跑 `pnpm new-media:init`，请从 `api/.env` 注入管理员凭据，避免 `401 INVALID_CREDENTIALS`：

```bash
cd /srv/directus_xy
set -a
source ./api/.env
set +a

DIRECTUS_URL="http://127.0.0.1:${PORT:-8055}" \
DIRECTUS_ADMIN_EMAIL="$ADMIN_EMAIL" \
DIRECTUS_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
pnpm new-media:init
```

说明：

- 这一步会写入定制系统能力（集合、字段、权限、工作台、汉化等）
- 该命令是幂等的，可重复执行

### 6.4 常见初始化失败：401 Invalid user credentials

如果第 6.3 步报 401，说明 `api/.env` 里的管理员密码和数据库实际密码不一致，先重置：

```bash
cd /srv/directus_xy/api
pnpm cli users passwd --email admin@example.com --password '<新密码>'
```

然后把 `api/.env` 的 `ADMIN_PASSWORD` 改成同一个密码，再重跑第 6.3 步。

## 7. 启动方式 A：使用 Nginx 反向代理（推荐）

### 7.1 配置 Nginx

```bash
sudo tee /etc/nginx/sites-available/new-media.conf >/dev/null <<'EOF'
server {
    listen 80;
    server_name your-domain.com;

    client_max_body_size 100m;

    location / {
        proxy_pass http://127.0.0.1:8055;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
EOF
```

启用并重载：

```bash
sudo ln -sf /etc/nginx/sites-available/new-media.conf /etc/nginx/sites-enabled/new-media.conf
sudo nginx -t
sudo systemctl reload nginx
```

可选 HTTPS（推荐）：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

### 7.2 启动与访问

```bash
sudo systemctl restart new-media
curl -sSf http://127.0.0.1:8055/server/ping
curl -sI https://your-domain.com/admin
```

浏览器访问：`https://your-domain.com/admin`

## 8. 启动方式 B：不使用 Nginx（直连）

说明：

- 不使用 Nginx 时，Directus 仍可直接提供服务（包括 `/admin` 页面）
- 只要 `new-media` 服务已启动，且安全组/防火墙放通端口，就可以通过“地址 + 端口”访问

### 8.1 前置要求

- `api/.env` 的 `PUBLIC_URL` 必须是 `http://<VPS公网IP>:8055`
- 云厂商安全组与系统防火墙放行 `8055/tcp`

### 8.2 启动与访问

```bash
sudo systemctl restart new-media
curl -sSf http://127.0.0.1:8055/server/ping
curl -sI http://<VPS公网IP>:8055/admin
```

浏览器访问：`http://<VPS公网IP>:8055/admin`

常见访问写法示例：

- `http://203.0.113.10:8055/admin`（公网 IP + 端口）
- `http://your-domain.com:8055/admin`（域名 + 端口，未走反向代理）

## 9. 默认账号（如未改）

- `admin@example.com / <你在 api/.env 设置的管理员密码>`
- `creator@example.com / Demo@123456`
- `reviewer@example.com / Demo@123456`

## 10. 后续更新流程（代码升级）

```bash
cd /srv/directus_xy
git pull origin main
pnpm install --frozen-lockfile
pnpm build

sudo systemctl restart new-media

set -a
source ./api/.env
set +a

DIRECTUS_URL="http://127.0.0.1:${PORT:-8055}" \
DIRECTUS_ADMIN_EMAIL="$ADMIN_EMAIL" \
DIRECTUS_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
pnpm new-media:init

sudo systemctl restart new-media
```

说明：

- `new-media:init` 建议每次升级后执行一次，用于同步字段、权限、汉化与工作台配置
- 生产环境不建议用 `./start_new_media.sh` 作为主启动方式

## 11. 数据与文件备份

SQLite 备份：

```bash
cp /srv/directus_xy/api/data/new-media.db /srv/backup/new-media-$(date +%F-%H%M%S).db
```

上传文件备份：

```bash
tar -czf /srv/backup/uploads-$(date +%F-%H%M%S).tar.gz /srv/directus_xy/api/uploads
```

## 12. 常见问题

### 12.1 看不到定制菜单/集合

- 先确认第 6.3 步是否成功执行过 `new-media:init`
- 再检查是否使用了正确管理员凭据

### 12.2 `/admin` 打不开

- 查服务：`sudo systemctl status new-media`
- 查 API：`curl -sSf http://127.0.0.1:8055/server/ping`
- 若用 Nginx：`sudo nginx -t && sudo systemctl status nginx`

### 12.3 登录后偶发 400（refresh）

- 常见是 refresh token 失效或 cookie 异常
- 清理浏览器站点数据后重新登录通常可恢复

### 12.4 端口冲突

```bash
lsof -nP -iTCP:8055 -sTCP:LISTEN
```

若被其他进程占用，先停掉冲突进程或调整 `PORT`。
