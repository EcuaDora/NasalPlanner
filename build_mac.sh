#!/bin/bash
# ============================================================
#  Сборка NasalPlanner.app для macOS
#  Требования: Python 3.11+, установленные requirements.txt
# ============================================================

set -e

NAME="NasalPlanner"

rm -rf build dist "${NAME}.spec"

pyinstaller \
    --noconfirm \
    --onefile \
    --windowed \
    --name "$NAME" \
    --add-data "static:static" \
    --add-data "preprocess.py:." \
    --add-data "session.py:." \
    --add-data "operations:operations" \
    --collect-all pymeshlab \
    --collect-all trimesh \
    --collect-submodules operations \
    --osx-bundle-identifier "com.example.nasalplanner" \
    entry.py

echo ""
echo "============================================================"
echo " Готово: dist/${NAME}.app (и dist/${NAME} — CLI-бинарник)"
echo ""
echo " Для раздачи врачам:"
echo "   - ZIP-ни dist/${NAME}.app"
echo "   - Или подпиши через codesign + notarize (иначе Gatekeeper"
echo "     ругнётся на первом запуске — лечится правой кнопкой -> Open)"
echo "============================================================"
