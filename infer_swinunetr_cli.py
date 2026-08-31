"""
infer_swinunetr_cli.py  —  CLI для сегментации синусов
=========================================================================

Модель: SwinUNETR v2 (6 классов), обученная на NasalSeg dataset.
  0: background
  1: maxillary_sinus_r
  2: maxillary_sinus_l
  3: nasal_cavity_r
  4: nasal_cavity_l
  5: nasal_pharynx

Входы:
  • Одиночный файл .nrrd
  • Один .dcm файл → берётся вся серия из родительской папки

Выход:
  • .seg.nrrd — нативный формат 3D Slicer Segmentation
    (открывается в Segment Editor без конвертаций)
  • Или .nrrd / .nii.gz — обычная маска
  • И roi ct


preprocessing через MONAI transforms (Orientationd "RAS"),
а НЕ через SimpleITK GetArrayFromImage — иначе оси транспонированы.
"""

import argparse
import os
import subprocess
from proc_utils import no_window   # без всплывающего окна консоли
import sys
import tempfile
from typing import Dict, List, Optional, Tuple

import numpy as np
import SimpleITK as sitk
import torch

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

try:
    sitk.ProcessObject.GlobalWarningDisplayOff()
except Exception:
    pass


def _ensure_package(name, pip_name=None):
    try:
        __import__(name)
    except ImportError:
        pip_name = pip_name or name
        print(f"[INFO] Устанавливаю {pip_name}...", flush=True)
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", pip_name, "-q"],
            stdout=subprocess.DEVNULL,
            **no_window(),
        )

_ensure_package("nrrd", "pynrrd")


NUM_CLASSES = 6  # default; перезаписывается _detect_num_classes() из checkpoint
FEATURE_SIZE = 48
TARGET_SPACING = (0.5, 0.5, 1.0)
ROI_SIZE = (96, 96, 96)
INTENSITY_WINDOW = (-1000, 2000)
SW_BATCH_SIZE = 2
SW_OVERLAP = 0.5
CROP_MARGIN = 10

# Переопределения скорости (из аргументов CLI; None = авто по железу)
_OVERLAP_OVERRIDE = None    # --overlap
_THREADS_OVERRIDE = None    # --threads (число потоков CPU)

# 6-классовая модель (базовая, NasalSeg)
LABEL_MAP_6 = {
    0: "background",
    1: "maxillary_sinus_r",
    2: "maxillary_sinus_l",
    3: "nasal_cavity_r",
    4: "nasal_cavity_l",
    5: "nasal_pharynx",
}
SEGMENT_COLORS_6 = {
    1: (0.90, 0.15, 0.15),
    2: (0.15, 0.15, 0.90),
    3: (0.15, 0.85, 0.15),
    4: (0.90, 0.85, 0.00),
    5: (0.85, 0.15, 0.85),
}

# 2-классовая модель
LABEL_MAP_2 = {
    0: "background",
    1: "selected_object",
}
SEGMENT_COLORS_2 = {
    1: (0.90, 0.15, 0.15),
}

LABEL_MAP = LABEL_MAP_6
SEGMENT_COLORS = SEGMENT_COLORS_6


def _set_class_mode(n: int, class_name: Optional[str] = None) -> None:
    """Переключает все глобальные карты под n-классовый режим (2 или 6)."""
    global NUM_CLASSES, LABEL_MAP, SEGMENT_COLORS
    global TRAIN_FOV_MM, Z_DROP_MM, NOSE_FRONT_PAD_MM
    if n == 6:
        NUM_CLASSES = 6
        LABEL_MAP = dict(LABEL_MAP_6)
        SEGMENT_COLORS = dict(SEGMENT_COLORS_6)
        TRAIN_FOV_MM = TRAIN_FOV_MM_6
        Z_DROP_MM = Z_DROP_MM_6
        NOSE_FRONT_PAD_MM = NOSE_FRONT_PAD_MM_6
    elif n == 2:
        NUM_CLASSES = 2
        LABEL_MAP = {0: "background", 1: class_name or "selected_object"}
        SEGMENT_COLORS = dict(SEGMENT_COLORS_2)
        TRAIN_FOV_MM = TRAIN_FOV_MM_2
        Z_DROP_MM = Z_DROP_MM_2
        NOSE_FRONT_PAD_MM = NOSE_FRONT_PAD_MM_2
    else:
        raise ValueError(f"Поддерживаются только 2 или 6 классов, получено: {n}")


def _detect_model_config(ckpt_path: str) -> dict:
    ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=False)
    sd = ckpt.get("state_dict", ckpt)

    # --- num_classes ---
    candidates = []
    for k, v in sd.items():
        if not hasattr(v, "shape") or len(v.shape) != 5:
            continue
        shp = tuple(v.shape)
        if shp[-3:] == (1, 1, 1) and shp[0] in (2, 6):
            candidates.append((k, shp))
    if not candidates:
        for k, v in sd.items():
            if hasattr(v, "shape") and len(v.shape) == 5 and v.shape[0] in (2, 6):
                candidates.append((k, tuple(v.shape)))
    if not candidates:
        raise RuntimeError(
            "Не удалось определить число классов из checkpoint — "
            "не найден выходной conv-слой с C_out {2, 6}"
        )
    out_keys = [c for c in candidates if "out" in c[0].lower()]
    chosen = out_keys[0] if out_keys else candidates[0]
    n_classes = int(chosen[1][0])

    use_v2 = any(
        ("layers1c" in k or "layers2c" in k or "layers3c" in k or "layers4c" in k)
        for k in sd.keys()
    )

    print(f"[INFO] Detected num_classes={n_classes} from key '{chosen[0]}' "
          f"(shape={chosen[1]})", flush=True)
    print(f"[INFO] Detected use_v2={use_v2} "
          f"({'has' if use_v2 else 'no'} layersNc residual blocks)", flush=True)

    return {"num_classes": n_classes, "use_v2": use_v2}


def _detect_num_classes(ckpt_path: str) -> int:
    return _detect_model_config(ckpt_path)["num_classes"]

# Постобработка
MIN_ISLAND_VOXELS = 30
CLOSING_RADIUS_MM = 1.0


import pytorch_lightning as L
from monai.networks.nets import SwinUNETR
from monai.losses import DiceCELoss
from monai.metrics import DiceMetric
from monai.transforms import (
    Compose, AsDiscrete, EnsureType,
)
from monai.inferers import sliding_window_inference
from monai.data import decollate_batch


