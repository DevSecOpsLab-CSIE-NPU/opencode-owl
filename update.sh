#!/bin/bash
# OpenCode Memory System Plugin Updater
# Usage: ./update.sh [--force]
#   --force: Skip version check and force update

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Paths
PLUGIN_NAME="memory-system"
OPENCODE_CONFIG_DIR="${HOME}/.config/opencode"
PLUGIN_DIR="${OPENCODE_CONFIG_DIR}/plugins/${PLUGIN_NAME}"
REPO_URL="https://github.com/DevSecOpsLab-CSIE-NPU/opencode-owl.git"
REPO_DIR="/tmp/opencode-owl-update"

log_info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $1"; }

FORCE="${1:-}"

# Check for required tools
if ! command -v bun &> /dev/null; then
    log_error "bun is required but not installed."
    exit 1
fi

if ! command -v git &> /dev/null; then
    log_error "git is required but not installed."
    exit 1
fi

# Get current installed version
CURRENT_VERSION=""
if [ -f "${PLUGIN_DIR}/package.json" ]; then
    CURRENT_VERSION=$(grep '"version"' "${PLUGIN_DIR}/package.json" | head -1 | sed 's/.*: *"\(.*\)".*/\1/')
fi

log_info "Current version: ${CURRENT_VERSION:-unknown}"
log_info "Checking for updates..."

# Fetch latest release tag from GitHub
LATEST_TAG=$(curl -fsSL "https://api.github.com/repos/DevSecOpsLab-CSIE-NPU/opencode-owl/releases/latest" 2>/dev/null | grep '"tag_name"' | sed 's/.*: *"\(.*\)".*/\1/' || echo "")

if [ -z "$LATEST_TAG" ]; then
    log_warn "Could not fetch latest version from GitHub. Falling back to git pull."
    
    # Try git pull if repo exists
    if [ -d "${PLUGIN_DIR}/.git" ]; then
        cd "${PLUGIN_DIR}"
        git pull
        bun install
        bun run build
        cp -r dist/* "${PLUGIN_DIR}/"
        cp package.json "${PLUGIN_DIR}/"
        log_success "Updated via git pull."
        echo ""
        log_warn "Restart OpenCode to activate the new version."
        exit 0
    else
        log_error "No git repo found in ${PLUGIN_DIR}. Please reinstall manually."
        exit 1
    fi
fi

LATEST_VERSION="${LATEST_TAG#v}"

if [ "$CURRENT_VERSION" = "$LATEST_VERSION" ] && [ "$FORCE" != "--force" ]; then
    log_success "Already up to date (v${CURRENT_VERSION})."
    exit 0
fi

log_info "New version available: v${CURRENT_VERSION:-?} → v${LATEST_VERSION}"

# Clean up previous update dir
rm -rf "${REPO_DIR}"

# Clone latest release
log_info "Downloading v${LATEST_VERSION}..."
git clone --depth 1 --branch "${LATEST_TAG}" "${REPO_URL}" "${REPO_DIR}" 2>/dev/null

# Build
log_info "Building..."
cd "${REPO_DIR}"
bun install
bun run build

# Install
log_info "Installing to ${PLUGIN_DIR}..."
mkdir -p "${PLUGIN_DIR}"
cp -r dist/* "${PLUGIN_DIR}/"
cp package.json "${PLUGIN_DIR}/"

# Clean up
rm -rf "${REPO_DIR}"

echo ""
log_success "Updated to v${LATEST_VERSION}!"
echo ""
log_warn "Restart OpenCode to activate the new version."
