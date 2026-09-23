# Septum Planner

**English** · [Русский](README_ru.md)

A desktop application for planning the surgical closure of nasal septal
perforations. From a CT scan it builds a 3D model of the nasal cavity,
extracts the mucosa and **unfolds it into a flat, true-scale map**. On
that map the surgeon measures the defect and plans the flap without
having to mentally convert sizes from a curved surface. A demo video is
attached to release 3.

![Mucosal unfolding](fig/5_tab_2.png)

> **This is a research tool.** It is not a medical device.

---

## Why

The mucosa of the nasal septum is a curved surface. On CT the surgeon
sees it slice by slice and can only estimate the size of a defect
roughly, while the flap has to cover the perforation with a margin and
still fit within the donor area.

The application unfolds the surface onto a plane with controlled
distortion and reports the area of each zone in mm². You can then
measure directly on the map with a ruler: lengths and areas are
computed on the 3D surface, not on the picture, so the curvature does
not affect the numbers.

---

## How it works

Five stages, one tab each:

| # | Stage | What happens |
|---|-------|--------------|
| 01 | **CT labelling** | DICOM → segmentation of the nasal cavity with a SwinUNETR network; the mask can be corrected with a brush on the slices |
| 02 | **Model** | Mask → triangle mesh, cleanup and decimation |
| 03 | **Mucosa** | Separation of the inner (mucosal) surface from the outer one; if needed, the model can be cut to reach hidden areas |
| 04 | **Zones** | Labelling into septum, floor and lateral wall; boundaries are adjusted with sliders or drawn with the mouse |
| 05 | **Unfolding** | LSCM + ARAP; ruler, area and perforation-diameter measurements, flap planning |

### Under the hood

**Segmentation**: SwinUNETR (MONAI), trained on cropped volumes of the
midface. The region of interest is located by a heuristic based on bone
structures, without a second network.

**Unfolding**: LSCM for the initial map, followed by ARAP iterations.
The topology is reduced to a disk: perforations are kept as holes,
artefact loops are filled, and handles are cut.

**Measurements** are computed on the 3D surface (Dijkstra on the mesh),
not on the flat map. Stretching in the unfolding does not change the
numbers, only how regions look on screen.

---

## Model weights

The checkpoint is distributed via [Releases](../../releases). It is not
included in the repository because of its size.

## Running

On first launch, open **Model settings** on the **CT labelling** tab
and set three paths: the Python interpreter, `infer_swinunetr_cli.py`
and the checkpoint file. They are remembered.

---

## Building the executable

```bash
pyinstaller nasal_planner.spec --noconfirm --clean
```

The result is `dist/NasalPlanner/`.

---

## The `.nplan` format

All work on a case is saved to a single file, a regular ZIP archive with
a manifest and artefacts. It contains a ready-made training pair
(`roi_ct` + `roi_mask` in the same geometry), so the format is suitable
both for sharing cases and for fine-tuning the model.

---

## License

MIT, see [LICENSE](LICENSE).

Please note the additional notice at the end of that file: the project
is not a medical device.
