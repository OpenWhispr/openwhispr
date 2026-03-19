#!/bin/bash

# Navigate to project directory
cd "$(dirname "$0")"

# Colors for TUI
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color
BOLD='\033[1m'

# Function to show menu and get choice
show_menu() {
    clear
    echo -e "${CYAN}╔════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║${NC}        ${BOLD}🎙️  OpenWhispr Launcher  🎙️${NC}         ${CYAN}║${NC}"
    echo -e "${CYAN}╚════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "${BOLD}Select a mode to run:${NC}"
    echo ""
    echo -e "  ${GREEN}1)${NC} ${BOLD}Production${NC} (npm start)"
    echo -e "     ${YELLOW}→ Uses pre-built UI, faster startup${NC}"
    echo ""
    echo -e "  ${GREEN}2)${NC} ${BOLD}Development${NC} (npm run dev)"
    echo -e "     ${YELLOW}→ Hot reload, DevTools, live UI updates${NC}"
    echo ""
    echo -e "  ${GREEN}3)${NC} ${BOLD}Build & Run${NC} (npm run build:renderer && npm start)"
    echo -e "     ${YELLOW}→ Rebuild UI first, then run production${NC}"
    echo ""
    echo -e "  ${BLUE}q)${NC} Quit"
    echo ""
    echo -e "${CYAN}────────────────────────────────────────────${NC}"
    echo -n "Enter choice [1-3, q]: "
}

# Main execution
show_menu

# Read user input - use /dev/tty to ensure it works when double-clicked
read -r choice < /dev/tty

echo ""

case $choice in
    1)
        echo -e "${GREEN}▶ Starting Production Mode...${NC}"
        echo ""
        npm start
        ;;
    2)
        echo -e "${GREEN}▶ Starting Development Mode...${NC}"
        echo ""
        npm run dev
        ;;
    3)
        echo -e "${GREEN}▶ Building UI and Starting Production Mode...${NC}"
        echo ""
        npm run build:renderer && npm start
        ;;
    q|Q)
        echo -e "${YELLOW}Goodbye! 👋${NC}"
        exit 0
        ;;
    *)
        echo -e "${YELLOW}Invalid choice. Defaulting to Production Mode...${NC}"
        echo ""
        npm start
        ;;
esac
