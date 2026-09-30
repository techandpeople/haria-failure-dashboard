#!/usr/bin/env bash
# Register HARIA in the Linux applications menu so it launches like a normal app
# (a clickable icon — no terminal). Run once:  bash launch/Linux/install-linux.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"          # …/launch (absolute)
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$APPS"

if ! command -v zenity >/dev/null 2>&1 && ! command -v kdialog >/dev/null 2>&1; then
  echo "Tip: install 'zenity' so the app can show a folder picker:"
  echo "     sudo apt install zenity     # Debian/Ubuntu"
fi

chmod +x "$HERE"/*.sh 2>/dev/null || true

write_entry() {   # name  script  comment  filename
  cat > "$APPS/$4" <<EOF
[Desktop Entry]
Type=Application
Name=$1
Comment=$3
Exec=bash "$HERE/$2"
Terminal=false
Icon=utilities-system-monitor
Categories=Science;Utility;
EOF
  chmod +x "$APPS/$4" 2>/dev/null || true
}

write_entry "HARIA Dashboard"          "haria.sh"        "Failure Analysis Dashboard (playback)"        "haria.desktop"
write_entry "HARIA Dashboard (Record)" "record-haria.sh" "Record a live session from a robot (Linux)"   "haria-record.desktop"

command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS" >/dev/null 2>&1 || true

echo "Installed. Search your applications menu for 'HARIA' and click it."
echo "Remove with: rm \"$APPS/haria.desktop\" \"$APPS/haria-record.desktop\""
