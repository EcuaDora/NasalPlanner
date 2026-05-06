@echo off
REM ============================================================
REM  Сборка NasalPlanner.exe для Windows
REM  Требования: Python 3.11+ в PATH, установленные requirements.txt
REM ============================================================

setlocal
set NAME=NasalPlanner

REM Чистим предыдущие сборки
if exist build rmdir /s /q build
if exist dist rmdir /s /q dist
if exist %NAME%.spec del %NAME%.spec

pyinstaller ^
    --noconfirm ^
    --onefile ^
    --windowed ^
    --name %NAME% ^
    --add-data "static;static" ^
    --add-data "preprocess.py;." ^
    --add-data "session.py;." ^
    --add-data "operations;operations" ^
    --collect-all pymeshlab ^
    --collect-all trimesh ^
    --collect-submodules operations ^
    --hidden-import pkg_resources.py2_warn ^
    entry.py

if errorlevel 1 (
    echo.
    echo [!] Сборка упала. См. лог выше.
    exit /b 1
)

echo.
echo ============================================================
echo  Готово: dist\%NAME%.exe
echo  Положи рядом preprocess.py и static\nasal-planner.html
echo  перед запуском (они уже вшиты в exe, это на случай dev-режима)
echo ============================================================
endlocal
