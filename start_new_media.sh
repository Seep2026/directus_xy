#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$ROOT_DIR/api"
APP_DIR="$ROOT_DIR/app"
LOG_DIR="$ROOT_DIR/.run/new-media"
API_LOG="$LOG_DIR/api.log"
APP_LOG="$LOG_DIR/app.log"
DB_FILE="$API_DIR/data/new-media.db"
TMP_DIR="$ROOT_DIR/.run/tmp"
ENV_TEMPLATE_FILE="$API_DIR/env.new-media.example"
ENV_NEW_MEDIA_FILE="$API_DIR/.env.new-media"
ENV_FILE="$API_DIR/.env"

INIT_ONLY=0
DETACH=0

for arg in "$@"; do
	if [[ "$arg" == "--init-only" ]]; then
		INIT_ONLY=1
	elif [[ "$arg" == "--detach" ]]; then
		DETACH=1
	fi
done

mkdir -p "$LOG_DIR" "$TMP_DIR" "$API_DIR/data" "$API_DIR/extensions" "$API_DIR/uploads"

if [[ ! -f "$ENV_NEW_MEDIA_FILE" ]]; then
	if [[ -f "$ENV_TEMPLATE_FILE" ]]; then
		cp "$ENV_TEMPLATE_FILE" "$ENV_NEW_MEDIA_FILE"
		echo "[new-media] 未检测到 api/.env.new-media，已从模板自动生成。"
		echo "[new-media] 如用于生产环境，请先编辑 api/.env.new-media 后再启动。"
	else
		echo "[new-media] 缺少环境文件与模板："
		echo "  - $ENV_NEW_MEDIA_FILE"
		echo "  - $ENV_TEMPLATE_FILE"
		echo "[new-media] 请先创建其中一个文件后重试。"
		exit 1
	fi
fi

if [[ ! -f "$ENV_FILE" ]]; then
	cp "$ENV_NEW_MEDIA_FILE" "$ENV_FILE"
fi

if [[ ! -f "$DB_FILE" ]]; then
	echo "[new-media] 检测到首次运行，执行 bootstrap..."
	(
		cd "$API_DIR"
		pnpm cli bootstrap
	)
fi

API_PID=""
APP_PID=""

cleanup() {
	if [[ -n "$APP_PID" ]] && kill -0 "$APP_PID" >/dev/null 2>&1; then
		kill "$APP_PID" >/dev/null 2>&1 || true
	fi

	if [[ -n "$API_PID" ]] && kill -0 "$API_PID" >/dev/null 2>&1; then
		kill "$API_PID" >/dev/null 2>&1 || true
	fi
}

wait_for_api() {
	local retries=60

	for ((i = 1; i <= retries; i++)); do
		if curl -fsS "http://localhost:8055/server/ping" >/dev/null 2>&1; then
			return 0
		fi
		sleep 1
	done

	return 1
}

wait_for_app() {
	local retries=60

	for ((i = 1; i <= retries; i++)); do
		if curl -fsS "http://localhost:8080/admin" >/dev/null 2>&1; then
			return 0
		fi
		sleep 1
	done

	return 1
}

trap cleanup INT TERM

echo "[new-media] 启动 API..."
echo "[$(date '+%Y-%m-%d %H:%M:%S')] start api" >>"$API_LOG"
(
	cd "$API_DIR"
	TMPDIR="$TMP_DIR" pnpm dev
) >>"$API_LOG" 2>&1 &
API_PID=$!

if ! wait_for_api; then
	echo "[new-media] API 启动超时，请检查日志: $API_LOG"
	cleanup
	exit 1
fi

echo "[new-media] 执行业务初始化..."
(
	cd "$ROOT_DIR"
	pnpm new-media:init
)

if [[ "$INIT_ONLY" -eq 1 ]]; then
	echo "[new-media] 初始化已完成（--init-only），未启动 App。"
	cleanup
	exit 0
fi

echo "[new-media] 启动 App..."
echo "[$(date '+%Y-%m-%d %H:%M:%S')] start app" >>"$APP_LOG"
(
	cd "$APP_DIR"
	TMPDIR="$TMP_DIR" pnpm dev --host 0.0.0.0 --port 8080
) >>"$APP_LOG" 2>&1 &
APP_PID=$!

if ! wait_for_app; then
	echo "[new-media] App 启动超时，请检查日志: $APP_LOG"
	cleanup
	exit 1
fi

echo
echo "新媒体内容中台 2.0 已启动"
echo "API: http://localhost:8055"
echo "App: http://localhost:8080/admin"
echo "API 日志: $API_LOG"
echo "App 日志: $APP_LOG"
echo
echo "默认账号："
echo "  admin@example.com / admin12345678"
echo "  creator@example.com / Demo@123456"
echo "  reviewer@example.com / Demo@123456"
echo
if [[ "$DETACH" -eq 1 ]]; then
	echo "已后台启动（--detach），可用以下命令查看日志："
	echo "  tail -f $API_LOG"
	echo "  tail -f $APP_LOG"
	exit 0
fi

echo "按 Ctrl+C 停止服务（前台模式）。"

wait "$API_PID" "$APP_PID"
