/**
 * ha-map-dim.js — панельная карта Lovelace:
 *  1) при выборе человека его маршрут остаётся как рисует HA, маршруты
 *     остальных скрываются; никто не выбран — все маршруты обычные;
 *  2) форма «история маршрутов» встроена в штатную панель карты
 *     («Люди/Устройства»): заготовки периодов и произвольный период
 *     «с … по …» — маршруты за период рисуются на той же карте и
 *     подчиняются скрытию чужих. Форма оформлена переменными темы HA
 *     и видна только вместе с карточкой карты.
 *
 * Установка: файл в /config/www/ha-map-dim.js, затем
 * Настройки → Дашборды → Ресурсы → /local/ha-map-dim.js (JavaScript Module),
 * и жёсткое обновление страницы (Ctrl+F5).
 */
(() => {
  if (window.__haMapDimInstalled) return;
  window.__haMapDimInstalled = true;

  // ---------- поиск элементов в теневом DOM ----------
  function find(root, tag, depth = 0) {
    if (depth > 120) return null;
    for (const el of root.querySelectorAll('*')) {
      if (el.tagName.toLowerCase() === tag) return el;
      const inShadow = el.shadowRoot && find(el.shadowRoot, tag, depth + 1);
      if (inShadow) return inShadow;
    }
    return null;
  }
  const getMap = () => find(document, 'ha-map');
  const getCard = () => find(document, 'hui-map-card');
  // штатная панель карты («Люди/Устройства»): hui-map-overview → div.panel
  const getOverviewPanel = () => {
    const ov = find(document, 'hui-map-overview');
    return ov?.shadowRoot?.querySelector('div.panel') ?? null;
  };

  // ---------- кто выбран и что скрывать ----------
  function selectedName(map) {
    const ent = map.entities?.find(e => e.selected);
    return ent && map._states?.[ent.entity_id]?.attributes?.friendly_name || null;
  }

  // подстрока: в конфиге может быть name "S9" при friendly_name "Galaxy S9"
  const matches = (a, b) =>
    !!a && !!b && (a.toLowerCase().includes(b.toLowerCase()) || b.toLowerCase().includes(a.toLowerCase()));

  // чужой путь — только если имена известны и не совпадают; иначе не трогаем.
  // режим истории (map.__haMapDimHistory) скрывает живые пути целиком
  function isOtherPath(map, idx) {
    if (map.__haMapDimHistory) return true;
    const name = selectedName(map);
    const path = map.paths?.[idx];
    return !!name && !!path?.name && !matches(path.name, name);
  }

  // скрытие = прозрачность 0 у всех отрезков и точек пути
  function scale(l, dim) {
    if (!dim || !l) return l;
    const zero = v => (typeof v === 'number' && !isNaN(v)) ? 0 : v;
    return {
      ...l,
      segments: l.segments.map(s => ({ ...s, opacity: zero(s.opacity) })),
      markers: l.markers.map(m => ({ ...m, opacity: zero(m.opacity) })),
    };
  }

  // ---------- история маршрутов ----------
  let historyState = null; // { handles: [{handle, path, name}] }

  // карточный путь {name, color, gradualOpacity, points:[{point, timestamp}]}
  // → движковый {color, segments:[{opacity, points}], markers:[{location, opacity, tooltipHtml}]}.
  // Градиент — по порядку точек (как в родном _drawPaths HA): от 1-gradualOpacity к 1.
  function toEnginePath(map, p) {
    const pts = p.points, segments = [], markers = [];
    const n = pts.length;
    const op = i => p.gradualOpacity
      ? (1 - p.gradualOpacity) + i * (p.gradualOpacity / Math.max(n - 2, 1))
      : undefined;
    for (let i = 0; i < n - 1; i++) {
      const o = op(i);
      markers.push({ location: pts[i].point, opacity: o, tooltipHtml: map._computePathTooltip(p, pts[i]) });
      segments.push({ points: [pts[i].point, pts[i + 1].point], opacity: o });
    }
    if (n) {
      const o = op(n - 1);
      markers.push({ location: pts[n - 1].point, opacity: o, tooltipHtml: map._computePathTooltip(p, pts[n - 1]) });
    }
    return { color: p.color, segments, markers };
  }

  const zeroed = ep => ({
    ...ep,
    segments: ep.segments.map(s => ({ ...s, opacity: 0 })),
    markers: ep.markers.map(m => ({ ...m, opacity: 0 })),
  });

  // пересчитать видимость исторических путей при смене выбора
  function applyHistoryDim() {
    if (!historyState) return;
    const map = getMap();
    if (!map?._engine) return;
    const sel = selectedName(map);
    for (const { handle, path, name } of historyState.handles) {
      const mine = !!sel && matches(name, sel);
      handle.update(!sel || mine ? path : zeroed(path));
    }
  }

  async function loadHistory(start, end) {
    const map = getMap(), card = getCard();
    if (!map?._engine || !card) return;
    // убрать прошлый исторический слой
    historyState?.handles.forEach(h => { try { h.handle.remove(); } catch (e) {} });
    historyState = null;
    map.__haMapDimHistory = null;
    if (!start) { map._drawPaths(); return; } // «Сейчас»

    // скрыть живые маршруты сразу — до и на время загрузки истории
    map.__haMapDimHistory = historyState = { handles: [] };
    map._drawPaths();
    const hass = card.hass ?? document.querySelector('home-assistant')?.hass;
    const ids = (card._configEntities ?? []).map(e => e.entity);
    // плотная GPS-история в recorder есть только у трекеров-источников;
    // у person.* хранятся лишь смены состояния (зон) — трек из стрима в БД не пишется.
    // узнаём источник каждого человека и запрашиваем историю и его трекера тоже
    const sourceOf = {};
    try {
      const pl = await hass.callWS({ type: 'person/list' });
      for (const p of [...(pl?.storage ?? []), ...(pl?.config ?? [])]) {
        const eid = p.entity_id ?? 'person.' + p.id;
        if (p.device_trackers?.length) sourceOf[eid] = p.device_trackers;
      }
    } catch (e) { /* нет доступа к person/list — останется история зон */ }
    const allIds = [...new Set([...ids, ...Object.values(sourceOf).flat()])].filter(id => hass.states?.[id]);
    const raw = await hass.callApi('GET', 'history/period/' + start.toISOString() +
      '?end_time=' + end.toISOString() + '&filter_entity_id=' + allIds.join(','));
    // REST-состояния → формат истории карточки {s, a, lu (секунды)}
    const synth = {};
    (raw ?? []).forEach(arr => {
      if (!arr?.length) return;
      synth[arr[0].entity_id] = arr.map(st => ({
        s: st.state,
        a: st.attributes,
        lu: new Date(st.last_updated).getTime() / 1000,
      }));
    });
    // подмешать плотный трек трекера в историю человека (по времени, без дублей координат)
    for (const eid of ids) {
      const rows = synth[eid] ?? [];
      const tr = (sourceOf[eid] ?? []).flatMap(t => synth[t] ?? []);
      if (!tr.length) continue;
      const seen = [];
      const merged = [...rows, ...tr]
        .sort((x, y) => x.lu - y.lu)
        .filter(r => {
          const la = r.a?.latitude, lo = r.a?.longitude;
          if (la == null || lo == null) return true;
          const k = la.toFixed(5) + ',' + lo.toFixed(5);
          if (seen[seen.length - 1] === k) return false;
          seen.push(k);
          return true;
        });
      synth[eid] = merged;
    }
    // родной конвертер карточки: состояния → пути (имена, цвета, точки)
    const paths = card._getHistoryPaths(
      card._config, synth, card._entityReg, card._themes, card._formatters?.formatEntityName,
    ) ?? [];

    const engineAdd = Object.getPrototypeOf(map._engine).addPath; // без прокси скрытия
    for (const p of paths) {
      if (!p.points?.length) continue;
      const ep = toEnginePath(map, p);
      historyState.handles.push({ handle: engineAdd.call(map._engine, ep), path: ep, name: p.name });
    }
    applyHistoryDim();
  }

  // ---------- форма выбора периода ----------
  let periodForm = null;

  const fmtDate = d =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  // заготовка = даты для полей «с … по …»; третий элемент — live-режим («Сейчас»)
  function kindDates(kind) {
    const day = n => fmtDate(new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() - n));
    if (kind === 'today') return [day(0), day(0), false];
    if (kind === 'yesterday') return [day(1), day(1), false];
    if (kind === 'dby') return [day(2), day(2), false];
    if (kind === '3d') return [day(2), day(0), false];
    if (kind === '7d') return [day(6), day(0), false];
    return [day(0), day(0), true]; // «Сейчас» — живой режим, поля показывают сегодня
  }
  function dayStart(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  // произвольный период: [с 00:00 … до конца дня «по»], конец не позже «сейчас»
  async function runRange(f, t) {
    let start = dayStart(f);
    let endDay = t ? dayStart(t) : null;
    let end = endDay ? new Date(endDay.getFullYear(), endDay.getMonth(), endDay.getDate() + 1) : new Date();
    if (start > end) [start, end] = [end, start];
    const now = new Date();
    if (end > now) end = now;
    try { await loadHistory(start, end); } catch (e) { console.error('ha-map-dim history:', e); }
  }

  function resetForm() {
    if (!periodForm) return;
    const [f, t] = kindDates('now');
    periodForm._sel.value = 'now';
    periodForm._from.value = f;
    periodForm._to.value = t;
  }

  // форма в дизайне темы HA (переменные --divider-color, --secondary-text-color, …)
  function buildForm() {
    const fieldBox = 'background:var(--secondary-background-color,rgba(127,127,127,.12));' +
      'border:1px solid var(--divider-color,#e1e1e11f);' +
      'border-radius:var(--ha-border-radius-sm,4px);padding:6px 8px;font-size:13px;font-family:inherit';
    const field = fieldBox + ';color:var(--primary-text-color,#e1e1e1)';
    const form = document.createElement('div');
    form.className = 'ha-map-dim-period';
    form.style.cssText = 'margin-top:var(--ha-space-2,8px);padding:var(--ha-space-3,12px);' +
      'display:flex;flex-direction:column;gap:var(--ha-space-2,8px);' +
      'background:var(--ha-color-fill-neutral-quiet-resting,rgba(127,127,127,.12));' +
      'border-radius:var(--ha-border-radius-lg,12px)';
    // пустое поле даты: плейсхолдер цветом плейсхолдеров HA (--mdc-text-field-label-ink-color)
    const style = document.createElement('style');
    style.textContent =
      '.ha-map-dim-period input[type="date"]{color:var(--primary-text-color,#e1e1e1)}' +
      '.ha-map-dim-period input[type="date"]:invalid{color:var(--mdc-text-field-label-ink-color,#ffffff99)}' +
      '.ha-map-dim-period option{background:var(--card-background-color,#fff);color:var(--primary-text-color,#000)}';
    form.append(style);
    // HA не задаёт color-scheme: календарная иконка и нативный пикер даты
    // должны следовать теме (обновляется в syncTick при смене темы)
    form.style.colorScheme =
      document.querySelector('home-assistant')?.hass?.themes?.darkMode ? 'dark' : 'light';
    const cap = document.createElement('div');
    cap.textContent = 'История маршрутов';
    cap.style.cssText = 'font-size:12px;color:var(--secondary-text-color,#9b9b9b);' +
      'text-transform:uppercase;letter-spacing:.06em';
    const sel = document.createElement('select');
    sel.title = 'Заготовки периодов';
    sel.style.cssText = field + ';width:100%';
    for (const [v, t] of [['now', 'Сейчас'], ['today', 'Сегодня'], ['yesterday', 'Вчера'], ['dby', 'Позавчера'], ['3d', '3 дня'], ['7d', 'Неделя']]) {
      const o = document.createElement('option');
      o.value = v; o.textContent = t;
      sel.append(o);
    }
    const lab = t => {
      const s = document.createElement('span');
      s.textContent = t;
      s.style.cssText = 'font-size:12px;color:var(--secondary-text-color,#9b9b9b)';
      return s;
    };
    const from = document.createElement('input');
    from.type = 'date';
    from.title = 'Период: с';
    from.required = true; // пустое поле = :invalid = цвет плейсхолдера
    from.style.cssText = fieldBox + ';flex:1 1 0;min-width:0';
    const to = document.createElement('input');
    to.type = 'date';
    to.title = 'Период: по';
    to.required = true;
    to.style.cssText = fieldBox + ';flex:1 1 0;min-width:0';
    // две равные группы «label + поле» — сжатие гарантировано flex-базисом 0
    const dates = document.createElement('div');
    dates.style.cssText = 'display:flex;gap:var(--ha-space-2,8px)';
    const group = (label, input) => {
      const g = document.createElement('div');
      g.style.cssText = 'flex:1;display:flex;align-items:center;gap:var(--ha-space-1,4px);min-width:0';
      g.append(label, input);
      return g;
    };
    dates.append(group(lab('с'), from), group(lab('по'), to));
    form.append(cap, sel, dates);
    form._sel = sel; form._from = from; form._to = to;

    sel.onchange = () => {
      const [f, t, live] = kindDates(sel.value);
      from.value = f;
      to.value = t;
      if (live) { loadHistory(null, null).catch(e => console.error('ha-map-dim history:', e)); return; }
      runRange(f, t);
    };
    from.onchange = () => { if (from.value) { sel.value = 'now'; runRange(from.value, to.value); } };
    to.onchange = () => { if (from.value || to.value) { sel.value = 'now'; runRange(from.value || to.value, to.value); } };
    return form;
  }

  // форма живёт внутри карточки — её видимость следует за карточкой автоматически
  function attachForm() {
    if (!periodForm || periodForm.isConnected) return;
    const panelDiv = getOverviewPanel();
    if (!panelDiv) return;
    panelDiv.append(periodForm);
  }

  function mapVisible() {
    const map = getMap();
    if (!map?.isConnected) return false;
    const r = map.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 &&
      r.top < innerHeight && r.left < innerWidth;
  }

  // тик: держать форму при карточке; при уходе с карты сбрасывать режим истории
  function syncTick() {
    attachForm();
    if (!mapVisible() && historyState) {
      historyState.handles.forEach(h => { try { h.handle.remove(); } catch (e) {} });
      historyState = null;
      const map = getMap();
      if (map) map.__haMapDimHistory = null;
      resetForm();
    }
  }

  // ---------- патч классов ----------
  function patch(mapCls, cardCls) {
    const mapProto = mapCls.prototype;
    const drawPaths = mapProto._drawPaths;
    mapProto._drawPaths = function () {
      const map = this;
      const engine = this._engine;
      // прокси на addPath движка (чистый метод — с прототипа класса движка)
      if (engine && !engine.__haMapDim) {
        engine.__haMapDim = true;
        const addPath = Object.getPrototypeOf(engine).addPath;
        engine.addPath = l => {
          const idx = map._pathHandles.length;
          const real = addPath.call(engine, scale(l, isOtherPath(map, idx)));
          return {
            update: l2 => real.update(scale(l2, isOtherPath(map, idx))),
            remove: () => real.remove(),
          };
        };
      }
      return drawPaths.call(this);
    };

    // смена выбора обновляет только камеру — просим перерисовать пути
    const cardProto = cardCls.prototype;
    const cardUpdated = cardProto.updated;
    cardProto.updated = function (changed) {
      cardUpdated.call(this, changed);
      if (changed.has('_overviewSelected')) {
        this._map?._drawPaths();
        applyHistoryDim();
      }
    };
  }

  // карта могла нарисоваться до патча — снять хэндлы (remove!) и перерисовать
  function kick() {
    const map = getMap();
    if (!map?._pathHandles) return;
    map._pathHandles.forEach(h => h.remove());
    map._pathHandles.length = 0;
    map._drawPaths();
  }

  let patched = false;
  function tryPatch() {
    if (patched) return true;
    const mapCls = customElements.get('ha-map');
    const cardCls = customElements.get('hui-map-card');
    if (!mapCls || !cardCls) return false;
    patch(mapCls, cardCls);
    patched = true;
    setTimeout(kick, 1500);   // пути могли уйти в отрисовку до патча
    setTimeout(kick, 4000);   // страховка на медленную загрузку истории
    return true;
  }

  periodForm = buildForm();
  resetForm(); // «Сейчас» сразу при открытии: поля показывают сегодняшний день
  setInterval(syncTick, 500);
  if (tryPatch()) return;

  // ha-map/hui-map-card грузятся лениво — ловим их регистрацию
  const define = customElements.define.bind(customElements);
  customElements.define = (name, ctor, opts) => {
    const r = define(name, ctor, opts);
    if ((name === 'ha-map' || name === 'hui-map-card') && tryPatch()) {
      customElements.define = define;
    }
    return r;
  };
})();
