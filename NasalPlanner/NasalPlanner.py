r"""
NasalPlanner — 3D Slicer Module
=========================================================

Тонкая обёртка Slicer для запуска nasal-planner-приложения.

Что делает модуль:
  1. Выбрать Model в сцене
  2. Нажать «Открыть в Nasal Unwrap» — Slicer экспортирует .obj
     (с RAS → LPS конверсией для совпадения ориентации с прямым
      открытием .obj в Nasal Planner)
  3. Запускается «Nasal Planner.exe --load <obj>» (либо dev-fallback на venv)
  4. Приложение само открывается со загруженной моделью


Авто-определение режима:
  • если найден .exe (через ENV / settings / автопоиск) → exe-mode
  • иначе пытаемся найти venv → dev-mode
  • если ничего нет — UI попросит указать пути в «Настройки»

"""

from __future__ import annotations

import atexit
import logging
import os
import subprocess
import sys
import time
import traceback
from typing import Optional

import qt
import vtk
import slicer
from slicer.ScriptedLoadableModule import (
    ScriptedLoadableModule,
    ScriptedLoadableModuleLogic,
    ScriptedLoadableModuleTest,
    ScriptedLoadableModuleWidget,
)


MODULE_DIR = os.path.dirname(os.path.abspath(__file__))



def _resolve_exe_path() -> Optional[str]:
    """Найти Nasal Planner.exe. Порядок: ENV → QSettings → авто-поиск.

    Возвращает абсолютный путь к .exe или None.
    """
    # 1. ENV
    env_exe = os.environ.get("NASAL_PLANNER_EXE", "").strip()
    if env_exe and os.path.isfile(env_exe):
        return env_exe

    # 2. QSettings
    settings = qt.QSettings()
    saved = settings.value("NasalPlanner/exePath", "")
    if saved and os.path.isfile(saved):
        return saved

    # 3. Авто-поиск в типичных местах рядом с MODULE_DIR
    candidates = [
        os.path.join(MODULE_DIR, "Nasal Planner.exe"),
        os.path.join(MODULE_DIR, "Nasal Planner", "Nasal Planner.exe"),
        os.path.join(MODULE_DIR, "..", "Nasal Planner", "Nasal Planner.exe"),
        os.path.join(MODULE_DIR, "..", "dist", "Nasal Planner", "Nasal Planner.exe"),
        os.path.join(MODULE_DIR, "..", "..", "Nasal Planner", "Nasal Planner.exe"),
        os.path.join(MODULE_DIR, "..", "..", "dist", "Nasal Planner", "Nasal Planner.exe"),
    ]
    for p in candidates:
        p = os.path.normpath(p)
        if os.path.isfile(p):
            return p

    return None


def _resolve_dev_paths() -> tuple[Optional[str], Optional[str]]:
    """Найти dev-пути: (project_root, venv_python).

    project_root — папка где лежат entry.py + server.py + static/.
    venv_python — python.exe из venv проекта.
    Любой может быть None.
    """
    settings = qt.QSettings()

    # ─── project root ───────────────────────────────────────────────────────
    candidates_root = []
    env_root = os.environ.get("NASAL_PLANNER_ROOT", "").strip()
    if env_root:
        candidates_root.append(env_root)
    saved_root = settings.value("NasalPlanner/projectRoot", "")
    if saved_root:
        candidates_root.append(saved_root)
    candidates_root.append(os.path.normpath(os.path.join(MODULE_DIR, "..")))

    project_root = None
    for path in candidates_root:
        if (os.path.isfile(os.path.join(path, "entry.py"))
                and os.path.isdir(os.path.join(path, "static"))):
            project_root = path
            break

    # ─── venv python ────────────────────────────────────────────────────────
    venv_python = None
    env_venv = os.environ.get("NASAL_PLANNER_VENV_PYTHON", "").strip()
    if env_venv and os.path.isfile(env_venv):
        venv_python = env_venv
    else:
        saved_venv = settings.value("NasalPlanner/venvPython", "")
        if saved_venv and os.path.isfile(saved_venv):
            venv_python = saved_venv
        elif project_root is not None:
            for parts in [
                ("venv", "Scripts", "python.exe"),
                ("venv", "bin", "python"),
                (".venv", "Scripts", "python.exe"),
                (".venv", "bin", "python"),
            ]:
                p = os.path.join(project_root, *parts)
                if os.path.isfile(p):
                    venv_python = p
                    break

    return project_root, venv_python


def _browse_file(line_edit, title: str = "", filter_str: str = "", folder=False):
    """Дёрнуть QFileDialog. PythonQt-style: возвращает строку, не tuple."""
    if folder:
        p = qt.QFileDialog.getExistingDirectory(None, title or "Выберите папку")
    else:
        p = qt.QFileDialog.getOpenFileName(
            None, title or "Выберите файл", "",
            filter_str or "Все файлы (*)")
    if isinstance(p, tuple):
        p = p[0]
    if p:
        line_edit.setText(p)