class NasalSegmentationModule(L.LightningModule):
    def __init__(
        self,
        img_size=(96, 96, 96),
        depths=(2, 2, 2, 2),
        num_heads=(3, 6, 12, 24),
        feature_size=48,
        norm_name="instance",
        drop_rate=0.0,
        attn_drop_rate=0.0,
        dropout_path_rate=0.0,
        normalize=True,
        use_v2=True,
        lr=2e-4,
        weight_decay=1e-5,
        warmup_epochs=10,
        max_epochs=300,
        check_val_every=20,
        batch_size=2,
        sw_batch_size=2,
        pretrained_path=None,
    ):
        super().__init__()
        self.save_hyperparameters()
        self.model = SwinUNETR(
            img_size=img_size,
            in_channels=1, out_channels=NUM_CLASSES,
            depths=depths, num_heads=num_heads,
            feature_size=feature_size, norm_name=norm_name,
            drop_rate=drop_rate, attn_drop_rate=attn_drop_rate,
            dropout_path_rate=dropout_path_rate, normalize=normalize,
            use_checkpoint=True, spatial_dims=3,
            downsample="merging", use_v2=use_v2,
        )
        self.loss_fn = DiceCELoss(to_onehot_y=True, softmax=True)
        self.post_pred = Compose([EnsureType(), AsDiscrete(argmax=True, to_onehot=NUM_CLASSES)])
        self.post_label = AsDiscrete(to_onehot=NUM_CLASSES)
        self.dice_metric = DiceMetric(include_background=False,
                                       reduction="mean_batch", get_not_nans=False)
        self.best_val_dice = 0.0
        self.best_val_epoch = 0
        self.validation_step_outputs = []

    def forward(self, x):
        return self.model(x)

    def configure_optimizers(self):
        from torch.optim.lr_scheduler import CosineAnnealingWarmRestarts
        opt = torch.optim.AdamW(self.model.parameters(),
                                 lr=self.hparams.lr,
                                 weight_decay=self.hparams.weight_decay)
        sched = CosineAnnealingWarmRestarts(opt,
                                             T_0=self.hparams.check_val_every * 2,
                                             T_mult=2, eta_min=1e-6)
        return {"optimizer": opt,
                "lr_scheduler": {"scheduler": sched, "interval": "epoch"}}

    def training_step(self, batch, batch_idx):
        loss = self.loss_fn(self.forward(batch["image"]), batch["label"])
        self.log("train_loss", loss.item(), prog_bar=True)
        return {"loss": loss}

    def validation_step(self, batch, batch_idx):
        out = sliding_window_inference(batch["image"], self.hparams.img_size,
                                        self.hparams.sw_batch_size, self.forward)
        outs = [self.post_pred(i) for i in decollate_batch(out)]
        labs = [self.post_label(i) for i in decollate_batch(batch["label"])]
        self.dice_metric(y_pred=outs, y=labs)
        self.validation_step_outputs.append({"val_number": len(outs)})

    def on_validation_epoch_end(self):
        d = float(self.dice_metric.aggregate().mean())
        self.dice_metric.reset()
        if d > self.best_val_dice:
            self.best_val_dice = d
            self.best_val_epoch = self.current_epoch
        self.validation_step_outputs.clear()



def resolve_input_to_volume(
    input_path: str, temp_dir: str, series_id: Optional[str] = None
) -> str:

    if not os.path.exists(input_path):
        raise FileNotFoundError(f"Input not found: {input_path}")

    if os.path.isfile(input_path):
        lower = input_path.lower()
        if lower.endswith((".nii", ".nii.gz", ".nrrd", ".nhdr", ".mha", ".mhd")):
            print(f"[INFO] Input volume: {input_path}", flush=True)
            return input_path
        # Одиночный .dcm → берём всю папку
        input_path = os.path.dirname(input_path)

    if os.path.isdir(input_path):
        # DICOM-серия
        series_ids = sitk.ImageSeriesReader.GetGDCMSeriesIDs(input_path)
        if not series_ids:
            raise RuntimeError(f"Нет DICOM-серий в папке: {input_path}")

        if series_id and series_id in series_ids:
            selected = series_id
        else:
            # Выбираем серию с наибольшим числом файлов
            selected = None
            max_files = 0
            for sid in series_ids:
                files = sitk.ImageSeriesReader.GetGDCMSeriesFileNames(input_path, sid)
                if len(files) > max_files:
                    selected = sid
                    max_files = len(files)
            if len(series_ids) > 1:
                print(f"[INFO] Найдено {len(series_ids)} серий, выбрана: {selected} ({max_files} файлов)", flush=True)

        file_names = sitk.ImageSeriesReader.GetGDCMSeriesFileNames(input_path, selected)
        print(f"[INFO] DICOM серия: {selected}, файлов: {len(file_names)}", flush=True)

        reader = sitk.ImageSeriesReader()
        reader.SetFileNames(file_names)
        reader.MetaDataDictionaryArrayUpdateOn()
        reader.LoadPrivateTagsOn()
        img = reader.Execute()

        volume_path = os.path.join(temp_dir, "dicom_converted.nrrd")
        sitk.WriteImage(img, volume_path)
        print(f"[INFO] DICOM → NRRD: {volume_path}", flush=True)
        print(f"[INFO]   Size: {img.GetSize()}, Spacing: {tuple(round(s,3) for s in img.GetSpacing())}", flush=True)
        return volume_path

    raise RuntimeError(f"Unsupported input: {input_path}")


# ─────────────────────────────────────────────────────────────────────
# Preprocessing: полностью SimpleITK (без MONAI spatial transforms)
# MONAI Orientation/Spacing требуют nibabel и падают в segfault на Windows.
# SimpleITK preprocessing + транспозиция (Z,Y,X)→(R,A,S) = надёжно.
# ─────────────────────────────────────────────────────────────────────
def _orient_ras(image: sitk.Image) -> sitk.Image:
    try:
        o = sitk.DICOMOrientImageFilter()
        o.SetDesiredCoordinateOrientation("RAS")
        return o.Execute(image)
    except Exception:
        return image


