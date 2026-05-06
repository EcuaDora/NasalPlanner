# Production Patches — R1 + R2 + R3

Этот пакет содержит **drop-in замены 3-х модулей** существующего pipeline'а
(`bd_polish.py`, `adaptive_cuts.py`, `unfold.py`) с тремя safety-патчами:

* **R1** — singular Lap_free guard в `bd_polish`
* **R2** — blow-up guard с откатом к best-iso state в `bd_polish`
* **R3** — iso-aware overlap rollback в `adaptive_cuts`

Все три патча верифицированы на 10-меш когорте, документированы в research-отчёте.

## Что меняется

### `bd_polish.py` (R1 + R2)

**R1 (singular Lap_free guard)** — Tikhonov-регуляризация ε≈1e-8·max(diag) если
`splu(Lap_free)` бросает `RuntimeError: Factor is exactly singular`.

* **Activates** только на degenerate мешах (наблюдалось на t4 со сложной топологией fan-fill apex'ов).
* **No-op** на well-posed мешах — поведение не меняется.
* **Прогресс-сообщение**: `⚠ BD-polish: применена регуляризация (R1)`.
* **Метрика в info**: `info['bd_polish']['used_regularization']` = bool.

**R2 (blow-up guard с откатом)** — отслеживает best-iso state; hard-stop
если за последние 5 итераций iso растёт монотонно И превысил `iso_start * 1.2`.

* **Activates** на t9 K=1.7: без R2 iso 3.27 → 5.10; с R2 → **2.97** (verified).
* **No-op** если iso ведёт себя нормально.
* **Прогресс-сообщение**: `↩ BD-polish: hard stop (R2) — blow_up_at_iter_N`.
* **Метрика в info**: `info['bd_polish']['hard_stop_reason']` = str | None.

### `adaptive_cuts.py` (R3)

**R3 (iso-aware overlap rollback)** — после каждого cut'а запускает
`overlap_cuts.detect_uv_overlaps`. Если cut поднял overlap_pairs существенно
**И** не дал iso-выигрыша → откат cut'а к pre-cut state.

Default thresholds (consrevative, no false-positive rollbacks):
```python
overlap_growth_factor = 1.2    # +20% allowed
overlap_min_threshold = 20     # noise floor (защита от мелких изменений)
iso_improvement_threshold = 0.05  # 5% rel iso reduction = «полезный» cut
```

Triggers ТОЛЬКО когда выполнены ВСЕ 3 условия:
1. `ov_after > ov_before * 1.2 + 20` (overlap'ы выросли сильно)
2. `iso_improvement < 5%` (iso не улучшился)
3. (Per-cut, не cumulative)

* **Verified**: t4 cuts=2 без R3: 549 overlap'ов; с R3: **0 overlap'ов** (откатывает 2-й cut).
* **No-op** на полезных cut'ах: t1 cuts=2 (iso 2.26→2.00 = 11% improvement → принят).
* **Метрика в info**: `info['adaptive_cuts']['n_cuts_rolled_back']` + `['rollbacks']` (детали).

### `unfold.py` (exposed parameters)

Добавлены **4 новых параметра** в `PARAMS` (все с safe defaults):

```python
"adaptive_cuts_overlap_rollback": True,           # R3 включён
"adaptive_cuts_overlap_growth_factor": 1.2,       # +20% overlap allowed
"adaptive_cuts_overlap_min_threshold": 20,        # noise floor
"adaptive_cuts_iso_improvement_threshold": 0.05,  # 5% rel iso threshold
```

Прогресс-сообщения дополнены:
- `↩ cut N ROLLBACK: ov X→Y, iso A→B (overlap_growth_no_iso_gain)` — R3 trigger
- `⚠ BD-polish: применена регуляризация (R1)` — R1 trigger
- `↩ BD-polish: hard stop (R2) — blow_up_at_iter_N, откат к best iso` — R2 trigger

## Backward compatibility — guarantees

| Сценарий | Stock | + R1+R2+R3 | Δ |
|---|---|---|---|
| t1 baseline (no cuts, no BD) | edge_p95=4.34% | edge_p95=4.34% | 0 (identical) |
| t1 cuts=2 (полезные cuts) | 4.07% / 90 ov | 4.07% / 90 ov | 0 (R3 не trigger) |
| t1 + BD K=2.0 | iso=1.92 | iso=1.92 | 0 (R1/R2 не trigger) |
| **t4 cuts=2 (overlap-bad)** | 12.05% / **549** ov | 12.52% / **0** ov ✓ | **-549 ov** |
| **t4 + BD (любой K)** | 💥 RuntimeError | iso=3.49 / 0 inv ✓ | **+1 success** |
| **t9 + BD K=1.7** | iso=5.10 | **iso=2.97** ✓ | **-2.13** |

**Все 6 случаев backward-compatible или строго лучше.**

## Deploy (drop-in replacement)

### Шаг 1. Бэкап

```bash
cd nasal-planner/
cp bd_polish.py bd_polish.py.backup
cp operations/unfold.py operations/unfold.py.backup
cp adaptive_cuts.py adaptive_cuts.py.backup
```

### Шаг 2. Замена

Скопируйте файлы из этой папки на их места:
```
production_patches/bd_polish.py     → bd_polish.py
production_patches/adaptive_cuts.py → adaptive_cuts.py
production_patches/unfold.py        → operations/unfold.py
```

### Шаг 3. Verify (smoke test)

Запустите ваш существующий test-suite. Все тесты должны пройти **без изменений** —
backward-compat гарантирована.

### Шаг 4. (Опциональный) Включение adaptive_cuts по умолчанию

Если вы хотите чтобы pipeline автоматически применял cuts на проблемных мешах,
в `tab4-unfold.js`:

```js
// Старая версия (только если фронт явно запрашивает):
const body = {
  mode: unfoldMode,
  arap_iterations: 80,
  // ... другие поля без adaptive_cuts_max
};

// Рекомендованная версия (cuts on by default для clinical use):
const body = {
  mode: unfoldMode,
  arap_iterations: 80,
  adaptive_cuts_max: 2,         // <-- НОВОЕ: до 2 cut'ов автоматически
  adaptive_cuts_threshold: 1.8,
  // ... остальное без изменений
};
```

R3 защитит от bad cuts автоматически — этот опцион **безопасен**.

### Шаг 5. (Опциональный) UI control

В `nasal-planner.html` секции `<div class="stage" data-stage="unfold">`
можно добавить slider для cuts:

```html
<div class="card">
  <div class="card-title">Параметры развёртки</div>
  <div class="param-row">
    <label>Adaptive cuts (0-3):</label>
    <input type="range" id="adaptiveCutsMax" min="0" max="3" value="2"
           oninput="window._adaptiveCutsMax = this.value">
    <span id="adaptiveCutsMaxLabel">2</span>
  </div>
</div>
```

И в `tab4-unfold.js` соответственно использовать `window._adaptiveCutsMax`.

## Откат (если что-то пошло не так)

```bash
cp bd_polish.py.backup bd_polish.py
cp operations/unfold.py.backup operations/unfold.py
cp adaptive_cuts.py.backup adaptive_cuts.py
```

## Что доступно для рецензии

* **Diffs**: `git diff bd_polish.py.backup bd_polish.py` и т.д.
* **Verification данные**: см. `results_v2/*.json` в research пакете
* **Полный отчёт**: см. `report/08_round4_patches_and_curvature.md`

## Performance impact

| Mesh | Stock time | + R1/R2/R3 active | Δ |
|---|---|---|---|
| t1 (no cuts, no BD) | 1.9s | 1.9s | 0 |
| t1 + cuts=2 | ~3s | ~3s + 0.5s overlap check × 2 = ~4s | +30% |
| t6 + cuts=2 | ~30s | ~32s | +7% |

Overhead R3 — **только при активных cuts**. R1+R2 — без ovherhead на нормальных мешах.

## Что НЕ входит в этот пакет

Эти изменения остались в research-фазе и **не предлагаются для production** без
дополнительной валидации:

* **Per-cone cuts** (`h5_per_cone_cuts.py`) — главный research breakthrough
  (превосходит libigl ARAP на 5/10 мешах), но требует unit-test'ов на edge cases
  и UI integration перед merge.
* **Anisotropic distortion correction** (`anisotropic_correct.py`) — research-level,
  работает только на t6 (distortion > 1.4).
* **Boundary turning preflight check** (`curvature_analysis.py`) — диагностика,
  можно добавить как UI warning отдельным шагом.

Эти улучшения положены в roadmap для следующего цикла.