# ════════════════════════════════════════════════════════════════════════════
#                                  Module
# ════════════════════════════════════════════════════════════════════════════
class NasalPlanner(ScriptedLoadableModule):
    def __init__(self, parent):
        ScriptedLoadableModule.__init__(self, parent)
        self.parent.title = "Nasal Unwrap"
        self.parent.categories = ["Otolaryngology"]
        self.parent.dependencies = []
        self.parent.contributors = ["Nasal Unwrap Team"]
        self.parent.helpText = (
            "Nasal Unwrap — мост между Slicer и desktop-приложением для развёртки.\n\n"
            "1. Выберите Model Node в сцене\n"
            "2. Нажмите «Открыть в Nasal Unwrap»\n"
            "3. Slicer экспортирует .obj (с RAS → LPS конверсией) и запустит\n"
            "   Nasal Planner.exe\n"
            "4. Модель будет автоматически загружена в приложение"
        )
        self.parent.acknowledgementText = ""


        try:
            icon_path = os.path.join(
                MODULE_DIR, "Resources", "Icons", "NasalPlanner.png")
            if os.path.isfile(icon_path):
                self.parent.icon = qt.QIcon(icon_path)
        except Exception as e:
            logging.warning(f"[NasalPlanner] module icon load failed: {e}")