def _resample_spacing(image: sitk.Image, target_sp) -> sitk.Image:
    in_sp = image.GetSpacing()
    in_sz = image.GetSize()
    out_sz = [max(1, int(round(in_sz[i] * in_sp[i] / target_sp[i]))) for i in range(3)]
    rs = sitk.ResampleImageFilter()
    rs.SetInterpolator(sitk.sitkLinear)
    rs.SetOutputSpacing(target_sp)
    rs.SetSize(out_sz)
    rs.SetOutputDirection(image.GetDirection())
    rs.SetOutputOrigin(image.GetOrigin())
    rs.SetTransform(sitk.Transform())
    rs.SetDefaultPixelValue(-1024)
    return rs.Execute(image)



TRAIN_FOV_MM_6 = (84.0, 110.0, 75.0)
Z_DROP_MM_6 = 0.0
NOSE_FRONT_PAD_MM_6 = 8.0

# 2-классовая модель (бинарное дообучение пользователя на ok*/perf*).
# Калибровано на 10 кейсах:
#   median FOV = (46, 104, 67) мм — структура занимает всю обрезку
#   range      = LR[37..55] AP[90..116] SI[55..74]
# Беру немного выше median'ы для безопасности (LR=60, AP=110, SI=72).
# Z anchor СМЕЩЁН ВНИЗ относительно z_top_ant: тренировочные ROIs
# охватывают зону дна максиллярного синуса / альвеолярного отростка,
# которая в 6-class FOV находится на ~-45 мм от z_top_ant. Чтобы 72-мм
# FOV центрировался на этой зоне, его верх должен быть на ~12 мм ниже.
TRAIN_FOV_MM_2 = (85.9, 262.8, 173.5)  # (LR, AP, SI), мм — покрывает fg всех 27 кейсов с margin 10.0 мм
Z_DROP_MM_2 = -1.4  # верх FOV на -1 мм ниже верха лицевой кости
NOSE_FRONT_PAD_MM_2 = 5.4  # передний край FOV на 5 мм перед кончиком носа


TRAIN_FOV_MM = TRAIN_FOV_MM_6
Z_DROP_MM = Z_DROP_MM_6
NOSE_FRONT_PAD_MM = NOSE_FRONT_PAD_MM_6
Z_SHIFT_USER_MM = 0.0


def _localize_face_roi(img: sitk.Image) -> sitk.Image:
    """
    Вырезает ROI точно тренировочного физического размера, центрированный
    на midface, используя центроид передних (лицевых) костей как якорь.
    Работает и на sinus-протокол CT, и на полных головах, и на full body.
    Вход должен быть RAS-ориентирован (X=R, Y=A, Z=S).
    """
    arr = sitk.GetArrayFromImage(img)  # (Z=S, Y=A, X=R)
    Z, Y, X = arr.shape
    sx, sy, sz = img.GetSpacing()

    # Размер ROI в вокселях исходного (не ресемплированного) тома
    nx = max(1, int(round(TRAIN_FOV_MM[0] / sx)))
    ny = max(1, int(round(TRAIN_FOV_MM[1] / sy)))
    nz = max(1, int(round(TRAIN_FOV_MM[2] / sz)))

    # --- 1. body mask ---
    body = arr > -500
    if not body.any():
        print("[WARN] Пустая body mask, пропуск локализации", flush=True)
        return img

    z_any = np.where(body.any(axis=(1, 2)))[0]
    z_body_lo, z_body_hi = int(z_any.min()), int(z_any.max())

    # --- 2. Если это full-body — оставляем верхние ~250 мм (голова+шея).
    # Для head/sinus-протокола это не отрезает ничего. ---
    head_height_mm = 250.0
    n_head = int(round(head_height_mm / sz))
    z_head_lo = max(z_body_lo, z_body_hi - n_head + 1)

    # --- 3. bone mask внутри головы ---
    bone = np.zeros_like(body)
    bone[z_head_lo:z_body_hi + 1] = arr[z_head_lo:z_body_hi + 1] > 300

    if bone.sum() < 1000:
        print(f"[WARN] Мало костных вокселей ({int(bone.sum())}), fallback на body",
              flush=True)
        bone = np.zeros_like(body)
        bone[z_head_lo:z_body_hi + 1] = body[z_head_lo:z_body_hi + 1]

    # bbox костей головы
    yb = np.where(bone.any(axis=(0, 2)))[0]
    if len(yb) == 0:
        print("[WARN] Кость не найдена, возвращаю исходное", flush=True)
        return img
    y_bone_lo, y_bone_hi = int(yb.min()), int(yb.max())

    # --- 4. Лицевые кости = передние 60% bone-bbox по AP ---
    # (исключаем затылок/позвоночник; оставляем нос, скуловые, верхняя
    # челюсть, лобная кость — стенки околоносовых пазух)
    y_thresh = y_bone_lo + int(round(0.4 * (y_bone_hi - y_bone_lo)))
    ant_bone = bone.copy()
    ant_bone[:, :y_thresh, :] = False

    if ant_bone.sum() < 500:
        ant_bone = bone

    # --- 5. Якоря из лицевых костей ---
    # Z anchor: ВЕРХНЯЯ граница лицевой кости (= верх лобной кости / лобной
    # пазухи). В P001 это совпадает с верхом FOV (offset = 0). Использовать
    # центроид нельзя — он сдвигается вниз, когда скан включает много
    # верхней челюсти/зубов под пазухами.
    ant_per_slice = ant_bone.sum(axis=(1, 2))
    z_top_candidates = np.where(ant_per_slice > 50)[0]
    if len(z_top_candidates) > 0:
        z_top_ant = int(z_top_candidates.max())
    else:
        z_top_ant = int(np.where(ant_bone.any(axis=(1, 2)))[0].max())

    z_idx, y_idx, x_idx = np.where(ant_bone)
    x_centroid = int(round(x_idx.mean()))
    y_front = int(y_idx.max())  # самый передний воксель = кончик носа

    # --- 6. Строим ROI размером ровно как в тренировке ---
    # Z (SI): верх FOV = верх лицевой кости − Z_DROP_MM (− Z_SHIFT_USER_MM
    # из CLI). Для 6-class Z_DROP=0 (FOV покрывает синусы от лобной пазухи
    # до носоглотки). Для 2-class Z_DROP=12 мм (FOV сдвинут вниз к области
    # дна максиллярного синуса / альвеолярного отростка).
    total_drop_mm = Z_DROP_MM + Z_SHIFT_USER_MM
    z_drop_vox = int(round(total_drop_mm / sz))
    z_hi_c = min(Z - 1, z_top_ant - z_drop_vox)
    z_lo_c = z_hi_c - nz + 1
    if z_lo_c < 0:
        z_lo_c = 0
        z_hi_c = min(Z - 1, nz - 1)

    # Y (AP): NOSE_FRONT_PAD_MM перед кончиком носа + (FOV-pad) мм назад
    front_pad = int(round(NOSE_FRONT_PAD_MM / sy))
    y_hi_c = min(Y - 1, y_front + front_pad)
    y_lo_c = y_hi_c - ny + 1
    if y_lo_c < 0:
        y_lo_c = 0
        y_hi_c = min(Y - 1, ny - 1)

    # X (LR): центр на x_centroid лицевой кости
    x_lo_c = x_centroid - nx // 2
    x_hi_c = x_lo_c + nx - 1
    if x_lo_c < 0:
        x_lo_c = 0
        x_hi_c = min(X - 1, nx - 1)
    if x_hi_c > X - 1:
        x_hi_c = X - 1
        x_lo_c = max(0, x_hi_c - nx + 1)

    size_ijk = [
        int(x_hi_c - x_lo_c + 1),
        int(y_hi_c - y_lo_c + 1),
        int(z_hi_c - z_lo_c + 1),
    ]
    index_ijk = [int(x_lo_c), int(y_lo_c), int(z_lo_c)]

    full = img.GetSize()
    print(f"[INFO] Midface ROI (training FOV): full {full} -> size {tuple(size_ijk)} "
          f"at index {tuple(index_ijk)}", flush=True)
    print(f"[INFO]   anchors: z_top_ant={z_top_ant}, y_front={y_front} (nose), "
          f"x_centroid={x_centroid}", flush=True)
    print(f"[INFO]   physical: {size_ijk[0]*sx:.1f} x {size_ijk[1]*sy:.1f} x "
          f"{size_ijk[2]*sz:.1f} mm  (train: {TRAIN_FOV_MM[0]} x "
          f"{TRAIN_FOV_MM[1]} x {TRAIN_FOV_MM[2]} mm)", flush=True)

    try:
        cropped = sitk.RegionOfInterest(img, size=size_ijk, index=index_ijk)
    except Exception as e:
        print(f"[WARN] RegionOfInterest упал ({e}); возвращаю исходное", flush=True)
        return img
    return cropped

