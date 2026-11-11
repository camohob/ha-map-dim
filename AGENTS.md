# AGENTS.md — как работать с репо

Плагин Home Assistant для Lovelace: один файл `ha-map-dim.js` (vanilla JS,
без сборки и зависимостей). Ставится через HACS/Marketplace (custom
repository, категория Lovelace/Dashboard) или вручную как ресурс.

## Структура

- `ha-map-dim.js` — весь код (имя файла = имя репозитория, это требование
  HACS; не переименовывать, `filename` в `hacs.json` тоже не менять).
- `hacs.json` — манифест HACS (`content_in_root`, `hide_default_branch`:
  версии берутся только из релизов).
- `README.md` — инструкция; секция ручной установки обёрнута в маркеры
  `<!-- ha-marketplace:exclude-start/end -->` — не удалять их.
- `.github/workflows/validate.yaml` — CI-валидация HACS (`hacs/action`,
  категория plugin; `ignore: images`, пока в README нет скриншотов).

## Цикл разработки

1. **Правка** `ha-map-dim.js` в репо.
2. **Живая проверка**: файл вливается в открытую вкладку с картой HA
   (перезагрузка вкладки → дождаться подъёма MapLibre/Leaflet → инъекция
   кода файла). Пока правка не проверена — ничего не публиковать.
3. **Релиз** (только после проверки на живой карте):
   - коммит → `git push` (push ходит через Git Credential Manager, scope
     workflow есть — `gh auth refresh` не нужен);
   - тег: фиксы/мелочи → патч `vX.Y.Z+1`, новые возможности → минор;
   - `gh release create vX.Y.Z ha-map-dim.js --title "vX.Y.Z" --notes "…"`
     — ассет с именем `ha-map-dim.js` обязателен, тег без Release версией
     HACS не считается.
4. **Обновление у пользователя**: в HACS появляется кнопка «Обновить» →
   нажать → Ctrl+F5 в браузере.

## Технические факты (не переоткрывать)

- Карта: `hui-map-card` → `hui-map-overview` → `ha-map`; маршруты рисует
  движок MapLibre (fallback Leaflet), у каждого пути GeoJSON-источники
  `ha-map-path-N-lines/-points` с per-feature свойством `opacity`
  (родной градиент 0.2→1 из `gradualOpacity: 0.8`).
- Патч ставится перехватом `ha-map.prototype._drawPaths` + прокси на
  `addPath` движка (чистый метод с `Object.getPrototypeOf`), чужие пути
  гасятся до отрисовки; выбор человека — по подстроке friendly-имени.
- История: REST `/api/history/period/{start}?end_time=&filter_entity_id=`
  → форматы `{s,a,lu(сек)}` → конвертер карточки `card._getHistoryPaths`
  → движковый путь `{color, segments[], markers[]}` → `addPath` с
  прототипа (мимо прокси скрытия). Флаг `map.__haMapDimHistory` +
  `map._drawPaths()` ставятся СРАЗУ при входе в режим, до fetch.
- Для `person.*` recorder хранит только смены зон; плотный GPS-трек берут
  у трекеров-источников: `hass.callWS({type:'person/list'})` возвращает
  ОБЪЕКТ `{storage:[...], config:[...]}`, трекеры в поле `device_trackers`
  (массив), их история подмешивается в путь человека (сортировка по `lu`,
  дедуп координат `toFixed(5)`).
- Форма истории живёт в штатной панели: `hui-map-overview` → shadowRoot →
  `div.panel` (прикрепление в syncTick каждые 500 мс). Дизайн — только
  переменные темы; поля дат — flex-группы; `color-scheme` выставлять из
  `hass.themes.darkMode` (HA сам его не задаёт).
- При уходе с карточки карты режим истории сбрасывается.
- Проверки скрытия на Leaflet: svg `path[stroke-opacity]` в
  `.leaflet-overlay-pane`, доступ только через обход shadowRoot.