# ════════════════════════════════════════════════════════════════════════════
#                              QSS-тема (light medical)
# ════════════════════════════════════════════════════════════════════════════
_THEME_QSS = """
/* === Nasal Unwrap — light medical theme === */
QWidget {
    color: #1a2b3c;
    font-family: "Segoe UI", "Inter", "Helvetica Neue", sans-serif;
    font-size: 10px;
}
QFrame#NPRoot {
    background-color: #f4f8fb;
}
QLabel { background: transparent; color: #1a2b3c; font-size: 10px; }
QLabel:disabled { color: #b0bcc8; }
QLabel#NPHeaderTitle {
    color: #0a4a6e;
    font-size: 15px;
    font-weight: 800;
    letter-spacing: 1px;
    padding: 0;
}
QLabel#NPHeaderSub {
    color: #6b8faa;
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 2px;
    padding: 0;
}
QLabel#NPStatus {
    background: #eaf6fa;
    border: 1px solid #c5e1ec;
    border-radius: 6px;
    padding: 8px 12px;
    color: #4a6b82;
    font-size: 10px;
    font-weight: 600;
}

/* Group boxes — light cards */
QGroupBox {
    background-color: #ffffff;
    border: 1px solid #d6e4ef;
    border-radius: 8px;
    margin-top: 16px;
    padding: 18px 14px 14px 14px;
    font-weight: 700;
    color: #0a4a6e;
}
QGroupBox::title {
    subcontrol-origin: margin;
    subcontrol-position: top left;
    left: 14px;
    padding: 3px 10px;
    background-color: #ffffff;
    color: #00879a;
    font-size: 9px;
    font-weight: 800;
    letter-spacing: 2px;
    border: 1px solid #b8dde6;
    border-radius: 4px;
}

QLineEdit {
    background-color: #ffffff;
    border: 1px solid #d0dde8;
    border-radius: 5px;
    padding: 6px 9px;
    color: #1a2b3c;
    selection-background-color: #b8e0e8;
    min-height: 18px;
    font-size: 10px;
}
QLineEdit:focus {
    border: 1px solid #00a8b5;
    background-color: #f7fcfd;
}
QLineEdit:read-only {
    background-color: #eef3f7;
    color: #4a6b82;
    border: 1px solid #dde5ec;
}
QLineEdit:disabled {
    background-color: #f0f4f7;
    color: #b0bcc8;
    border: 1px solid #dde5ec;
}
QPushButton:disabled {
    background-color: #f0f4f7;
    border: 1px solid #e0e8ef;
    color: #b0bcc8;
}

QPlainTextEdit {
    background-color: #fafcfd;
    border: 1px solid #d0dde8;
    border-radius: 5px;
    padding: 6px 9px;
    color: #2e4a5e;
    font-family: "Consolas", "Menlo", monospace;
    font-size: 10px;
}

/* === SELECT (combo) === */
QComboBox {
    background-color: #f7fcfd;
    border: 1px solid #00a8b5;
    border-radius: 5px;
    padding: 6px 9px;
    padding-right: 26px;
    color: #1a2b3c;
    min-height: 18px;
    font-size: 10px;
    font-weight: 600;
}
QComboBox:hover { background-color: #eaf6fa; }
QComboBox:focus { border: 1px solid #007a8f; }
QComboBox::drop-down {
    subcontrol-origin: padding;
    subcontrol-position: center right;
    width: 22px;
    border: none;
    background: transparent;
}
QComboBox::down-arrow {
    image: none;
    width: 0; height: 0;
    border-left: 4px solid transparent;
    border-right: 4px solid transparent;
    border-top: 5px solid #00879a;
    margin-right: 8px;
}
QComboBox QAbstractItemView {
    background: #ffffff;
    border: 1px solid #00a8b5;
    border-radius: 4px;
    color: #1a2b3c;
    selection-background-color: #00a8b5;
    selection-color: #ffffff;
    outline: 0;
    padding: 2px;
}
QComboBox QAbstractItemView::item {
    padding: 6px 10px;
    min-height: 22px;
    color: #1a2b3c;
    background: #ffffff;
    border-radius: 3px;
}
QComboBox QAbstractItemView::item:hover {
    background: #eaf6fa;
    color: #006978;
}
QComboBox QAbstractItemView::item:selected {
    background: #00a8b5;
    color: #ffffff;
}
QAbstractScrollArea::corner {
    background: #ffffff;
    border: none;
}

qMRMLNodeComboBox {
    background-color: #f7fcfd;
    border: 1px solid #00a8b5;
    border-radius: 5px;
    padding: 0;
    min-height: 30px;
}
qMRMLNodeComboBox:disabled {
    background-color: #f0f4f7;
    border: 1px solid #dde5ec;
}

/* Generic buttons */
QPushButton {
    background-color: #ffffff;
    border: 1px solid #c5e1ec;
    border-radius: 5px;
    padding: 6px 14px;
    color: #00879a;
    font-weight: 600;
    font-size: 10px;
    min-height: 18px;
}
QPushButton:hover {
    background-color: #eaf6fa;
    border: 1px solid #00a8b5;
    color: #006978;
}
QPushButton:pressed { background-color: #d4ecf2; }

/* Primary "Open" button */
QPushButton#NPRun {
    background: qlineargradient(x1:0, y1:0, x2:1, y2:1,
        stop:0 #0090a8, stop:1 #0090a8);
    border: 1px solid #007a8f;
    border-radius: 6px;
    color: #ffffff;
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 2px;
    padding: 10px 16px;
}
QPushButton#NPRun:hover {
    background: qlineargradient(x1:0, y1:0, x2:1, y2:1,
        stop:0 #00c8d8, stop:1 #00a0b8);
}
QPushButton#NPRun:pressed {
    background: qlineargradient(x1:0, y1:0, x2:1, y2:1,
        stop:0 #00a0b0, stop:1 #007a90);
}
QPushButton#NPRun:disabled {
    background: #e0e8ef;
    border: 1px solid #d0dde8;
    color: #a8b8c5;
}

/* "Stop" button — red */
QPushButton#NPStop {
    background: qlineargradient(x1:0, y1:0, x2:1, y2:1,
        stop:0 #d8556a, stop:1 #c8243d);
    border: 1px solid #a01a30;
    border-radius: 6px;
    color: #ffffff;
    font-weight: 800;
    font-size: 11px;
    letter-spacing: 1px;
    padding: 9px 14px;
}
QPushButton#NPStop:hover {
    background: qlineargradient(x1:0, y1:0, x2:1, y2:1,
        stop:0 #e6677c, stop:1 #d63a52);
}
QPushButton#NPStop:disabled {
    background: #e0e8ef;
    border: 1px solid #d0dde8;
    color: #a8b8c5;
}

/* Collapsible (ctk) */
ctkCollapsibleButton {
    background-color: #eaf2f7;
    border: 1px solid #d0dde8;
    border-radius: 6px;
    color: #0a4a6e;
    font-weight: 700;
    font-size: 10px;
    letter-spacing: 1px;
    padding: 7px;
}
ctkCollapsibleButton:hover { background-color: #dfeaf2; }

/* Scrollbars */
QScrollBar:vertical { background: transparent; width: 10px; margin: 0; }
QScrollBar::handle:vertical {
    background: #c5d6e0; border-radius: 4px; min-height: 24px;
}
QScrollBar::handle:vertical:hover { background: #00a8b5; }
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height: 0; }
"""