def preprocess_for_model(volume_path: str):
    # 1. Read + orient RAS
    raw = sitk.ReadImage(volume_path)
    ras = _orient_ras(raw)

    # 1b. КРИТИЧНО: локализация midface / синусов.
    # Модель обучена на тесно обрезанных томах (~90x120x78 мм вокруг носа),
    # поэтому на полном DICOM без этой обрезки она выдаёт мусор.
    ras = _localize_face_roi(ras)

    # 2. Resample
    resampled = _resample_spacing(ras, TARGET_SPACING)

    arr = sitk.GetArrayFromImage(resampled).astype(np.float32)  # (Z, Y, X) = (S, A, R)
    print(f"[INFO] Original: {sitk.GetArrayFromImage(raw).shape}, "
          f"sp={tuple(round(s,3) for s in raw.GetSpacing())}")
    print(f"[INFO] Resampled: {arr.shape}, sp={tuple(round(s,3) for s in resampled.GetSpacing())}", flush=True)

    # 3. Intensity
    a_min, a_max = INTENSITY_WINDOW
    arr = np.clip(arr, a_min, a_max)
    arr = (arr - a_min) / (a_max - a_min + 1e-8)

    # 4. CropForeground
    fg = arr > 0
    if fg.any():
        coords = np.argwhere(fg)
        mn = np.maximum(coords.min(0) - CROP_MARGIN, 0)
        mx = np.minimum(coords.max(0) + CROP_MARGIN + 1, arr.shape)
        arr_crop = arr[mn[0]:mx[0], mn[1]:mx[1], mn[2]:mx[2]]
        crop_off = mn  # (z, y, x) offset
    else:
        arr_crop = arr
        crop_off = np.array([0, 0, 0])
    print(f"[INFO] After crop: {arr_crop.shape}", flush=True)

    # 5. Transpose (S, A, R) → (R, A, S) — match MONAI RAS axis order
    arr_ras = np.ascontiguousarray(np.transpose(arr_crop, (2, 1, 0)))

    # 6. Build RAS affine for nibabel roundtrip
    sp = resampled.GetSpacing()       # (sx, sy, sz)
    origin_lps = np.array(resampled.GetOrigin())
    D = np.array(resampled.GetDirection()).reshape(3, 3)
    S_diag = np.diag(list(sp))

    # Crop offset in XYZ = (crop_off[2], crop_off[1], crop_off[0])
    crop_xyz = np.array([crop_off[2], crop_off[1], crop_off[0]], dtype=np.float64)
    origin_crop_lps = origin_lps + D @ S_diag @ crop_xyz

    # LPS → RAS: negate L→R and P→A
    origin_ras = np.array([-origin_crop_lps[0], -origin_crop_lps[1], origin_crop_lps[2]])
    D_ras = D.copy()
    D_ras[0, :] *= -1
    D_ras[1, :] *= -1

    ras_affine = np.eye(4, dtype=np.float64)
    ras_affine[:3, 0] = D_ras[:, 0] * sp[0]
    ras_affine[:3, 1] = D_ras[:, 1] * sp[1]
    ras_affine[:3, 2] = D_ras[:, 2] * sp[2]
    ras_affine[:3, 3] = origin_ras

    tensor = torch.from_numpy(arr_ras[np.newaxis].copy()).float()  # (1, R, A, S)
    print(f"[INFO] Model input: {tensor.shape}", flush=True)
    return tensor, ras_affine



