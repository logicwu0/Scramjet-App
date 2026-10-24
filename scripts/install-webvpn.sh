#!/usr/bin/env bash

set -Eeuo pipefail

NODE_VERSION="${NODE_VERSION:-22.23.4}"
PNPM_VERSION="${PNPM_VERSION:-10.18.3}"
REPO_URL="${REPO_URL:-https://github.com/logicwu0/Scramjet-App.git}"
INSTALL_DIR="${INSTALL_DIR:-/opt/webvpn}"
SERVICE_NAME="${SERVICE_NAME:-webvpn}"
SERVICE_USER="${SERVICE_USER:-webvpn}"
PORT="${PORT:-8080}"
ALLOW_PRIVATE_IPS="${ALLOW_PRIVATE_IPS:-0}"

log() {
  printf '\n[%s] %s\n' "$(date '+%H:%M:%S')" "$*"
}

fail() {
  printf '\n安装失败：%s\n' "$*" >&2
  exit 1
}

if [[ "${EUID}" -ne 0 ]]; then
  fail "请使用 sudo 运行：sudo bash $0"
fi

if [[ ! -r /etc/os-release ]]; then
  fail "无法识别操作系统。"
fi

# shellcheck disable=SC1091
source /etc/os-release
if [[ "${ID:-}" != "ubuntu" ]]; then
  fail "此脚本仅支持 Ubuntu Server，当前系统为 ${PRETTY_NAME:-未知系统}。"
fi

case "$(uname -m)" in
  x86_64|amd64)
    node_arch="x64"
    ;;
  *)
    fail "此脚本仅支持 AMD64/x86-64，当前架构为 $(uname -m)。"
    ;;
esac

if [[ "${ALLOW_PRIVATE_IPS}" != "0" && "${ALLOW_PRIVATE_IPS}" != "1" ]]; then
  fail "ALLOW_PRIVATE_IPS 只能设置为 0 或 1。"
fi

if [[ ! "${PORT}" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
  fail "PORT 必须是 1 到 65535 之间的数字。"
fi

if [[ -e "${INSTALL_DIR}" ]] && [[ -n "$(find "${INSTALL_DIR}" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
  fail "${INSTALL_DIR} 已存在且不是空目录。为避免覆盖现有文件，脚本已停止。"
fi

work_tmp="$(mktemp -d /tmp/webvpn-install.XXXXXX)"
cleanup() {
  case "${work_tmp}" in
    /tmp/webvpn-install.*)
      rm -rf -- "${work_tmp}"
      ;;
  esac
}
trap cleanup EXIT

log "安装系统依赖"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git nginx python3 make g++ xz-utils

node_file="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"
node_base_url="https://nodejs.org/dist/v${NODE_VERSION}"

if command -v node >/dev/null 2>&1 && [[ "$(node -v)" == "v${NODE_VERSION}" ]]; then
  log "Node.js v${NODE_VERSION} 已安装"
else
  log "下载并校验 Node.js v${NODE_VERSION}"
  curl --fail --location --retry 3 \
    --output "${work_tmp}/${node_file}" \
    "${node_base_url}/${node_file}"
  curl --fail --location --retry 3 \
    --output "${work_tmp}/SHASUMS256.txt" \
    "${node_base_url}/SHASUMS256.txt"

  (
    cd "${work_tmp}"
    grep " ${node_file}$" SHASUMS256.txt | sha256sum --check --strict
  )

  log "安装 Node.js v${NODE_VERSION}"
  tar -xJf "${work_tmp}/${node_file}" -C /usr/local --strip-components=1
fi

log "安装 pnpm ${PNPM_VERSION}"
/usr/local/bin/npm install --global "pnpm@${PNPM_VERSION}"

log "下载 WebVPN 项目"
install -d -m 0755 "${INSTALL_DIR}"
git clone --depth 1 "${REPO_URL}" "${INSTALL_DIR}"

if [[ ! -f "${INSTALL_DIR}/package.json" || ! -f "${INSTALL_DIR}/pnpm-lock.yaml" ]]; then
  fail "下载的项目缺少 package.json 或 pnpm-lock.yaml。"
fi

if ! id "${SERVICE_USER}" >/dev/null 2>&1; then
  useradd --system --home-dir "${INSTALL_DIR}" --shell /usr/sbin/nologin "${SERVICE_USER}"
fi
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}"

log "安装 WebVPN 项目依赖"
runuser -u "${SERVICE_USER}" -- env \
  HOME="${INSTALL_DIR}" \
  PATH="/usr/local/bin:/usr/bin:/bin" \
  /usr/local/bin/pnpm --dir "${INSTALL_DIR}" install --frozen-lockfile --prod

service_file="/etc/systemd/system/${SERVICE_NAME}.service"
log "创建 systemd 服务 ${SERVICE_NAME}"
cat > "${service_file}" <<EOF
[Unit]
Description=WebVPN Scramjet Service
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}
Environment=NODE_ENV=production
Environment=PORT=${PORT}
Environment=ALLOW_PRIVATE_IPS=${ALLOW_PRIVATE_IPS}
ExecStart=/usr/local/bin/node ${INSTALL_DIR}/src/index.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}.service"

log "检查服务"
if ! systemctl is-active --quiet "${SERVICE_NAME}.service"; then
  systemctl status "${SERVICE_NAME}.service" --no-pager || true
  fail "服务没有正常启动。"
fi

if curl --fail --silent --show-error --max-time 10 \
  "http://127.0.0.1:${PORT}/" >/dev/null; then
  server_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  printf '\nWebVPN 安装完成。\n'
  printf '服务状态：systemctl status %s\n' "${SERVICE_NAME}"
  printf '查看日志：journalctl -u %s -f\n' "${SERVICE_NAME}"
  printf '本机测试：http://127.0.0.1:%s/\n' "${PORT}"
  if [[ -n "${server_ip}" ]]; then
    printf '局域网测试：http://%s:%s/\n' "${server_ip}" "${PORT}"
  fi
else
  systemctl status "${SERVICE_NAME}.service" --no-pager || true
  fail "服务已经启动，但本机 HTTP 检查失败。"
fi