# ════════════════════════════════════════════════════════════════════════════
#                                  Widget
# ════════════════════════════════════════════════════════════════════════════
class NasalPlannerWidget(ScriptedLoadableModuleWidget):
    SETTINGS_PREFIX = "NasalPlanner/"

    def __init__(self, parent=None):
        ScriptedLoadableModuleWidget.__init__(self, parent)
        self.logic: Optional["NasalPlannerLogic"] = None

    def _createLogoWidget(self, size=48):
        """Логотип в header'е."""
        try:
            icon_path = os.path.join(
                MODULE_DIR, "Resources", "Icons", "NasalPlanner.png")
            if os.path.exists(icon_path):
                label = qt.QLabel()
                label.setStyleSheet("background: transparent; border: none;")
                label.setFixedSize(size, size)
                label.setAlignment(qt.Qt.AlignCenter)
                pix = qt.QPixmap(icon_path)
                if pix.width() >= size * 2:
                    pix.setDevicePixelRatio(pix.width() / float(size))
                    label.setPixmap(pix)
                    return label
                if not pix.isNull():
                    label.setPixmap(pix.scaled(
                        size, size, qt.Qt.KeepAspectRatio,
                        qt.Qt.SmoothTransformation))
                    return label
        except Exception as e:
            logging.warning(f"[NasalPlanner] PNG icon fallback failed: {e}")

        lbl = qt.QLabel("◆")
        lbl.setStyleSheet(
            "background: transparent; border: none;"
            "color:#0090a8; font-size:32px; font-weight:800;")
        lbl.setFixedSize(size, size)
        lbl.setAlignment(qt.Qt.AlignCenter)
        return lbl

    def setup(self):
        ScriptedLoadableModuleWidget.setup(self)

        try:
            self.parent.setStyleSheet(_THEME_QSS)
        except Exception:
            pass

        for attr in ("helpCollapsibleButton", "reloadCollapsibleButton"):
            try:
                w = getattr(self, attr, None)
                if w is not None:
                    w.setVisible(False)
            except Exception:
                pass

        try:
            self.parent.setMinimumWidth(540)
        except Exception:
            pass

        # ═══════ ROOT ═══════
        container = qt.QFrame()
        container.setObjectName("NPRoot")
        np_layout = qt.QVBoxLayout(container)
        np_layout.setContentsMargins(12, 10, 12, 10)
        np_layout.setSpacing(12)
        self.layout.addWidget(container)

        # ═══════ HEADER ═══════
        headerWidget = qt.QFrame()
        headerWidget.setObjectName("NPHeader")
        try:
            headerWidget.setAttribute(qt.Qt.WA_StyledBackground, True)
        except Exception:
            pass
        headerWidget.setStyleSheet(
            "QFrame#NPHeader {"
            " background: qlineargradient(x1:0, y1:0, x2:1, y2:0,"
            "  stop:0 #ffffff, stop:1 #eaf6fa);"
            " border: 1px solid #c5e1ec;"
            " border-radius: 8px;"
            "}")
        headerLay = qt.QHBoxLayout(headerWidget)
        headerLay.setContentsMargins(12, 8, 12, 8)
        headerLay.setSpacing(12)
        headerLay.setAlignment(qt.Qt.AlignLeft | qt.Qt.AlignVCenter)

        logoWidget = self._createLogoWidget(size=48)
        headerLay.addWidget(logoWidget, 0, qt.Qt.AlignVCenter)

        textBox = qt.QFrame()
        textLay = qt.QVBoxLayout(textBox)
        textLay.setContentsMargins(0, 0, 0, 0)
        textLay.setSpacing(4)
        title = qt.QLabel("Nasal Unwrap")
        title.setObjectName("NPHeaderTitle")
        sub = qt.QLabel("DESKTOP BRIDGE")
        sub.setObjectName("NPHeaderSub")
        textLay.addWidget(title)
        textLay.addWidget(sub)
        headerLay.addWidget(textBox, 0, qt.Qt.AlignVCenter)
        headerLay.addStretch(1)

        np_layout.addWidget(headerWidget)

        # ═══════ ВХОД ═══════
        inputBox = qt.QGroupBox("ИСХОДНАЯ МОДЕЛЬ")
        try:
            inputBox.setAttribute(qt.Qt.WA_StyledBackground, True)
        except Exception:
            pass
        inputLay = qt.QFormLayout(inputBox)
        inputLay.setLabelAlignment(qt.Qt.AlignRight)
        inputLay.setHorizontalSpacing(12)
        inputLay.setVerticalSpacing(10)

        self.modelSelector = slicer.qMRMLNodeComboBox()
        self.modelSelector.nodeTypes = ["vtkMRMLModelNode"]
        self.modelSelector.selectNodeUponCreation = False
        self.modelSelector.addEnabled = False
        self.modelSelector.removeEnabled = False
        self.modelSelector.noneEnabled = True
        self.modelSelector.showHidden = False
        self.modelSelector.showChildNodeTypes = False
        self.modelSelector.setMRMLScene(slicer.mrmlScene)
        self.modelSelector.setToolTip(
            "Модель из сцены, которая отправится в Nasal Planner.")
        inputLay.addRow("Модель из сцены:", self.modelSelector)

        np_layout.addWidget(inputBox)

        # ═══════ ГЛАВНАЯ КНОПКА + СТАТУС ═══════
        self.runButton = qt.QPushButton("ОТКРЫТЬ В NASAL UNWRAP")
        self.runButton.setObjectName("NPRun")
        self.runButton.setMinimumHeight(50)
        self.runButton.setEnabled(False)
        np_layout.addWidget(self.runButton)

        self.statusLabel = qt.QLabel("Готовлюсь…")
        self.statusLabel.setObjectName("NPStatus")
        self.statusLabel.wordWrap = True
        np_layout.addWidget(self.statusLabel)

        self.btnStop = qt.QPushButton("ЗАКРЫТЬ ОКНО ПРИЛОЖЕНИЯ")
        self.btnStop.setObjectName("NPStop")
        self.btnStop.setMinimumHeight(36)
        self.btnStop.setEnabled(False)
        self.btnStop.setToolTip(
            "Закрыть окно Nasal Planner, запущенное из Slicer.")
        np_layout.addWidget(self.btnStop)

        # ═══════ НАСТРОЙКИ ПУТЕЙ ═══════
        self.settingsCollapsible = slicer.qMRMLCollapsibleButton()
        self.settingsCollapsible.text = "⚙  НАСТРОЙКИ ПУТЕЙ"
        self.settingsCollapsible.collapsed = True
        sLay = qt.QFormLayout(self.settingsCollapsible)
        sLay.setLabelAlignment(qt.Qt.AlignRight)
        sLay.setHorizontalSpacing(12)
        sLay.setVerticalSpacing(10)

        ec = qt.QWidget()
        el = qt.QHBoxLayout(ec)
        el.setContentsMargins(0, 0, 0, 0)
        self.exeEdit = qt.QLineEdit()
        self.exeEdit.setPlaceholderText(
            "автопоиск: рядом с плагином или в ../Nasal Planner/")
        el.addWidget(self.exeEdit)
        self.exeBrowseBtn = qt.QPushButton("Обзор…")
        self.exeBrowseBtn.setMinimumWidth(80)
        el.addWidget(self.exeBrowseBtn)
        sLay.addRow("Nasal Planner.exe:", ec)

        sepLabel = qt.QLabel("— ИЛИ dev-режим (без .exe) —")
        sepLabel.setAlignment(qt.Qt.AlignCenter)
        sepLabel.setStyleSheet(
            "color:#9aaab8;font-size:9px;font-weight:600;letter-spacing:2px;"
            "padding:6px 0 2px 0;")
        sLay.addRow(sepLabel)

        rc = qt.QWidget()
        rl = qt.QHBoxLayout(rc)
        rl.setContentsMargins(0, 0, 0, 0)
        self.rootEdit = qt.QLineEdit()
        self.rootEdit.setPlaceholderText("корень проекта (с entry.py + venv/)")
        rl.addWidget(self.rootEdit)
        self.rootBrowseBtn = qt.QPushButton("Обзор…")
        self.rootBrowseBtn.setMinimumWidth(80)
        rl.addWidget(self.rootBrowseBtn)
        sLay.addRow("Корень проекта:", rc)

        vc = qt.QWidget()
        vl = qt.QHBoxLayout(vc)
        vl.setContentsMargins(0, 0, 0, 0)
        self.venvEdit = qt.QLineEdit()
        self.venvEdit.setPlaceholderText("python.exe из venv (опционально)")
        vl.addWidget(self.venvEdit)
        self.venvBrowseBtn = qt.QPushButton("Обзор…")
        self.venvBrowseBtn.setMinimumWidth(80)
        vl.addWidget(self.venvBrowseBtn)
        sLay.addRow("Python venv:", vc)

        self.savePathsBtn = qt.QPushButton("Сохранить пути")
        sLay.addRow("", self.savePathsBtn)

        np_layout.addWidget(self.settingsCollapsible)

        # ═══════ ЛОГ ═══════
        self.logCollapsible = slicer.qMRMLCollapsibleButton()
        self.logCollapsible.text = "📋  ЛОГ"
        self.logCollapsible.collapsed = True
        ll = qt.QVBoxLayout(self.logCollapsible)
        self.logTextEdit = qt.QPlainTextEdit()
        self.logTextEdit.readOnly = True
        self.logTextEdit.setMinimumHeight(150)
        self.logTextEdit.setMaximumHeight(220)
        ll.addWidget(self.logTextEdit)
        np_layout.addWidget(self.logCollapsible)
        np_layout.addStretch(1)

        self.loadSettings()

        # ─── connections ────────────────────────────────────────────────────
        self.runButton.connect("clicked(bool)", self.onOpen)
        self.btnStop.connect("clicked(bool)", self.onStop)
        self.savePathsBtn.connect("clicked(bool)", self.onSavePaths)
        self.exeBrowseBtn.connect(
            "clicked(bool)",
            lambda: _browse_file(
                self.exeEdit,
                title="Выберите Nasal Planner.exe",
                filter_str="Nasal Planner (Nasal Planner.exe);;Executable (*.exe)"))
        self.rootBrowseBtn.connect(
            "clicked(bool)",
            lambda: _browse_file(
                self.rootEdit, title="Выберите корень проекта", folder=True))
        self.venvBrowseBtn.connect(
            "clicked(bool)",
            lambda: _browse_file(
                self.venvEdit,
                title="Выберите python.exe из venv",
                filter_str="Python (python.exe python python3)"))
        self.modelSelector.connect(
            "currentNodeChanged(vtkMRMLNode*)", self._onSelectionChanged)

        self._upd()

    def cleanup(self):
        try:
            self.saveSettings()
        except Exception:
            pass
        try:
            if self.logic is not None:
                self.logic.shutdown()
        except Exception:
            pass

    # ─── helpers ────────────────────────────────────────────────────────────
    def _t(self, w):
        try:
            t = w.text
            return str(t() if callable(t) else t).strip()
        except Exception:
            return ""

    def _setPath(self, edit, path):
        edit.setText(path or "")
        try:
            edit.setCursorPosition(0)
        except Exception:
            pass

    def appendLog(self, m):
        if not m:
            return
        ts = time.strftime("%H:%M:%S")
        self.logTextEdit.appendPlainText(f"[{ts}] {str(m).rstrip()}")
        try:
            sb = self.logTextEdit.verticalScrollBar()
            sb.setValue(sb.maximum)
        except Exception:
            pass
        slicer.app.processEvents()

    def _st(self, txt, c="#4a6b82"):
        bg_map = {
            "#4a6b82": ("#eaf6fa", "#c5e1ec", "#4a6b82"),
            "#2d7d46": ("#e6f7ee", "#9fd9b8", "#1a9d5a"),
            "#c90":    ("#fff4e6", "#ffd29a", "#c8651a"),
            "#c33":    ("#fde8ec", "#f4a8b4", "#c8243d"),
        }
        bg, br, fg = bg_map.get(c, ("#eaf6fa", "#c5e1ec", c))
        self.statusLabel.setText(txt)
        self.statusLabel.setStyleSheet(
            f"background:{bg};border:1px solid {br};border-radius:6px;"
            f"padding:9px 12px;color:{fg};font-weight:600;font-size:11px;")
        slicer.app.processEvents()

    def _onSelectionChanged(self, _node):
        self._upd()

    def _upd(self):
        has_model = self.modelSelector.currentNode() is not None
        self.runButton.setEnabled(has_model)

        if not has_model:
            self._st("Выберите Model в сцене")
            return

        if self.logic is not None and self.logic.is_running():
            self._st("✓ Nasal Planner запущен", "#2d7d46")
            self.btnStop.setEnabled(True)
        else:
            exe = _resolve_exe_path()
            if exe:
                self._st(f"Готов: {os.path.basename(exe)}", "#2d7d46")
            else:
                root, venv = _resolve_dev_paths()
                if root and venv:
                    self._st("Готов (dev-режим, через venv)", "#2d7d46")
                else:
                    self._st(
                        "⚠ Не найден ни .exe, ни venv. Укажи путь в настройках.",
                        "#c90")

    # ─── settings persistence ──────────────────────────────────────────────
    def loadSettings(self):
        s = qt.QSettings()
        p = self.SETTINGS_PREFIX
        for key, edit in (
            ("exePath", self.exeEdit),
            ("projectRoot", self.rootEdit),
            ("venvPython", self.venvEdit),
        ):
            val = s.value(p + key, "") or ""
            if val:
                self._setPath(edit, val)

    def saveSettings(self):
        s = qt.QSettings()
        p = self.SETTINGS_PREFIX
        for key, edit in (
            ("exePath", self.exeEdit),
            ("projectRoot", self.rootEdit),
            ("venvPython", self.venvEdit),
        ):
            v = self._t(edit)
            if v:
                s.setValue(p + key, v)
            else:
                s.remove(p + key)

    # ─── handlers ──────────────────────────────────────────────────────────
    def onOpen(self):
        modelNode = self.modelSelector.currentNode()
        if modelNode is None:
            slicer.util.errorDisplay("Выберите Model в сцене.")
            return

        if self.logic is not None:
            self.logic.shutdown()
            self.logic = None

        self.logCollapsible.collapsed = False
        self._st("Экспорт OBJ и запуск приложения…", "#c90")

        slicer.app.setOverrideCursor(qt.Qt.WaitCursor)
        self.runButton.setEnabled(False)
        try:
            self.logic = NasalPlannerLogic(log=self.appendLog)
            self.logic.open_model(modelNode)
            self._st("✓ Nasal Planner запущен", "#2d7d46")
            self.btnStop.setEnabled(True)
            self.appendLog("[INFO] ✓ Готово")
        except Exception as e:
            self.appendLog(f"[ERROR] {e}\n{traceback.format_exc()}")
            slicer.util.errorDisplay(f"Ошибка:\n\n{e}")
            self._st(f"✗ {e}", "#c33")
            self.logic = None
        finally:
            slicer.app.restoreOverrideCursor()
            self.runButton.setEnabled(True)

    def onStop(self):
        if self.logic is None:
            return
        self.logic.shutdown()
        self.logic = None
        self._st("Окно приложения закрыто")
        self.btnStop.setEnabled(False)
        self.appendLog("[INFO] Приложение остановлено.")
        self._upd()

    def onSavePaths(self):
        self.saveSettings()
        self.appendLog("[INFO] Пути сохранены.")
        if self.logic is not None:
            self.logic.shutdown()
            self.logic = None
            self.btnStop.setEnabled(False)
        self._upd()