def save_prediction_to_original_space(
    pred_np: np.ndarray,
    ras_affine,
    original_ct_path: str,
) -> sitk.Image:
    """
    pred_np:     (R, A, S) array from model
    ras_affine:  4x4 RAS affine (numpy or torch)
    Returns:     SimpleITK image in original CT geometry
    """
    aff = ras_affine.numpy() if torch.is_tensor(ras_affine) else np.array(ras_affine)

    # 1. Transpose (R, A, S) → (S, A, R) = SimpleITK (Z, Y, X)
    pred_zyx = np.ascontiguousarray(np.transpose(pred_np, (2, 1, 0)))

    # 2. Extract spacing from affine column norms
    sp = [np.linalg.norm(aff[:3, i]) for i in range(3)]

    # 3. RAS → LPS direction: negate first two rows
    D_ras = np.zeros((3, 3))
    for i in range(3):
        D_ras[:, i] = aff[:3, i] / sp[i]
    D_lps = D_ras.copy()
    D_lps[0, :] *= -1
    D_lps[1, :] *= -1

    # 4. RAS → LPS origin: negate first two components
    origin_lps = [-aff[0, 3], -aff[1, 3], aff[2, 3]]

    # 5. Create SimpleITK image
    pred_sitk = sitk.GetImageFromArray(pred_zyx.astype(np.uint8))
    pred_sitk.SetSpacing(sp)
    pred_sitk.SetOrigin(origin_lps)
    pred_sitk.SetDirection(D_lps.flatten().tolist())

    # 6. Resample to original CT geometry
    original_ct = sitk.ReadImage(original_ct_path)
    rs = sitk.ResampleImageFilter()
    rs.SetReferenceImage(original_ct)
    rs.SetInterpolator(sitk.sitkNearestNeighbor)
    rs.SetDefaultPixelValue(0)
    rs.SetTransform(sitk.Transform())
    return rs.Execute(sitk.Cast(pred_sitk, sitk.sitkUInt8))


def postprocess_multiclass(
    mask_sitk: sitk.Image,
    min_island_voxels: int = MIN_ISLAND_VOXELS,
    closing_radius_mm: float = CLOSING_RADIUS_MM,
    keep_largest_only: bool = True,
) -> sitk.Image:
    """Постобработка: closing, удаление мелких островков, оставление
    одной крупнейшей компоненты на класс."""
    import gc
    try:
        from scipy import ndimage
    except ImportError:
        print("[WARN] scipy not installed; skipping postprocessing", flush=True)
        return mask_sitk

    arr = sitk.GetArrayFromImage(mask_sitk)
    spacing = mask_sitk.GetSpacing()  # (x, y, z)
    spacing_zyx = (spacing[2], spacing[1], spacing[0])

    # Тип меток задаём явно. По умолчанию scipy берёт intp — на 64-битной
    # системе это int64, вдвое больше int32 при том же результате: на
    # объёме 151x512x512 разница 316 МБ против 158 МБ. Когда памяти в
    # обрез — а падало на выделении 916 МБ — это решающая экономия.
    _LBL = np.int32
    VERBOSE_POSTPROC = False

    for cls_id in range(1, NUM_CLASSES):
        hit = (arr == cls_id)               # bool: 1 байт на воксель
        if not hit.any():
            del hit
            continue

        # ── Работаем в ОГРАНИЧИВАЮЩЕМ БОКСЕ класса, а не во всём объёме.
        #
        # Маска занимает малую часть КТ: типично 5-15 % вокселей. Раньше
        # ndimage.label() и bincount() обрабатывали весь массив целиком,
        # и на объёме 151x512x512 постобработка требовала под гигабайт.
        # Отсюда падение:
        #     _ArrayMemoryError: Unable to allocate 916 MiB
        #
        # Компоненты связности не пересекают границу маски по
        # определению, поэтому обрезка на результат не влияет — только
        # на расход памяти. Запас в 1 воксель нужен морфологическому
        # закрытию, чтобы оно не упёрлось в край бокса.
        idx = np.nonzero(hit)
        pad = max(2, int(np.ceil(closing_radius_mm / min(spacing_zyx))) + 1)
        sl = tuple(
            slice(max(0, int(i.min()) - pad),
                  min(s, int(i.max()) + pad + 1))
            for i, s in zip(idx, hit.shape)
        )
        del idx, hit
        gc.collect()

        sub_full = arr[sl]
        cls_mask = (sub_full == cls_id).astype(np.uint8)
        del sub_full

        if VERBOSE_POSTPROC:
            frac = cls_mask.size / arr.size
            print(f"[INFO]   class {cls_id}: бокс {cls_mask.shape} "
                  f"({frac*100:.0f}% объёма)", flush=True)

        # Morphological closing
        if closing_radius_mm > 0:
            radius = tuple(max(1, int(round(closing_radius_mm / s))) for s in spacing_zyx)
            struct = np.zeros(tuple(2*r+1 for r in radius), dtype=bool)
            ctr = tuple(r for r in radius)
            zz, yy, xx = np.ogrid[-ctr[0]:ctr[0]+1, -ctr[1]:ctr[1]+1, -ctr[2]:ctr[2]+1]
            struct = ((zz/radius[0])**2 + (yy/radius[1])**2 + (xx/radius[2])**2) <= 1.0
            cls_mask = ndimage.binary_closing(cls_mask > 0, structure=struct).astype(np.uint8)
            gc.collect()                    # binary_closing оставляет временные копии

        # ── Чистка островков и выбор главной компоненты ──────────────
        #
        # Размеры всех компонент считаем ОДНИМ np.bincount по массиву
        # меток. Прежний код падал с
        #     _ArrayMemoryError: Unable to allocate 916 MiB
        # в scipy.ndimage.sum(): она принимает index=range(1, num+1),
        # внутри разворачивает его в массив и делает своё bincount,
        # выделяя память по МАКСИМАЛЬНОЙ метке. На шумной маске
        # с десятками тысяч островков это сотни мегабайт.
        #
        # Заодно ушёл цикл `for c in range(1, num+1)` с
        # `(labeled == c).sum()`: он проходил по всему объёму на каждую
        # компоненту — тысячи полных проходов вместо одного.
        labeled, num = ndimage.label(cls_mask > 0, output=_LBL)
        if num > 0:
            counts = np.bincount(labeled.ravel())
            counts[0] = 0                      # фон не считаем

            if min_island_voxels > 0:
                small = np.flatnonzero(counts < min_island_voxels)
                if small.size:
                    drop = np.zeros(counts.size, dtype=bool)
                    drop[small] = True
                    drop[0] = False
                    cls_mask[drop[labeled]] = 0

            if keep_largest_only and num > 1:
                # Пересчитываем: чистка выше могла убрать компоненты
                counts = np.bincount(labeled.ravel(), weights=(cls_mask > 0).ravel())
                counts[0] = 0
                largest_label = int(np.argmax(counts))
                if counts[largest_label] > 0:
                    cls_mask = (labeled == largest_label).astype(np.uint8)
                    print(f"[INFO]   class {cls_id}: kept largest of {num} components "
                          f"({int(counts[largest_label])} voxels)", flush=True)

        del labeled, counts
        gc.collect()

        # Записываем обратно ТОЛЬКО в пределах бокса: за его границами
        # вокселей этого класса не было, трогать их незачем.
        region = arr[sl]
        region[region == cls_id] = 0
        region[cls_mask > 0] = cls_id
        arr[sl] = region
        del cls_mask, region
        gc.collect()

    out = sitk.GetImageFromArray(arr)
    out.CopyInformation(mask_sitk)
    return out



