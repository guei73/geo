/*
 * Интерактивная SVG-карта: отрисовка стран, масштаб/перемещение
 * (колесо, перетаскивание, щипок на телефоне), подсветки и подписи.
 */
(function (root) {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var CLICK_TOLERANCE = 7;      // px: дальше — это уже перетаскивание, а не клик
  var MARKER_MAX_AREA = 100;    // страны мельче (в единицах карты) получают кружок-мишень
  var MARKER_HIDE_PX = 18;      // кружок прячется, когда страна на экране крупнее ~18 px

  function el(name, attrs, parent) {
    var node = document.createElementNS(NS, name);
    for (var k in attrs) node.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(node);
    return node;
  }

  function easeInOut(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function MapView(container, data, opts) {
    this.container = container;
    this.data = data;
    this.opts = opts || {};
    this.W = data.width;
    this.H = data.height;
    this.view = { k: 1, x: 0, y: 0 };
    this.insets = { top: 0, bottom: 0, left: 0, right: 0 };
    this.paths = {};
    this.markers = {};
    this.anim = null;
    this.interactive = true;
    this._build();
    this._bind();
    this._resize();
    this.showAll(false);
  }

  MapView.prototype._build = function () {
    var svg = el('svg', { class: 'map-svg', role: 'img', 'aria-label': 'Политическая карта Евразии, Австралии и Океании' });
    var vp = el('g', { class: 'viewport' }, svg);
    el('rect', { class: 'ocean', x: 0, y: 0, width: this.W, height: this.H }, vp);
    el('path', { class: 'land-bg', d: this.data.background }, vp);
    this.countryLayer = el('g', { class: 'countries' }, vp);
    this.markerLayer = el('g', { class: 'markers' }, vp);
    this.labelLayer = el('g', { class: 'labels' }, vp);

    var isos = Object.keys(this.data.countries);
    for (var i = 0; i < isos.length; i++) {
      var iso = isos[i];
      var c = this.data.countries[iso];
      this.paths[iso] = el('path', { class: 'country', d: c.d, 'data-iso': iso }, this.countryLayer);
      if (c.area < MARKER_MAX_AREA || iso === '090' || iso === '242') {
        var m = el('circle', { class: 'marker', cx: c.c[0], cy: c.c[1], r: 6, 'data-iso': iso }, this.markerLayer);
        this.markers[iso] = m;
      }
    }
    this.svg = svg;
    this.viewport = vp;
    this.container.appendChild(svg);
  };

  /*
   * Как устроена плавность.
   * Перерисовывать всю векторную карту на каждом кадре дорого, поэтому во время
   * перемещения и масштабирования двигается уже отрисованный слой (CSS transform,
   * считается видеокартой). Когда движение затихает, карта перерисовывается
   * начисто в новом масштабе («фиксация»). Слой SVG сделан с запасом по краям,
   * чтобы при перетаскивании не было видно пустых полос.
   */
  var SVG_PAD = 0.5;      // запас слоя: половина экрана с каждой стороны
  var COMMIT_DELAY = 140; // мс тишины до перерисовки начисто

  MapView.prototype._bind = function () {
    var self = this;
    var svg = this.svg;
    var box = this.container;
    var pointers = new Map();
    var gesture = null;

    function local(e) {
      var r = box.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    // --- Колесо: плавное приближение к точке под курсором -------------
    svg.addEventListener('wheel', function (e) {
      e.preventDefault();
      var p = local(e);
      var dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 33;        // строки → пиксели
      else if (e.deltaMode === 2) dy *= 400;  // страницы
      // Щипок на тачпаде приходит как wheel с ctrlKey и мелкими шагами.
      var speed = e.ctrlKey ? 0.008 : 0.0011;
      dy = Math.max(-150, Math.min(150, dy));
      self.stopAnimation();
      self._smoothZoom(p.x, p.y, Math.exp(-dy * speed));
      self._interact();
    }, { passive: false });

    // Правая кнопка — перемещение, без контекстного меню.
    box.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    box.addEventListener('auxclick', function (e) { e.preventDefault(); });

    svg.addEventListener('pointerdown', function (e) {
      // 0 — левая, 1 — средняя, 2 — правая: перемещать можно любой.
      if (e.pointerType === 'mouse' && e.button > 2) return;
      if (e.button === 1) e.preventDefault(); // без автопрокрутки браузера
      self.stopAnimation();
      self._stopSmooth();
      try { svg.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      pointers.set(e.pointerId, local(e));
      if (pointers.size === 1) {
        var p = local(e);
        var secondary = e.pointerType === 'mouse' && e.button !== 0;
        gesture = {
          type: 'pan', startX: p.x, startY: p.y, vx: self.view.x, vy: self.view.y,
          // Правой/средней кнопкой ответить нельзя — сразу перемещаем карту.
          moved: secondary, noClick: secondary,
          target: secondary ? null : (e.target.closest ? e.target.closest('[data-iso]') : null)
        };
        if (secondary) { svg.classList.add('is-dragging'); self._interact(); }
      } else if (pointers.size === 2) {
        var pts = Array.from(pointers.values());
        gesture = {
          type: 'pinch', moved: true,
          dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1,
          mid: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 },
          view: self.getView()
        };
      }
    });

    svg.addEventListener('pointermove', function (e) {
      if (!pointers.has(e.pointerId)) {
        if (self.opts.onHover && e.pointerType === 'mouse') {
          var t = e.target.closest ? e.target.closest('[data-iso]') : null;
          self.opts.onHover(t ? t.getAttribute('data-iso') : null, e.clientX, e.clientY);
        }
        return;
      }
      pointers.set(e.pointerId, local(e));
      if (!gesture) return;
      if (gesture.type === 'pan' && pointers.size === 1) {
        var p = local(e);
        var dx = p.x - gesture.startX, dy = p.y - gesture.startY;
        if (!gesture.moved && Math.hypot(dx, dy) > CLICK_TOLERANCE) {
          gesture.moved = true;
          // Начинаем от текущей точки, чтобы карта не «прыгала» на величину допуска.
          gesture.startX = p.x; gesture.startY = p.y;
          gesture.vx = self.view.x; gesture.vy = self.view.y;
          dx = 0; dy = 0;
          svg.classList.add('is-dragging');
          if (self.opts.onHover) self.opts.onHover(null);
          self._interact();
        }
        if (gesture.moved) self.setView({ k: self.view.k, x: gesture.vx + dx, y: gesture.vy + dy });
      } else if (gesture.type === 'pinch' && pointers.size >= 2) {
        var pts = Array.from(pointers.values());
        var dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
        var mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
        var v0 = gesture.view;
        var k = self._clampK(v0.k * dist / gesture.dist);
        // Точка карты под исходной серединой щипка следует за пальцами.
        var mx = (gesture.mid.x - v0.x) / v0.k, my = (gesture.mid.y - v0.y) / v0.k;
        self.setView({ k: k, x: mid.x - mx * k, y: mid.y - my * k });
        self._interact();
      }
    });

    function end(e) {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      if (gesture && gesture.type === 'pan' && !gesture.moved && !gesture.noClick &&
          e.type === 'pointerup' && pointers.size === 0) {
        var t = gesture.target;
        if (t && self.interactive && self.opts.onCountryClick) {
          self.opts.onCountryClick(t.getAttribute('data-iso'), e.clientX, e.clientY);
        }
      }
      if (pointers.size === 1 && gesture && gesture.type === 'pinch') {
        // После щипка оставшийся палец продолжает панорамирование без «клика».
        var rest = Array.from(pointers.values())[0];
        gesture = { type: 'pan', startX: rest.x, startY: rest.y, vx: self.view.x, vy: self.view.y, moved: true, target: null };
      } else if (pointers.size === 0) {
        gesture = null;
        svg.classList.remove('is-dragging');
      }
    }
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    svg.addEventListener('pointerleave', function (e) {
      if (e.pointerType === 'mouse' && self.opts.onHover && !pointers.size) self.opts.onHover(null);
    });

    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(function () { self._resize(); }).observe(this.container);
    } else {
      window.addEventListener('resize', function () { self._resize(); });
    }
  };

  MapView.prototype._interact = function () {
    if (this.opts.onInteract) this.opts.onInteract();
  };

  MapView.prototype._resize = function () {
    var r = this.container.getBoundingClientRect();
    var prevW = this.cw, prevH = this.ch;
    this.cw = Math.max(1, r.width);
    this.ch = Math.max(1, r.height);
    this.padX = Math.round(this.cw * SVG_PAD);
    this.padY = Math.round(this.ch * SVG_PAD);
    var st = this.svg.style;
    st.left = -this.padX + 'px';
    st.top = -this.padY + 'px';
    st.width = this.cw + this.padX * 2 + 'px';
    st.height = this.ch + this.padY * 2 + 'px';
    this.minK = Math.min(this.cw / this.W, this.ch / this.H) * 0.85;
    this.maxK = Math.max(this.minK * 10, 18);
    if (prevW) {
      // Сохраняем центр обзора при повороте экрана / изменении окна.
      var cx = (prevW / 2 - this.view.x) / this.view.k;
      var cy = (prevH / 2 - this.view.y) / this.view.k;
      this.setView({ k: this.view.k, x: this.cw / 2 - cx * this.view.k, y: this.ch / 2 - cy * this.view.k }, true);
    }
  };

  MapView.prototype._clampK = function (k) {
    return Math.max(this.minK, Math.min(this.maxK, k));
  };

  /* Мягкое ограничение: на экране всегда остаётся хотя бы четверть карты/экрана. */
  MapView.prototype._clamp = function (v) {
    var k = this._clampK(v.k);
    var mw = this.W * k, mh = this.H * k;
    var keepX = Math.min(mw, this.cw) * 0.25, keepY = Math.min(mh, this.ch) * 0.25;
    var x = Math.min(this.cw - keepX, Math.max(keepX - mw, v.x));
    var y = Math.min(this.ch - keepY, Math.max(keepY - mh, v.y));
    return { k: k, x: x, y: y };
  };

  /* immediate = перерисовать сразу (без промежуточного GPU-сдвига). */
  MapView.prototype.setView = function (v, immediate) {
    this.view = this._clamp(v);
    if (immediate) this._commit();
    else this._apply();
  };

  MapView.prototype.getView = function () {
    return { k: this.view.k, x: this.view.x, y: this.view.y };
  };

  /* Быстрый путь: сдвигаем и масштабируем уже нарисованный слой. */
  MapView.prototype._apply = function () {
    if (!this.committed) { this._commit(); return; }
    var v = this.view, c = this.committed;
    var s = v.k / c.k;
    var tx = v.x - (c.x + this.padX) * s + this.padX;
    var ty = v.y - (c.y + this.padY) * s + this.padY;
    // Если сдвинутый слой уже не закрывает экран (дальний перелёт или сильный
    // зум) — перерисовываем сразу, иначе по краям мелькнёт пустота.
    var left = tx - this.padX, top = ty - this.padY;
    var right = left + (this.cw + 2 * this.padX) * s, bottom = top + (this.ch + 2 * this.padY) * s;
    if (left > 0 || top > 0 || right < this.cw || bottom < this.ch || s > 3) { this._commit(); return; }
    this.svg.style.transform = 'translate(' + tx.toFixed(2) + 'px,' + ty.toFixed(2) + 'px) scale(' + s.toFixed(5) + ')';
    var self = this;
    clearTimeout(this._commitTimer);
    this._commitTimer = setTimeout(function () {
      if (!self.anim && !self.smooth) self._commit();
    }, COMMIT_DELAY);
  };

  /* Полная перерисовка в текущем масштабе. */
  MapView.prototype._commit = function () {
    clearTimeout(this._commitTimer);
    var v = this.view;
    this.committed = { k: v.k, x: v.x, y: v.y };
    this.viewport.setAttribute('transform', 'translate(' + (v.x + this.padX).toFixed(2) + ',' +
      (v.y + this.padY).toFixed(2) + ') scale(' + v.k.toFixed(5) + ')');
    this.svg.style.transform = '';
    var inv = 1 / v.k;
    for (var iso in this.markers) {
      var b = this.data.countries[iso].box;
      var size = Math.max(b[2] - b[0], b[3] - b[1]) * v.k;
      var m = this.markers[iso];
      m.setAttribute('r', (6.5 * inv).toFixed(3));
      m.style.display = size > MARKER_HIDE_PX ? 'none' : '';
    }
    var labels = this.labelLayer.childNodes;
    for (var i = 0; i < labels.length; i++) this._placeLabel(labels[i]);
  };

  MapView.prototype._placeLabel = function (l) {
    var k = this.committed ? this.committed.k : this.view.k;
    l.setAttribute('transform', 'translate(' + l._x + ',' + l._y + ') scale(' + (1 / k).toFixed(5) + ')');
  };

  /* Перевод точки карты в экранные координаты (для тестов и подсказок). */
  MapView.prototype.toClient = function (mx, my) {
    var r = this.container.getBoundingClientRect(), v = this.view;
    return { x: r.left + mx * v.k + v.x, y: r.top + my * v.k + v.y };
  };

  MapView.prototype.zoomAt = function (px, py, factor) {
    var v = this.view;
    var k = this._clampK(v.k * factor);
    var mx = (px - v.x) / v.k, my = (py - v.y) / v.k;
    this.setView({ k: k, x: px - mx * k, y: py - my * k });
  };

  /*
   * Плавный зум колесом: каждое деление колеса меняет целевой масштаб,
   * а текущий догоняет его за несколько кадров. Точка под курсором остаётся на месте.
   */
  MapView.prototype._smoothZoom = function (px, py, factor) {
    var v = this.view;
    var sm = this.smooth;
    var targetK = this._clampK((sm ? sm.k : v.k) * factor);
    // Точка карты под курсором (по текущему, а не целевому виду).
    var mx = (px - v.x) / v.k, my = (py - v.y) / v.k;
    if (sm) { sm.k = targetK; sm.px = px; sm.py = py; sm.mx = mx; sm.my = my; return; }
    var self = this;
    sm = this.smooth = { k: targetK, px: px, py: py, mx: mx, my: my, id: 0 };
    function frame() {
      var s = self.smooth;
      if (!s) return;
      var lk = Math.log(self.view.k), lt = Math.log(s.k);
      var nk = Math.abs(lt - lk) < 0.002 ? s.k : Math.exp(lk + (lt - lk) * 0.28);
      self.setView({ k: nk, x: s.px - s.mx * nk, y: s.py - s.my * nk });
      if (nk === s.k) { self.smooth = null; self._apply(); return; }
      s.id = requestAnimationFrame(frame);
    }
    sm.id = requestAnimationFrame(frame);
  };

  MapView.prototype._stopSmooth = function () {
    if (this.smooth) { cancelAnimationFrame(this.smooth.id); this.smooth = null; }
  };

  MapView.prototype.zoomBy = function (factor) {
    this._stopSmooth();
    var v = this.view;
    var cx = this.insets.left + (this.cw - this.insets.left - this.insets.right) / 2;
    var cy = this.insets.top + (this.ch - this.insets.top - this.insets.bottom) / 2;
    var k = this._clampK(v.k * factor);
    var mx = (cx - v.x) / v.k, my = (cy - v.y) / v.k;
    this.animateTo({ k: k, x: cx - mx * k, y: cy - my * k }, 320);
  };

  MapView.prototype.setInsets = function (insets) {
    this.insets = Object.assign({ top: 0, bottom: 0, left: 0, right: 0 }, insets);
  };

  /* Вписать прямоугольник карты [x0,y0,x1,y1] в видимую область. */
  MapView.prototype.viewForBox = function (box, o) {
    o = o || {};
    var pad = o.padding != null ? o.padding : 24;
    var ins = this.insets;
    var aw = Math.max(40, this.cw - ins.left - ins.right - pad * 2);
    var ah = Math.max(40, this.ch - ins.top - ins.bottom - pad * 2);
    var bw = Math.max(1, box[2] - box[0]), bh = Math.max(1, box[3] - box[1]);
    var k = Math.min(aw / bw, ah / bh);
    // На узком (портретном) экране разрешаем обрезать края по горизонтали,
    // иначе широкий регион становится слишком мелким.
    if (o.allowCrop && aw / ah < 0.9) k = Math.min(aw / bw * o.allowCrop, ah / bh);
    if (o.maxK) k = Math.min(k, o.maxK);
    if (o.minK) k = Math.max(k, o.minK);
    k = this._clampK(k);
    var cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
    var sx = ins.left + (this.cw - ins.left - ins.right) / 2;
    var sy = ins.top + (this.ch - ins.top - ins.bottom) / 2;
    return { k: k, x: sx - cx * k, y: sy - cy * k };
  };

  MapView.prototype.fitBox = function (box, o) {
    o = o || {};
    var v = this.viewForBox(box, o);
    if (o.animate === false) { this.stopAnimation(); this._stopSmooth(); this.setView(v, true); }
    else this.animateTo(v, o.duration || 650);
  };

  MapView.prototype.showAll = function (animate) {
    this.fitBox([0, 0, this.W, this.H], { padding: 8, animate: animate });
  };

  /* Рамка вокруг набора стран (по их основным частям). */
  MapView.prototype.boxOf = function (isos) {
    var b = [Infinity, Infinity, -Infinity, -Infinity];
    for (var i = 0; i < isos.length; i++) {
      var c = this.data.countries[isos[i]];
      if (!c) continue;
      b[0] = Math.min(b[0], c.box[0]); b[1] = Math.min(b[1], c.box[1]);
      b[2] = Math.max(b[2], c.box[2]); b[3] = Math.max(b[3], c.box[3]);
    }
    return b;
  };

  /* Хорошо ли страна видна сейчас: целиком в кадре и не крошечная. */
  MapView.prototype.isWellVisible = function (iso) {
    var c = this.data.countries[iso], v = this.view, ins = this.insets;
    var x0 = c.box[0] * v.k + v.x, y0 = c.box[1] * v.k + v.y;
    var x1 = c.box[2] * v.k + v.x, y1 = c.box[3] * v.k + v.y;
    var inside = x0 >= ins.left && y0 >= ins.top && x1 <= this.cw - ins.right && y1 <= this.ch - ins.bottom;
    return inside && (x1 - x0) * (y1 - y0) > 400;
  };

  MapView.prototype.animateTo = function (target, duration) {
    var self = this;
    this.stopAnimation();
    this._stopSmooth();
    target = this._clamp(target);
    var from = this.getView();
    var cw = this.cw, ch = this.ch;
    var fc = { x: (cw / 2 - from.x) / from.k, y: (ch / 2 - from.y) / from.k };
    var tc = { x: (cw / 2 - target.x) / target.k, y: (ch / 2 - target.y) / target.k };
    var lk0 = Math.log(from.k), lk1 = Math.log(target.k);
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || !duration) { this.setView(target, true); return; }
    var t0 = performance.now();
    var anim = { id: 0 };
    function step(now) {
      var t = Math.min(1, (now - t0) / duration);
      var e = easeInOut(t);
      var k = Math.exp(lk0 + (lk1 - lk0) * e);
      var cx = fc.x + (tc.x - fc.x) * e, cy = fc.y + (tc.y - fc.y) * e;
      self.view = { k: k, x: cw / 2 - cx * k, y: ch / 2 - cy * k };
      self._apply();
      if (t < 1) anim.id = requestAnimationFrame(step);
      else { self.anim = null; self.setView(target, true); }
    }
    anim.id = requestAnimationFrame(step);
    this.anim = anim;
  };

  MapView.prototype.stopAnimation = function () {
    if (this.anim) { cancelAnimationFrame(this.anim.id); this.anim = null; }
  };

  // --- Состояния стран -------------------------------------------------

  MapView.prototype._each = function (iso, fn) {
    if (this.paths[iso]) fn(this.paths[iso]);
    if (this.markers[iso]) fn(this.markers[iso]);
  };

  MapView.prototype.addClass = function (iso, cls) {
    this._each(iso, function (n) { n.classList.add(cls); });
    this.raise(iso);
  };

  MapView.prototype.removeClass = function (iso, cls) {
    this._each(iso, function (n) { n.classList.remove(cls); });
  };

  MapView.prototype.clearClass = function (cls) {
    var nodes = this.svg.querySelectorAll('.' + cls);
    for (var i = 0; i < nodes.length; i++) nodes[i].classList.remove(cls);
  };

  /* Поднять страну над соседями, чтобы её контур был виден целиком. */
  MapView.prototype.raise = function (iso) {
    var p = this.paths[iso];
    if (p && p.parentNode.lastChild !== p) p.parentNode.appendChild(p);
  };

  /* Пометить активные (кликабельные) страны; остальные приглушаются. */
  MapView.prototype.setActive = function (isos) {
    var set = {};
    for (var i = 0; i < isos.length; i++) set[isos[i]] = true;
    for (var iso in this.paths) {
      var on = !!set[iso];
      this._each(iso, function (n) { n.classList.toggle('is-inactive', !on); });
    }
  };

  MapView.prototype.resetStates = function () {
    ['is-ok', 'is-bad', 'is-target', 'is-reveal', 'is-wrong', 'is-picked'].forEach(this.clearClass, this);
    this.clearLabels();
  };

  // --- Подписи ----------------------------------------------------------

  /* kind: 'capital' | 'country' | 'wrong' | 'ok' */
  MapView.prototype.addLabel = function (x, y, text, kind) {
    var g = el('g', { class: 'label label-' + (kind || 'country') }, this.labelLayer);
    g._x = x; g._y = y;
    if (kind === 'capital') {
      el('circle', { class: 'pin-halo', r: 9 }, g);
      el('circle', { class: 'pin', r: 4.5 }, g);
    }
    var dy = kind === 'capital' ? -14 : 0;
    var txt = el('text', { x: 0, y: dy, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, g);
    txt.textContent = text;
    // Подложка под текст рисуется после измерения.
    var bbox = { width: text.length * 7.2, height: 16 };
    try { var bb = txt.getBBox(); if (bb.width) bbox = bb; } catch (e) { /* not rendered yet */ }
    var bg = el('rect', {
      class: 'label-bg', x: -bbox.width / 2 - 7, y: dy - 11, width: bbox.width + 14, height: 22, rx: 11
    });
    g.insertBefore(bg, txt);
    this._placeLabel(g);
    return g;
  };

  MapView.prototype.labelCountry = function (iso, text, kind) {
    var c = this.data.countries[iso];
    return this.addLabel(c.c[0], c.c[1], text, kind);
  };

  MapView.prototype.labelCapital = function (iso, text) {
    var c = this.data.countries[iso];
    return this.addLabel(c.cap[0], c.cap[1], text, 'capital');
  };

  MapView.prototype.clearLabels = function () {
    while (this.labelLayer.firstChild) this.labelLayer.removeChild(this.labelLayer.firstChild);
  };

  root.MapView = MapView;
})(window);