# ════════════════════════════════════════════════════════════════════════════
#                                  Logic
# ════════════════════════════════════════════════════════════════════════════
class NasalPlannerLogic(ScriptedLoadableModuleLogic):
    """Логика без Qt: model node → OBJ → spawn Nasal Planner.exe --load <path>.

    Если .exe не найден — fallback на dev-режим через venv-python entry.py.
    """

    # Лимит размера mesh для безопасного экспорта. Slicer'овский VTK на
    # 5M+ грани начинает segfault'ить при триангуляции, что убивает Slicer.
    # Лучше упасть с понятной ошибкой.
    MAX_CELLS_FOR_EXPORT = 5_000_000

    def __init__(self, log=None):
        ScriptedLoadableModuleLogic.__init__(self)
        self._log = log or (lambda _msg: None)
        self._proc: Optional[subprocess.Popen] = None
        atexit.register(self.shutdown)

    # ─── lifecycle ──────────────────────────────────────────────────────────
    def is_running(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def shutdown(self) -> None:
        if self._proc is None:
            return
        try:
            if self._proc.poll() is None:
                self._proc.terminate()
                try:
                    self._proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    self._proc.kill()
        except Exception as e:
            self._log(f"[WARN] shutdown error: {e}")
        finally:
            self._proc = None

    @staticmethod
    def _clean_env_for_venv() -> dict:
        env = os.environ.copy()
        for var in (
            "PYTHONHOME", "PYTHONPATH", "PYTHONSTARTUP",
            "PYTHONNOUSERSITE", "PYTHONEXECUTABLE",
            "PYTHONUSERBASE", "PYTHONDONTWRITEBYTECODE",
            "PYTHONIOENCODING",
        ):
            env.pop(var, None)
        env["PYTHONUNBUFFERED"] = "1"
        return env

    # ─── Slicer-side: model node → OBJ ─────────────────────────────────────
    @staticmethod
    def model_node_to_obj(model_node, out_path: str, log=None) -> None:
        """Экспорт vtkMRMLModelNode в .obj.

        Пайплайн:
          1. Применяем parent transform (если есть).
          2. RAS → LPS (Slicer работает в RAS, OBJ-стандарт — LPS).
             Без этого модель в Nasal Planner отображается зеркально/
             повёрнуто, не совпадает с прямым открытием .obj.
          3. Триангуляция (на случай polygon'ов).
          4. Запись через vtkOBJWriter.

        Защищён от OOM / segfault на больших мешах — отказывается экспортировать
        сцены с >5M граней (Slicer'овский VTK на таких часто падает).
        """
        if log is None:
            log = lambda _msg: None

        poly = model_node.GetPolyData()
        if poly is None or poly.GetNumberOfPoints() == 0:
            raise RuntimeError(
                f"Model node '{model_node.GetName()}' содержит пустой polydata")

        n_pts = poly.GetNumberOfPoints()
        n_cells = poly.GetNumberOfCells()
        log(f"[INFO] Исходный polydata: {n_pts:,} точек, {n_cells:,} граней")

        if n_cells > NasalPlannerLogic.MAX_CELLS_FOR_EXPORT:
            raise RuntimeError(
                f"Меш слишком большой для безопасного экспорта: "
                f"{n_cells:,} граней. Лимит {NasalPlannerLogic.MAX_CELLS_FOR_EXPORT:,}.\n"
                f"Decimate-ни модель в Slicer "
                f"(Surface Toolbox → Decimate) и попробуй ещё раз.")

        # 1) Parent transform
        parent_tf = model_node.GetParentTransformNode()
        if parent_tf is not None:
            log("[INFO] Применяю parent transform…")
            mat = vtk.vtkMatrix4x4()
            parent_tf.GetMatrixTransformToWorld(mat)
            tr = vtk.vtkTransform()
            tr.SetMatrix(mat)
            tff = vtk.vtkTransformPolyDataFilter()
            tff.SetTransform(tr)
            tff.SetInputData(poly)
            tff.Update()
            poly = tff.GetOutput()
            log(f"[INFO] После transform: {poly.GetNumberOfPoints():,} точек")

        # 2) RAS → LPS conversion.
        log("[INFO] RAS → LPS conversion…")
        ras2lps = vtk.vtkTransform()
        ras2lps.Scale(-1.0, -1.0, 1.0)
        flip = vtk.vtkTransformPolyDataFilter()
        flip.SetTransform(ras2lps)
        flip.SetInputData(poly)
        flip.Update()
        poly = flip.GetOutput()

        # 3) Триангуляция
        log("[INFO] Триангуляция…")
        tri = vtk.vtkTriangleFilter()
        tri.SetInputData(poly)
        tri.PassVertsOff()
        tri.PassLinesOff()
        tri.Update()
        poly = tri.GetOutput()
        log(f"[INFO] После триангуляции: "
            f"{poly.GetNumberOfPoints():,} точек, "
            f"{poly.GetNumberOfCells():,} граней")

        # 4) Запись
        log(f"[INFO] Запись в {out_path}…")
        writer = vtk.vtkOBJWriter()
        writer.SetFileName(out_path)
        writer.SetInputData(poly)
        if not writer.Write():
            raise RuntimeError(f"vtkOBJWriter.Write() failed: {out_path}")

        if not os.path.exists(out_path):
            raise RuntimeError(f"OBJ не создан: {out_path}")
        size_mb = os.path.getsize(out_path) / (1024 * 1024)
        log(f"[INFO] ✓ OBJ записан: {size_mb:.1f} МБ")

    # ─── spawn методы ───────────────────────────────────────────────────────
    def _spawn_exe(self, exe_path: str, obj_path: str) -> None:
        """Запустить Nasal Planner.exe --load <obj_path>."""
        cmd = [exe_path, "--load", obj_path]
        self._log(f"[INFO] Запуск: {exe_path} --load {os.path.basename(obj_path)}")

        creationflags = 0
        if sys.platform == "win32":
            creationflags = subprocess.CREATE_NO_WINDOW

        self._proc = subprocess.Popen(
            cmd,
            cwd=os.path.dirname(exe_path),
            creationflags=creationflags,
        )
        self._log(f"[INFO] PID: {self._proc.pid}")

    def _spawn_dev(self, project_root: str, venv_python: str, obj_path: str) -> None:
        """Dev-fallback: запустить entry.py через venv-python с --load."""
        entry_py = os.path.join(project_root, "entry.py")
        if not os.path.isfile(entry_py):
            raise RuntimeError(f"Не найден entry.py: {entry_py}")

        cmd = [venv_python, entry_py, "--load", obj_path]
        self._log(f"[INFO] Dev-режим: {venv_python} {entry_py} --load …")

        creationflags = 0
        if sys.platform == "win32":
            creationflags = subprocess.CREATE_NO_WINDOW

        self._proc = subprocess.Popen(
            cmd,
            cwd=project_root,
            env=self._clean_env_for_venv(),
            creationflags=creationflags,
        )
        self._log(f"[INFO] PID: {self._proc.pid}")

    # ─── публичный API ─────────────────────────────────────────────────────
    def open_model(self, model_node) -> None:
        """Главный метод. Экспорт ноды → запуск Nasal Planner.exe (или dev)."""
        # 1) Экспорт в temp
        obj_path = os.path.join(
            slicer.app.temporaryPath,
            f"nasal_{int(time.time())}.obj")
        self._log(f"[INFO] Экспорт '{model_node.GetName()}' → {obj_path}")
        self.model_node_to_obj(model_node, obj_path, log=self._log)

        # 2) exe приоритетнее
        exe_path = _resolve_exe_path()
        if exe_path:
            self._log(f"[INFO] Режим: exe ({exe_path})")
            self._spawn_exe(exe_path, obj_path)
            return

        # 3) Fallback: dev-режим через venv
        project_root, venv_python = _resolve_dev_paths()
        if project_root and venv_python:
            self._log(f"[INFO] Режим: dev (venv в {project_root})")
            self._spawn_dev(project_root, venv_python, obj_path)
            return

        # 4) Ничего не найдено
        raise RuntimeError(
            "Не найден ни Nasal Planner.exe, ни dev-окружение (project + venv).\n"
            "Укажи путь в Настройках модуля или через ENV-переменные:\n"
            "  NASAL_PLANNER_EXE=<полный путь к .exe>\n"
            "  NASAL_PLANNER_ROOT=<корень nasal-planner>\n"
            "  NASAL_PLANNER_VENV_PYTHON=<путь к python.exe>"
        )


# ════════════════════════════════════════════════════════════════════════════
#                                  Test
# ════════════════════════════════════════════════════════════════════════════
class NasalPlannerTest(ScriptedLoadableModuleTest):

    def setUp(self):
        slicer.mrmlScene.Clear(0)

    def runTest(self):
        self.setUp()
        self.test_export_obj()

    def test_export_obj(self):
        cube = vtk.vtkCubeSource()
        cube.Update()
        node = slicer.modules.models.logic().AddModel(cube.GetOutput())
        node.SetName("TestCube")

        out = os.path.join(slicer.app.temporaryPath, "test_export.obj")
        if os.path.exists(out):
            os.remove(out)

        NasalPlannerLogic.model_node_to_obj(node, out)
        self.assertTrue(os.path.exists(out))
        self.assertGreater(os.path.getsize(out), 100)
        self.delayDisplay(f"OK: {out} ({os.path.getsize(out)} байт)")