def save_as_seg_nrrd(mask_sitk: sitk.Image, output_path: str) -> None:
    import nrrd as pynrrd

    mask_arr = sitk.GetArrayFromImage(mask_sitk)  # (z, y, x)
    spacing = mask_sitk.GetSpacing()      # (sx, sy, sz)
    origin = mask_sitk.GetOrigin()        # (ox, oy, oz)
    direction = mask_sitk.GetDirection()

    # pynrrd index_order="F" expects (i, j, k) = (x, y, z)
    data_ijk = np.transpose(mask_arr, (2, 1, 0)).copy()

    # Space directions from SimpleITK (LPS convention)
    d = list(direction)
    space_directions = np.array([
        [d[0]*spacing[0], d[1]*spacing[0], d[2]*spacing[0]],
        [d[3]*spacing[1], d[4]*spacing[1], d[5]*spacing[1]],
        [d[6]*spacing[2], d[7]*spacing[2], d[8]*spacing[2]],
    ])

    header = {
        "type": "unsigned char",
        "dimension": 3,
        "space": "left-posterior-superior",
        "sizes": list(data_ijk.shape),
        "space directions": space_directions,
        "space origin": np.array(origin),
        "kinds": ["domain", "domain", "domain"],
        "encoding": "gzip",
        "Segmentation_ContainedRepresentationNames": "Binary labelmap|",
        "Segmentation_MasterRepresentation": "Binary labelmap",
        "Segmentation_ReferenceImageExtentOffset": "0 0 0",
    }

    # Добавляем метаданные для каждого foreground-сегмента
    seg_idx = 0
    for cls_id in range(1, NUM_CLASSES):
        if not np.any(data_ijk == cls_id):
            # Даже пустые сегменты добавляем — так удобнее в Slicer
            pass

        name = LABEL_MAP[cls_id]
        color = SEGMENT_COLORS[cls_id]

        # Bounding box (extent)
        nz = np.argwhere(data_ijk == cls_id)
        if len(nz) > 0:
            extent = "{} {} {} {} {} {}".format(
                int(nz[:,0].min()), int(nz[:,0].max()),
                int(nz[:,1].min()), int(nz[:,1].max()),
                int(nz[:,2].min()), int(nz[:,2].max()),
            )
        else:
            extent = "0 0 0 0 0 0"

        prefix = f"Segment{seg_idx}_"
        header[prefix + "ID"] = f"Segment_{cls_id}"
        header[prefix + "Name"] = name
        header[prefix + "Color"] = f"{color[0]:.6f} {color[1]:.6f} {color[2]:.6f}"
        header[prefix + "LabelValue"] = str(cls_id)
        header[prefix + "Layer"] = "0"
        header[prefix + "Extent"] = extent
        header[prefix + "NameAutoGenerated"] = "0"
        header[prefix + "ColorAutoGenerated"] = "0"
        header[prefix + "Tags"] = "Segmentation.Status:inprogress|"
        seg_idx += 1

    custom_field_map = {k: "string" for k in header if k.startswith("Segment")}

    os.makedirs(os.path.dirname(os.path.abspath(output_path)) or ".", exist_ok=True)
    pynrrd.write(output_path, data_ijk, header,
                 custom_field_map=custom_field_map, index_order="F")

    print(f"[INFO] Saved .seg.nrrd: {output_path}", flush=True)
    for cls_id in range(1, NUM_CLASSES):
        n = int((mask_arr == cls_id).sum())
        if n > 0:
            print(f"[INFO]   {LABEL_MAP[cls_id]:25s}: {n:>8} voxels", flush=True)


def save_as_plain_nrrd(mask_sitk: sitk.Image, output_path: str) -> None:
    """Сохраняет как обычный NRRD labelmap."""
    sitk.WriteImage(mask_sitk, output_path)
    print(f"[INFO] Saved labelmap: {output_path}", flush=True)



def export_ct_roi(
    ct_path: str,
    mask_sitk: sitk.Image,
    output_path: str,
    padding_mm: float = 5.0,
) -> Optional[str]:

    mask_arr = sitk.GetArrayFromImage(mask_sitk)  # (z, y, x)
    if mask_arr.sum() == 0:
        print("[WARN] Пустая сегментация — CT ROI не сохранён", flush=True)
        return None

    ct_sitk = sitk.ReadImage(ct_path)
    size_ct = ct_sitk.GetSize()           # (X, Y, Z)
    spacing = ct_sitk.GetSpacing()        # (sx, sy, sz) — мм/воксель

    # bbox индексов в порядке (z, y, x)
    nz = np.argwhere(mask_arr > 0)
    z_min, y_min, x_min = nz.min(axis=0).tolist()
    z_max, y_max, x_max = nz.max(axis=0).tolist()

    # padding из мм в воксели (по каждой оси — своё spacing)
    pad_x = int(round(padding_mm / spacing[0]))
    pad_y = int(round(padding_mm / spacing[1]))
    pad_z = int(round(padding_mm / spacing[2]))

    # клампим в границы КТ; SimpleITK индексация в порядке (x, y, z)
    x_lo = max(0, int(x_min) - pad_x)
    y_lo = max(0, int(y_min) - pad_y)
    z_lo = max(0, int(z_min) - pad_z)
    x_hi = min(size_ct[0] - 1, int(x_max) + pad_x)
    y_hi = min(size_ct[1] - 1, int(y_max) + pad_y)
    z_hi = min(size_ct[2] - 1, int(z_max) + pad_z)

    index = [x_lo, y_lo, z_lo]
    size = [x_hi - x_lo + 1, y_hi - y_lo + 1, z_hi - z_lo + 1]

    roi = sitk.RegionOfInterest(ct_sitk, size, index)
    os.makedirs(os.path.dirname(os.path.abspath(output_path)) or ".", exist_ok=True)
    sitk.WriteImage(roi, output_path)

    phys = tuple(size[i] * spacing[i] for i in range(3))
    print(
        f"[INFO] Saved CT ROI: {output_path}  "
        f"size={tuple(size)} voxels  "
        f"phys≈{phys[0]:.1f}×{phys[1]:.1f}×{phys[2]:.1f} mm  "
        f"(padding {padding_mm:g} mm)",
        flush=True,
    )
    return output_path



