# 新媒体内容中台 1.3（VPS 部署手册）

本文基于当前仓库源码（Directus monorepo + 新媒体 1.3 定制）编写，目标是让你在 VPS 上稳定启动并长期运行。

## 1. 部署目标

- 单机部署（1 台 VPS）
- Node.js `22.x`，pnpm `10.x`
- 默认数据库：SQLite（适合 5 人以内团队）
- 对外访问：`https://your-domain.com/admin`
- 进程守护：`systemd`
- 反向代理：`Nginx`

## 2. VPS 环境准备（Ubuntu 22.04/24.04）

```bash
sudo apt update
sudo apt install -y git curl build-essential nginx
```

安装 Node.js 22（任选其一，下面示例使用 fnm）：

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

复制模板：

```bash
cd /srv/directus_xy/api
cp env.new-media.example .env.new-media
cp .env.new-media .env
```

编辑 `api/.env`，至少确认这些项：

```env
KEY=<32字节以上随机字符串>
SECRET=<32字节以上随机字符串>

HOST=0.0.0.0
PORT=8055
PUBLIC_URL=https://your-domain.com

DB_CLIENT=sqlite3
DB_FILENAME=./data/new-media.db

SERVE_APP=true
WEBSOCKETS_ENABLED=true

ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=<请改成强密码>
```

说明：

- `SERVE_APP=true`：生产环境由 API 直接托管 `/admin` 前端资源
- `PUBLIC_URL` 必须是你的公网域名（建议 https）
- 若后续切换 PostgreSQL，只需改 `DB_*` 配置

## 5. 安装依赖并构建

在仓库根目录执行：

```bash
cd /srv/directus_xy
pnpm install --frozen-lockfile
pnpm build
```

## 6. 首次初始化

### 6.1 初始化 Directus 系统表与管理员

```bash
cd /srv/directus_xy/api
mkdir -p data uploads extensions
pnpm cli bootstrap
```

### 6.2 启动 API（临时）并执行新媒体业务初始化

终端 A：

```bash
cd /srv/directus_xy/api
NODE_ENV=production node dist/start.js
```

终端 B：

```bash
cd /srv/directus_xy
DIRECTUS_URL=http://127.0.0.1:8055 \
DIRECTUS_ADMIN_EMAIL=admin@example.com \
DIRECTUS_ADMIN_PASSWORD=<与你.env一致> \
pnpm new-media:init
```

完成后，终端 A 可 `Ctrl+C` 停掉临时进程。

## 7. 配置 systemd 常驻服务

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

加载并启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable new-media
sudo systemctl start new-media
sudo systemctl status new-media
```

查看日志：

```bash
journalctl -u new-media -f
```

## 8. 配置 Nginx 反向代理

创建站点配置：

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

可选（推荐）启用 HTTPS：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

## 9. 启动后验证

```bash
curl -sSf http://127.0.0.1:8055/server/ping
curl -sI https://your-domain.com/admin
```

浏览器打开：

- `https://your-domain.com/admin`

默认账号（如未改）：

- `admin@example.com / <你在 .env 设置的管理员密码>`
- `creator@example.com / Demo@123456`
- `reviewer@example.com / Demo@123456`

## 10. 后续更新流程（代码升级）

```bash
cd /srv/directus_xy
git pull origin main
pnpm install --frozen-lockfile
pnpm build
pnpm new-media:init
sudo systemctl restart new-media
```

说明：

- `pnpm new-media:init` 是幂等的，建议每次升级后执行一次，用于同步字段、权限、汉化等配置

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

### 12.1 `/admin` 打不开

- 先查服务：`sudo systemctl status new-media`
- 再查 API：`curl -sSf http://127.0.0.1:8055/server/ping`
- 再查 Nginx：`sudo nginx -t && sudo systemctl status nginx`

### 12.2 登录后偶发 400（refresh）

- 常见是 refresh token 失效或 cookie 异常
- 先确认服务正常：`curl -sI https://your-domain.com/admin`
- 浏览器重新登录通常可恢复

### 12.3 端口冲突

```bash
lsof -nP -iTCP:8055 -sTCP:LISTEN
```

若被其他进程占用，先停掉冲突进程或改 `PORT`。

---

如果你希望，我可以下一步再给你补一份“生产加固版”（非 root 用户运行、logrotate、自动备份、PostgreSQL 迁移脚本、灰度发布脚本）。
