#!/bin/bash
# OpenCode-Owl — Claude Code MCP Installer
# Registers opencode-owl as an MCP server in Claude Code's config.
#
# Usage:
#   ./install-claude.sh              # install (project scope)
#   ./install-claude.sh --global     # install to ~/.claude/ (all projects)
#   ./install-claude.sh --uninstall  # remove

set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
log_info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $1"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_NAME="opencode-owl"
STDIO_ENTRY="${SCRIPT_DIR}/dist/mcp-stdio.js"

# ── Parse args ────────────────────────────────────────────────────────────────
GLOBAL=false
UNINSTALL=false
for arg in "$@"; do
  case "$arg" in
    --global)    GLOBAL=true ;;
    --uninstall) UNINSTALL=true ;;
    --help|-h)
      echo "Usage: $0 [--global] [--uninstall]"
      echo "  (no flag)    Install for current project (.claude/mcp.json)"
      echo "  --global     Install globally (~/.claude/claude_desktop_config.json)"
      echo "  --uninstall  Remove opencode-owl from Claude Code config"
      exit 0 ;;
  esac
done

if $GLOBAL; then
  # Global: Claude Code reads ~/.claude/mcp.json for user-level MCP servers
  CONFIG_FILE="${HOME}/.claude/mcp.json"
  CONFIG_DIR="${HOME}/.claude"
else
  # Project: Claude Code reads .mcp.json in the project root
  CONFIG_FILE="${PWD}/.mcp.json"
  CONFIG_DIR="${PWD}"
fi

# ── Helpers ───────────────────────────────────────────────────────────────────
ensure_jq() {
  if ! command -v jq &>/dev/null; then
    log_error "jq is required. Install with: sudo apt install jq"
    exit 1
  fi
}

build_if_needed() {
  if [ ! -f "$STDIO_ENTRY" ]; then
    log_info "Building from source..."
    if ! command -v bun &>/dev/null; then
      log_error "bun is required. Install: curl -fsSL https://bun.sh/install | bash"
      exit 1
    fi
    cd "$SCRIPT_DIR"
    bun install --silent
    bun run build
    log_success "Build complete"
  fi
}

# ── Uninstall ─────────────────────────────────────────────────────────────────
if $UNINSTALL; then
  ensure_jq
  if [ ! -f "$CONFIG_FILE" ]; then
    log_warn "Config not found: $CONFIG_FILE"
    exit 0
  fi
  tmp=$(mktemp)
  jq "del(.mcpServers[\"${SERVER_NAME}\"])" "$CONFIG_FILE" > "$tmp" && mv "$tmp" "$CONFIG_FILE"
  log_success "Removed ${SERVER_NAME} from ${CONFIG_FILE}"
  exit 0
fi

# ── Install ───────────────────────────────────────────────────────────────────
ensure_jq
build_if_needed

if $GLOBAL; then mkdir -p "$CONFIG_DIR"; fi

# Create config file if missing
if [ ! -f "$CONFIG_FILE" ]; then
  echo '{"mcpServers":{}}' > "$CONFIG_FILE"
fi

# Ensure mcpServers key exists
tmp=$(mktemp)
jq 'if .mcpServers then . else .mcpServers = {} end' "$CONFIG_FILE" > "$tmp" && mv "$tmp" "$CONFIG_FILE"

# Check if already registered
if jq -e ".mcpServers[\"${SERVER_NAME}\"]" "$CONFIG_FILE" &>/dev/null; then
  log_info "${SERVER_NAME} already registered in ${CONFIG_FILE}"
  log_info "Updating entry..."
fi

# Register the MCP server
tmp=$(mktemp)
jq ".mcpServers[\"${SERVER_NAME}\"] = {
  \"command\": \"bun\",
  \"args\": [\"${STDIO_ENTRY}\"],
  \"env\": {}
}" "$CONFIG_FILE" > "$tmp" && mv "$tmp" "$CONFIG_FILE"

log_success "Registered ${SERVER_NAME} in ${CONFIG_FILE}"
echo ""
echo -e "${BLUE}Config:${NC} ${CONFIG_FILE}"
echo -e "${BLUE}Entry:${NC}  ${STDIO_ENTRY}"
echo ""
echo -e "${GREEN}Available MCP tools:${NC}"
echo "  - memory_query          : Search owl memory"
echo "  - memory_add            : Store a new memory"
echo "  - memory_stats          : Memory statistics"
echo "  - memory_start_episode  : Begin a learning episode"
echo "  - memory_end_episode    : End episode, promote lessons"
echo "  - owl_status            : System status"
echo "  - ahe_status            : AHE eval status"
echo "  - ahe_run_eval          : Run evaluation suite"
echo "  - ahe_analyze_failures  : Analyze eval failures"
echo ""
if $GLOBAL; then
  echo -e "${YELLOW}Restart Claude Code to activate.${NC}"
else
  echo -e "${YELLOW}Restart Claude Code (or reload MCP) to activate.${NC}"
  echo -e "${YELLOW}For global install, run: ./install-claude.sh --global${NC}"
fi