def save_preview(ct_path: str, mask_sitk: sitk.Image, output_png: str) -> None:
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        from matplotlib.patches import Patch
    except ImportError:
        print("[WARN] matplotlib not installed; preview skipped", flush=True)
        return

    ct_img = sitk.ReadImage(ct_path)
    ct_arr = sitk.GetArrayFromImage(ct_img).astype(np.float32)
    mask_arr = sitk.GetArrayFromImage(mask_sitk)

    COLORS = {1:(0.9,0.15,0.15), 2:(0.15,0.15,0.9), 3:(0.15,0.85,0.15),
              4:(0.9,0.85,0.0), 5:(0.85,0.15,0.85)}

    fg_per_z = (mask_arr > 0).sum(axis=(1,2))
    z = int(np.argmax(fg_per_z)) if fg_per_z.max() > 0 else mask_arr.shape[0] // 2

    ct_s = np.clip((ct_arr[z] + 200) / 1400, 0, 1)
    rgb = np.stack([ct_s]*3, axis=-1)
    for cid, color in COLORS.items():
        m = (mask_arr[z] == cid)
        if m.any():
            for ch in range(3):
                rgb[:,:,ch] = np.where(m, rgb[:,:,ch]*0.5 + color[ch]*0.5, rgb[:,:,ch])

    fig, ax = plt.subplots(1, 1, figsize=(10, 10))
    ax.imshow(np.clip(rgb, 0, 1), aspect='auto')
    ax.set_title(f"Axial z={z} — 6-class prediction")
    ax.axis('off')
    legend = [Patch(facecolor=COLORS[i], label=LABEL_MAP[i]) for i in range(1, NUM_CLASSES)]
    fig.legend(handles=legend, loc='lower center', ncol=5, fontsize=9)
    plt.tight_layout(rect=[0, 0.04, 1, 0.98])
    plt.savefig(output_png, dpi=150, bbox_inches='tight')
    plt.close()
    print(f"[INFO] Preview: {output_png}", flush=True)



