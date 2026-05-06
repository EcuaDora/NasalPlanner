"""
Session storage — разделяемое файловое состояние между табами.

Живёт от запуска приложения до закрытия окна (single-user desktop).
Артефакт = любой файл, к которому обращаются операции или фронт:
    mesh_raw        — исходный OBJ от врача
    mesh_clean      — после preprocess
    inner_surface   — после segment (с правками врача)
    zones           — после zones (с правками)
    unfolded        — финальная развёртка

Ключи произвольные — операции договариваются между собой через
INPUTS/OUTPUTS в operations/*.py.

Session НЕ lock'ается и НЕ потокобезопасна — предполагаем что одновременно
выполняется только одна операция (фронт блокирует UI на время запроса).
"""

import os
import json
import shutil
import tempfile
from typing import Optional
import atexit


class Session:
    """Файловая сессия. Синглтон, создаётся на первом обращении."""

    def __init__(self) -> None:
        self._dir = tempfile.mkdtemp(prefix="nasal_session_")
        self._meta_path = os.path.join(self._dir, "_manifest.json")
        # key -> filename (относительно self._dir)
        self._artifacts: dict[str, str] = {}
        self._save_meta()
        atexit.register(lambda: shutil.rmtree(self._dir, ignore_errors=True))

    @property
    def dir(self) -> str:
        return self._dir

    def has(self, key: str) -> bool:
        return key in self._artifacts

    def path(self, key: str) -> Optional[str]:
        """Полный путь к артефакту. None если ключа нет."""
        name = self._artifacts.get(key)
        if name is None:
            return None
        return os.path.join(self._dir, name)

    def reserve(self, key: str, extension: str) -> str:
        """Зарезервировать путь для записи. Операция пишет туда файл и зовёт register()."""

        name = f"{key}{extension}"
        return os.path.join(self._dir, name)

    def register(self, key: str, path: str) -> None:
        """Зарегистрировать артефакт. Если путь вне папки сессии — копируем."""
        if not os.path.exists(path):
            raise FileNotFoundError(f"cannot register non-existent path: {path}")

        if os.path.dirname(path) == self._dir:
            self._artifacts[key] = os.path.basename(path)
        else:
            ext = os.path.splitext(path)[1] or ".bin"
            new_name = f"{key}{ext}"
            new_path = os.path.join(self._dir, new_name)
            shutil.copy(path, new_path)
            self._artifacts[key] = new_name

        self._save_meta()

    def write_bytes(self, key: str, data: bytes, extension: str) -> str:
        """Сохранить сырые байты как артефакт. Возвращает полный путь."""
        path = self.reserve(key, extension)
        with open(path, "wb") as fh:
            fh.write(data)
        self.register(key, path)
        return path

    def delete(self, key: str) -> None:
        name = self._artifacts.pop(key, None)
        if name:
            try:
                os.remove(os.path.join(self._dir, name))
            except FileNotFoundError:
                pass
            self._save_meta()

    def reset(self) -> None:
        """Полный сброс: удалить всё, начать заново."""
        shutil.rmtree(self._dir, ignore_errors=True)
        self._dir = tempfile.mkdtemp(prefix="nasal_session_")
        self._meta_path = os.path.join(self._dir, "_manifest.json")
        self._artifacts = {}
        self._save_meta()

    def reset_except(self, keep_keys: list[str]) -> None:
        """Сброс с сохранением указанных артефактов.

        Нужен, когда новый input инвалидирует часть пайплайна, но не всё,
        что уже загружено. Пример: врач перезагружает OBJ — mesh_raw и всё,
        что от него зависит (mesh_clean, inner_surface...), становятся
        невалидными, но ct_raw грузился независимо и должен уцелеть.

        Реализация: читаем байты нужных файлов ДО reset() (потому что reset
        удалит всю папку), потом заливаем их обратно в свежую сессию.
        """
        # Снимаем байты тех артефактов, что хотим оставить
        kept: dict[str, tuple[bytes, str]] = {}
        for k in keep_keys:
            p = self.path(k)
            if p and os.path.exists(p):
                with open(p, "rb") as fh:
                    data = fh.read()
                ext = os.path.splitext(p)[1] or ".bin"
                kept[k] = (data, ext)

        # Полный сброс — старая папка удаляется целиком
        self.reset()

        # Восстанавливаем сохранённые артефакты в свежей сессии
        for k, (data, ext) in kept.items():
            self.write_bytes(k, data, ext)

    def keys(self) -> list[str]:
        return list(self._artifacts.keys())

    def manifest(self) -> dict[str, str]:
        """Для фронта: {key: filename} всех артефактов."""
        return dict(self._artifacts)

    def _save_meta(self) -> None:
        with open(self._meta_path, "w") as fh:
            json.dump(self._artifacts, fh, indent=2)


# Глобальный синглтон. get() лениво инициализирует при первом обращении.
_instance: Optional[Session] = None


def get() -> Session:
    global _instance
    if _instance is None:
        _instance = Session()
    return _instance
