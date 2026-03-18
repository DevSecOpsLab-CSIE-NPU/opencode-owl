#!/bin/bash
# OpenCode Memory System Plugin Installer
# Usage: ./install.sh [--uninstall]

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Paths
PLUGIN_NAME="memory-system"
OPENCODE_CONFIG_DIR="${HOME}/.config/opencode"
PLUGIN_DIR="${OPENCODE_CONFIG_DIR}/plugins/${PLUGIN_NAME}"
DATA_DIR="${HOME}/.local/share/opencode/memory"
OPENCODE_JSON="${OPENCODE_CONFIG_DIR}/opencode.json"

# Script directory (where this script is located)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

uninstall() {
    log_info "Uninstalling OpenCode Memory System Plugin..."
    
    if [ -d "$PLUGIN_DIR" ]; then
        rm -rf "$PLUGIN_DIR"
        log_success "Removed plugin directory: $PLUGIN_DIR"
    else
        log_warn "Plugin directory not found: $PLUGIN_DIR"
    fi
    
    # Remove from opencode.json if exists
    if [ -f "$OPENCODE_JSON" ]; then
        if command -v jq &> /dev/null; then
            # Use jq to remove plugin from array
            tmp=$(mktemp)
            jq 'if .plugin then .plugin = [.plugin[] | select(. != "./plugins/memory-system")] else . end' "$OPENCODE_JSON" > "$tmp"
            mv "$tmp" "$OPENCODE_JSON"
            log_success "Removed plugin from opencode.json"
        else
            log_warn "jq not found. Please manually remove './plugins/memory-system' from $OPENCODE_JSON"
        fi
    fi
    
    log_info "Data directory preserved at: $DATA_DIR"
    log_info "To completely remove data, run: rm -rf $DATA_DIR"
    
    log_success "Uninstallation complete!"
    exit 0
}

install() {
    log_info "Installing OpenCode Memory System Plugin..."
    
    # Check for bun
    if ! command -v bun &> /dev/null; then
        log_error "bun is required but not installed."
        log_info "Install bun: curl -fsSL https://bun.sh/install | bash"
        exit 1
    fi
    
    # Create directories
    mkdir -p "$PLUGIN_DIR"
    mkdir -p "$DATA_DIR"
    log_success "Created directories"
    
    # Check if we're in the package directory or need to build
    if [ -f "${SCRIPT_DIR}/src/index.ts" ]; then
        log_info "Building from source..."
        cd "$SCRIPT_DIR"
        
        # Install dependencies
        bun install
        
        # Build
        bun run build
        
        # Copy dist to plugin directory
        cp -r dist/* "$PLUGIN_DIR/"
        cp package.json "$PLUGIN_DIR/"
        
        log_success "Built and installed plugin"
    elif [ -f "${SCRIPT_DIR}/dist/index.js" ]; then
        # Pre-built, just copy
        log_info "Installing pre-built plugin..."
        cp -r "${SCRIPT_DIR}/dist/"* "$PLUGIN_DIR/"
        cp "${SCRIPT_DIR}/package.json" "$PLUGIN_DIR/"
        log_success "Installed pre-built plugin"
    else
        log_error "Cannot find source or built files. Please run from package directory."
        exit 1
    fi
    
    # Ensure sql-wasm.wasm is present
    if [ ! -f "$PLUGIN_DIR/sql-wasm.wasm" ]; then
        if [ -f "${SCRIPT_DIR}/node_modules/sql.js/dist/sql-wasm.wasm" ]; then
            cp "${SCRIPT_DIR}/node_modules/sql.js/dist/sql-wasm.wasm" "$PLUGIN_DIR/"
            log_success "Copied sql-wasm.wasm"
        else
            log_warn "sql-wasm.wasm not found. Plugin may not work correctly."
        fi
    fi
    
    # Configure opencode.json
    if [ ! -f "$OPENCODE_JSON" ]; then
        log_info "Creating opencode.json..."
        echo '{"plugin": ["./plugins/memory-system"]}' > "$OPENCODE_JSON"
        log_success "Created opencode.json with memory plugin"
    else
        # Check if plugin already configured
        if grep -q "memory-system" "$OPENCODE_JSON"; then
            log_info "Plugin already configured in opencode.json"
        else
            log_info "Adding plugin to opencode.json..."
            if command -v jq &> /dev/null; then
                tmp=$(mktemp)
                jq 'if .plugin then .plugin += ["./plugins/memory-system"] else .plugin = ["./plugins/memory-system"] end' "$OPENCODE_JSON" > "$tmp"
                mv "$tmp" "$OPENCODE_JSON"
                log_success "Added plugin to opencode.json"
            else
                log_warn "jq not found. Please manually add './plugins/memory-system' to plugin array in $OPENCODE_JSON"
                log_info "Example: {\"plugin\": [\"./plugins/memory-system\"]}"
            fi
        fi
    fi
    
    echo ""
    log_success "Installation complete!"
    echo ""
    echo -e "${BLUE}Plugin installed to:${NC} $PLUGIN_DIR"
    echo -e "${BLUE}Data directory:${NC} $DATA_DIR"
    echo -e "${BLUE}Config file:${NC} $OPENCODE_JSON"
    echo ""
    echo -e "${GREEN}Available tools:${NC}"
    echo "  - memory_add     : Add facts, preferences, or skills"
    echo "  - memory_query   : Search memories"
    echo "  - memory_stats   : View memory statistics"
    echo "  - memory_set_task: Set current task context"
    echo ""
    echo -e "${YELLOW}Restart OpenCode to activate the plugin.${NC}"
}

# Main
case "${1:-}" in
    --uninstall|-u)
        uninstall
        ;;
    --help|-h)
        echo "OpenCode Memory System Plugin Installer"
        echo ""
        echo "Usage: $0 [OPTIONS]"
        echo ""
        echo "Options:"
        echo "  (no option)   Install the plugin"
        echo "  --uninstall   Remove the plugin"
        echo "  --help        Show this help message"
        ;;
    *)
        install
        ;;
esac