def run_inference(
    input_path: str,
    output_path: str,
    ckpt_path: str,
    device: str = "auto",
    do_postprocess: bool = True,
    preview_png: Optional[str] = None,
    series_id: Optional[str] = None,
    class_name: Optional[str] = None,
    keep_largest_only: bool = True,
    output_roi_ct: Optional[str] = None,
    roi_padding_mm: float = 5.0,
) -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
        volume_path = resolve_input_to_volume(input_path, temp_dir, series_id)

        original_ct_path = volume_path

        if device == "auto":
            dev = "cuda" if torch.cuda.is_available() else "cpu"
        else:
            dev = device
        print(f"[INFO] Device: {dev}", flush=True)

        cfg = _detect_model_config(ckpt_path)
        n_cls = cfg["num_classes"]
        use_v2 = cfg["use_v2"]
        _set_class_mode(n_cls, class_name=class_name)
        print(f"[INFO] Mode: {n_cls}-class, use_v2={use_v2}, "
              f"labels: {list(LABEL_MAP.values())}", flush=True)

        print(f"[INFO] Loading checkpoint: {ckpt_path}", flush=True)
        model = NasalSegmentationModule.load_from_checkpoint(
            ckpt_path, map_location=dev, use_v2=use_v2,
        )
        model.eval()
        model.to(dev)
        print(f"[INFO] Model loaded: {NUM_CLASSES} classes, feature_size={FEATURE_SIZE}", flush=True)

        print("[INFO] Preprocessing...", flush=True)
        img_tensor, affine = preprocess_for_model(volume_path)
        sys.stdout.flush()
        import gc; gc.collect()

        # overlap: можно переопределить (--overlap), иначе разумные значения по железу.
        # На CPU 0.25 — сбалансированно (быстрее, чем 0.5, точность почти та же).
        overlap = _OVERLAP_OVERRIDE if _OVERLAP_OVERRIDE is not None else (SW_OVERLAP if dev == "cuda" else 0.25)
        sw_bs = 1

        cpu_autocast = False
        if dev == "cpu":
            # используем все физические ядра (а не жёстко 4) — на CPU ускоряет почти линейно
            try:
                import os as _os
                ncpu = _THREADS_OVERRIDE or (_os.cpu_count() or 4)
            except Exception:
                ncpu = _THREADS_OVERRIDE or 4
            ncpu = max(1, int(ncpu))
            torch.set_num_threads(ncpu)
            try:
                torch.set_num_interop_threads(max(1, ncpu // 2))
            except Exception:
                pass
            # bfloat16-autocast на CPU — ВЫКЛЮЧЕН.
            #
            # Здесь была строка
            #     cpu_autocast = bool(getattr(torch.backends, "cpu", None)) or True
            # с «or True» на конце: выражение истинно ВСЕГДА, независимо от
            # поддержки bf16 процессором. Проверка наличия torch.backends.cpu
            # ничего не решала, автокаст включался безусловно.
            #
            # Почему это плохо. bf16 держит 8 бит мантиссы против 24 у fp32 —
            # логиты на границе классов дрожат, и после argmax маска идёт
            # рваными краями и мелкими островками. Разметка выглядит шумнее
            # при том же чекпойнте и том же входе.
            #
            # Выигрыша тоже нет: по замерам из README ускорения этапа bf16
            # на этом CPU замедлял вдвое (нет аппаратной поддержки — эмуляция),
            # и его тогда отвергли. Строка с «or True» осталась по недосмотру.
            #
            # Возвращать имеет смысл только под явным флагом и только после
            # замера Dice на когорте.
            cpu_autocast = False
            print(f"[INFO] CPU mode: torch threads={torch.get_num_threads()}, "
                  f"autocast(bf16)={cpu_autocast}", flush=True)

        spatial = img_tensor.shape[1:]
        n_patches = 1
        for i in range(3):
            step = max(1, int(ROI_SIZE[i] * (1 - overlap)))
            n_patches *= max(1, (spatial[i] - ROI_SIZE[i]) // step + 1)
        est_min = n_patches * (0.3 if dev == "cuda" else 6) / 60

        print(f"[INFO] Inference: {list(spatial)}, ~{n_patches} patches, "
              f"overlap={overlap}, ~{est_min:.0f} мин", flush=True)

        input_batch = img_tensor.unsqueeze(0).to(dev)
        del img_tensor; gc.collect()

        import time
        t0 = time.time()

        def _run_swi():
            return sliding_window_inference(
                inputs=input_batch,
                roi_size=ROI_SIZE,
                sw_batch_size=sw_bs,
                predictor=model.forward,
                overlap=overlap,
                mode="gaussian",
                progress=True,
            )

        with torch.no_grad():
            if dev == "cpu" and cpu_autocast:
                try:
                    with torch.autocast(device_type="cpu", dtype=torch.bfloat16):
                        output = _run_swi()
                except Exception as _e:
                    print(f"[INFO] autocast недоступен ({_e}); полный float32", flush=True)
                    output = _run_swi()
            else:
                output = _run_swi()
        del input_batch; gc.collect()
        elapsed = time.time() - t0
        print(f"\n[INFO] Готово за {elapsed/60:.1f} мин", flush=True)

        pred = torch.argmax(torch.softmax(output, dim=1), dim=1).squeeze(0)
        del output; gc.collect()
        pred_np = pred.cpu().numpy().astype(np.uint8)
        del pred; gc.collect()
        print(f"[INFO] Prediction: {pred_np.shape}, labels={sorted(np.unique(pred_np).tolist())}", flush=True)

        del model; gc.collect()

        print("[INFO] Mapping to original CT space...", flush=True)
        mask_sitk = save_prediction_to_original_space(pred_np, affine, original_ct_path)
        del pred_np; gc.collect()

        mask_arr = sitk.GetArrayFromImage(mask_sitk)
        print(f"[INFO] Mask: {mask_arr.shape}", flush=True)
        for cls_id in range(1, NUM_CLASSES):
            n = int((mask_arr == cls_id).sum())
            if n > 0:
                print(f"[INFO]   {LABEL_MAP[cls_id]:25s}: {n:>8} voxels", flush=True)
        del mask_arr; gc.collect()

        if do_postprocess:
            print("[INFO] Postprocessing...", flush=True)
            mask_sitk = postprocess_multiclass(mask_sitk, keep_largest_only=keep_largest_only)

        print("[INFO] Saving...", flush=True)
        if output_path.lower().endswith(".seg.nrrd"):
            save_as_seg_nrrd(mask_sitk, output_path)
        else:
            save_as_plain_nrrd(mask_sitk, output_path)
            print("[HINT] Используйте .seg.nrrd для прямого открытия в Segment Editor", flush=True)

        if output_roi_ct:
            print("[INFO] Exporting CT ROI...", flush=True)
            export_ct_roi(original_ct_path, mask_sitk, output_roi_ct,
                          padding_mm=roi_padding_mm)

        if preview_png:
            os.makedirs(os.path.dirname(os.path.abspath(preview_png)) or ".", exist_ok=True)
            save_preview(original_ct_path, mask_sitk, preview_png)

        print("[INFO] Done!", flush=True)



def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="2-class SwinUNETR segmentation — DICOM / NRRD → .seg.nrrd (3D Slicer native)"
    )
    p.add_argument("--input", required=True,
                   help="DICOM folder, .dcm file, or volume (.nrrd/.nii/.mha)")
    p.add_argument("--output", required=True,
                   help="Output path (.seg.nrrd recommended, or .nrrd/.nii.gz)")
    p.add_argument("--ckpt", required=True,
                   help="Path to 6-class .ckpt checkpoint")
    p.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"])
    p.add_argument("--series-id", default=None,
                   help="DICOM SeriesInstanceUID")
    p.add_argument("--preview-png", default=None,
                   help="Save preview overlay PNG")
    p.add_argument("--no-postprocess", action="store_true",
                   help="Skip postprocessing")
    p.add_argument("--keep-all-components", action="store_true",
                   help="Не оставлять только самую крупную компоненту "
                        "(по умолчанию для каждого класса остаётся одна крупнейшая).")
    p.add_argument("--output-roi-ct", default=None,
                   help="Путь к .nrrd для сохранения исходного КТ, обрезанного "
                        "по bounding box сегментации (+padding). Используется "
                        "для наложения интенсивностей КТ на развёртку объекта.")
    p.add_argument("--roi-padding-mm", type=float, default=5.0,
                   help="Отступ от bbox сегментации при кропе КТ ROI, мм "
                        "(по умолчанию 5).")
    p.add_argument("--class-name", default=None,
                   help="Имя класса для бинарной (2-class) модели. По умолчанию "
                        "'selected_object'. Игнорируется для 6-class модели.")
    p.add_argument("--z-shift-mm", type=float, default=0.0,
                   help="Дополнительный сдвиг ROI по Z в мм. Положительное "
                        "значение опускает ROI ниже, отрицательное — поднимает. "
                        "Складывается с Z_DROP_MM режима (0 для 6-class, 12 для 2-class). "
                        "Используй для тонкой настройки если автоматический "
                        "выбор положения не идеален.")
    p.add_argument("--overlap", type=float, default=None,
                   help="Перекрытие патчей sliding-window (0..0.9). Меньше = быстрее, "
                        "чуть грубее по швам. По умолчанию: 0.5 на GPU, 0.25 на CPU.")
    p.add_argument("--threads", type=int, default=None,
                   help="Число потоков CPU. По умолчанию — все ядра.")
    return p


def main() -> None:
    args = build_parser().parse_args()
    global Z_SHIFT_USER_MM, _OVERLAP_OVERRIDE, _THREADS_OVERRIDE
    Z_SHIFT_USER_MM = float(args.z_shift_mm)
    if args.overlap is not None:
        _OVERLAP_OVERRIDE = max(0.0, min(0.9, float(args.overlap)))
    if args.threads is not None and args.threads > 0:
        _THREADS_OVERRIDE = int(args.threads)
    run_inference(
        input_path=args.input,
        output_path=args.output,
        ckpt_path=args.ckpt,
        device=args.device,
        do_postprocess=not args.no_postprocess,
        preview_png=args.preview_png,
        series_id=args.series_id,
        class_name=args.class_name,
        keep_largest_only=not args.keep_all_components,
        output_roi_ct=args.output_roi_ct,
        roi_padding_mm=args.roi_padding_mm,
    )


if __name__ == "__main__":
    main()
