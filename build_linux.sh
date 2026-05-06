#!/bin/bash
# ============================================================
#  Сборка NasalPlanner для Linux
#  Требования:
#    - Python 3.11+, установленные requirements.txt
#    - Для pywebview: системные библиотеки GTK3 + WebKit2
#        Ubuntu/Debian: sudo apt install python3-gi gir1.2-webkit2-4.0
#        Fedora:        sudo dnf install python3-gobject webkit2gtk3
# ============================================================

set -e

NAME="NasalPlanner"

rm -rf build dist "${NAME}.spec"

pyinstaller \
    --noconfirm \
    --onefile \
    --name "$NAME" \
    --add-data "static:static" \
    --add-data "preprocess.py:." \
    --add-data "session.py:." \
    --add-data "operations:operations" \
    --collect-all pymeshlab \
    --collect-all trimesh \
    --collect-submodules operations \
    entry.py

echo ""
echo "============================================================"
echo " Готово: dist/${NAME}"
echo " chmod +x dist/${NAME} && ./dist/${NAME}"
echo "============================================================"
