// Прототип плеера «Quality of Life» для превью. На странице Stoat плеер
// встаёт поверх элементов for-web, не заменяя их: <video>/<audio> остаются на
// месте и играют сами, у них только выключаются стандартные кнопки.
//
// * Видео лежит в SizedContent — сетке, где все дети в одной ячейке, поэтому
//   слой плеера просто ещё один ребёнок поверх видео; размер сообщения не
//   меняется. Спойлер for-web (z-index 1) остаётся выше плеера.
// * Аудио лежит в карточке под FileInfo; <audio> без controls браузер и так
//   не показывает, вместо него — полоса плеера, а вместо значка наушников в
//   FileInfo — обложка (или нота, если её нет) того же размера.
// * destroy() возвращает всё как было: так работает выключение настройки.

const Player = (() => {
  "use strict";

  const T = {
    play: "Смотреть (k)",
    pause: "Пауза (k)",
    listen: "Слушать",
    replay: "Сначала",
    mute: "Без звука (m)",
    unmute: "Включить звук (m)",
    repeatOn: "Повтор: вкл.",
    repeatOff: "Повтор: выкл.",
    speed: "Скорость",
    normal: "Обычная",
    pip: "Картинка в картинке",
    fullscreen: "Во весь экран (f)",
    exitFullscreen: "Выйти из полноэкранного режима (f)",
    download: "Скачать",
    videoError: "Не удалось воспроизвести видео",
    audioError: "Не удалось воспроизвести аудио",
    errorHint: "Формат не поддерживается — файл можно скачать.",
  };

  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  /** Через сколько мс без движения мыши прятать управление видео */
  const HIDE_MS = 2500;
  /** Шаг перемотки стрелками, с */
  const SEEK_STEP = 5;
  /** Спиннер — только если ждать дольше этого, мс */
  const SPINNER_DELAY = 300;

  /** Скорость общая для всех плееров и не запоминается между запусками */
  let speed = 1;
  const players = new Set();

  const SVG = "http://www.w3.org/2000/svg";
  function icon(name) {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 -960 960 960");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", ICONS[name]);
    svg.append(path);
    return svg;
  }

  /** Заменить значок, только если он другой: замена под курсором между
   *  нажатием и отпусканием мыши съедает щелчок */
  function setIcon(element, name) {
    if (element.dataset.icon === name) return;
    element.dataset.icon = name;
    const next = icon(name);
    const old = element.querySelector(":scope > svg");
    if (old) old.replaceWith(next);
    else element.prepend(next);
  }

  function h(tag, attributes = {}, ...children) {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) {
      if (value === false || value == null) continue;
      if (key === "class") element.className = value;
      else if (key.startsWith("on")) element.addEventListener(key.slice(2), value);
      else element.setAttribute(key, value === true ? "" : value);
    }
    element.append(...children.filter((child) => child != null));
    return element;
  }

  /** Кнопка со значком и подсказкой; `tip` — функция, чтобы подпись менялась */
  function button(name, className = "") {
    const element = h("button", { type: "button", class: `ap-button ${className}`.trim() }, icon(name));
    element.dataset.icon = name;
    element.setIcon = (next) => setIcon(element, next);
    element.setTip = (text) => {
      element.dataset.tip = text;
      element.setAttribute("aria-label", text);
    };
    return element;
  }

  function time(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
    const s = Math.floor(seconds % 60);
    const m = Math.floor(seconds / 60) % 60;
    const hours = Math.floor(seconds / 3600);
    const pad = (n) => String(n).padStart(2, "0");
    return hours ? `${hours}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  const speedLabel = (value) => (value === 1 ? T.normal : `${String(value).replace(".", ",")}×`);

  // ─────────────────────────── полоса перемотки ───────────────────────────

  function progress(media, { onDrag }) {
    const buffered = h("div", { class: "ap-buffered" });
    const played = h("div", { class: "ap-played" });
    const thumb = h("div", { class: "ap-thumb" });
    const tip = h("div", { class: "ap-seek-tip" });
    const root = h(
      "div",
      { class: "ap-progress", role: "slider", "aria-label": "Перемотка", tabindex: "-1" },
      h("div", { class: "ap-rail" }, buffered, played, thumb),
      tip,
    );
    let dragging = false;
    let dragTime = 0;

    const ratioAt = (event) => {
      const rect = root.getBoundingClientRect();
      return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    };

    function paint(current = dragging ? dragTime : media.currentTime) {
      const duration = media.duration;
      const ratio = Number.isFinite(duration) && duration > 0 ? current / duration : 0;
      played.style.width = `${ratio * 100}%`;
      thumb.style.left = `${ratio * 100}%`;
      let end = 0;
      for (let i = 0; i < media.buffered.length; i++) {
        if (media.buffered.start(i) <= media.currentTime) end = Math.max(end, media.buffered.end(i));
      }
      buffered.style.width = Number.isFinite(duration) && duration > 0 ? `${(end / duration) * 100}%` : "0";
    }

    function showTip(event) {
      if (!Number.isFinite(media.duration)) return;
      const ratio = ratioAt(event);
      tip.textContent = time(ratio * media.duration);
      const width = root.getBoundingClientRect().width;
      const half = tip.offsetWidth / 2;
      tip.style.left = `${Math.min(width - half, Math.max(half, ratio * width))}px`;
    }

    root.addEventListener("pointermove", (event) => {
      showTip(event);
      if (!dragging) return;
      dragTime = ratioAt(event) * media.duration;
      paint();
    });
    root.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !Number.isFinite(media.duration)) return;
      event.preventDefault();
      root.setPointerCapture(event.pointerId);
      dragging = true;
      root.classList.add("ap-dragging");
      dragTime = ratioAt(event) * media.duration;
      paint();
      onDrag(true);
    });
    const release = () => {
      if (!dragging) return;
      dragging = false;
      root.classList.remove("ap-dragging");
      media.currentTime = dragTime;
      paint();
      onDrag(false);
    };
    root.addEventListener("pointerup", release);
    root.addEventListener("pointercancel", release);

    return { root, paint };
  }

  // ─────────────────────────────── громкость ───────────────────────────────

  function volume(media) {
    const toggle = button("volumeUp", "ap-volume-button");
    const slider = h("input", {
      type: "range",
      class: "ap-volume-slider",
      min: "0",
      max: "1",
      step: "0.01",
      "aria-label": "Громкость",
    });
    const root = h("div", { class: "ap-volume" }, toggle, slider);
    let before = 1;

    function sync() {
      const level = media.muted ? 0 : media.volume;
      slider.value = String(level);
      slider.style.setProperty("--level", `${level * 100}%`);
      toggle.setIcon(level === 0 ? "volumeOff" : level < 0.5 ? "volumeDown" : "volumeUp");
      toggle.setTip(level === 0 ? T.unmute : T.mute);
    }

    toggle.addEventListener("click", () => {
      if (media.muted || media.volume === 0) {
        media.muted = false;
        if (media.volume === 0) media.volume = before || 1;
      } else {
        before = media.volume;
        media.muted = true;
      }
    });
    slider.addEventListener("input", () => {
      media.volume = Number(slider.value);
      media.muted = media.volume === 0;
    });
    media.addEventListener("volumechange", sync);
    sync();
    return {
      root,
      step(delta) {
        media.muted = false;
        media.volume = Math.min(1, Math.max(0, media.volume + delta));
      },
      toggle: () => toggle.click(),
    };
  }

  // ─────────────────────────────── скорость ───────────────────────────────

  /**
   * Меню скорости. У видео оно внутри плеера (и так работает во весь экран),
   * у аудио — всплывающее (popover) поверх страницы: карточка for-web
   * обрезает всё, что выходит за её края.
   */
  function speedMenu(anchorButton, menuHost, { onOpen, floating = false }) {
    const list = h("div", { class: "ap-menu-list", role: "menu" });
    const menu = h(
      "div",
      { class: `ap-menu${floating ? " ap-floating" : ""}`, hidden: !floating, popover: floating ? "manual" : null },
      h("div", { class: "ap-menu-title" }, T.speed),
      list,
    );
    (floating ? document.body : menuHost).append(menu);
    const isOpen = () => (floating ? menu.matches(":popover-open") : !menu.hidden);

    function place() {
      const rect = anchorButton.getBoundingClientRect();
      const height = menu.offsetHeight;
      const above = rect.top - 8 - height >= 8;
      menu.style.top = `${above ? rect.top - 8 - height : rect.bottom + 8}px`;
      menu.style.left = `${Math.max(8, rect.right - menu.offsetWidth)}px`;
    }

    function render() {
      list.replaceChildren(
        ...SPEEDS.map((value) =>
          h(
            "button",
            {
              type: "button",
              class: `ap-menu-item${value === speed ? " ap-selected" : ""}`,
              role: "menuitemradio",
              "aria-checked": String(value === speed),
              onclick: () => {
                setSpeed(value);
                close();
              },
            },
            h("span", { class: "ap-menu-check" }, value === speed ? icon("check") : null),
            speedLabel(value),
          ),
        ),
      );
    }

    const outside = (event) => {
      if (!menu.contains(event.target) && !anchorButton.contains(event.target)) close();
    };
    function open() {
      render();
      if (floating) {
        menu.showPopover();
        place();
        window.addEventListener("scroll", close, true);
        window.addEventListener("resize", close);
      } else menu.hidden = false;
      anchorButton.classList.add("ap-open");
      document.addEventListener("pointerdown", outside, true);
      onOpen(true);
    }
    function close() {
      if (!isOpen()) return;
      if (floating) {
        menu.hidePopover();
        window.removeEventListener("scroll", close, true);
        window.removeEventListener("resize", close);
      } else menu.hidden = true;
      anchorButton.classList.remove("ap-open");
      document.removeEventListener("pointerdown", outside, true);
      onOpen(false);
    }
    anchorButton.addEventListener("click", () => (isOpen() ? close() : open()));
    menu.addEventListener("keydown", (event) => event.key === "Escape" && (close(), anchorButton.focus()));
    return { close, isOpen, remove: () => (close(), menu.remove()) };
  }

  function setSpeed(value) {
    speed = value;
    for (const player of players) player.applySpeed();
  }

  /** Клавиши, пока плеер в фокусе; `extra` — свои клавиши видео */
  function keys(media, controls, extra = {}) {
    return (event) => {
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.target.closest?.("input[type=range]") && event.key.startsWith("Arrow")) return;
      // пробел и Enter на кнопке — нажатие самой кнопки
      if ((event.key === " " || event.key === "Enter") && event.target.closest?.("button")) return;
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      const action = {
        " ": controls.toggle,
        k: controls.toggle,
        ArrowLeft: () => (media.currentTime = Math.max(0, media.currentTime - SEEK_STEP)),
        ArrowRight: () => (media.currentTime = Math.min(media.duration || 0, media.currentTime + SEEK_STEP)),
        m: controls.volume.toggle,
        "<": () => setSpeed(SPEEDS[Math.max(0, SPEEDS.indexOf(speed) - 1)]),
        ">": () => setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(speed) + 1)]),
        Home: () => (media.currentTime = 0),
        End: () => (media.currentTime = media.duration || 0),
        ...extra,
      }[key];
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      action();
    };
  }

  // ───────────────────────────────── видео ─────────────────────────────────

  function enhanceVideo(video, { download }) {
    const host = video.parentElement;
    const before = { controls: video.controls, rate: video.playbackRate, tabindex: host.getAttribute("tabindex") };
    video.controls = false;
    host.classList.add("ap-host");
    host.tabIndex = 0;

    const bigPlay = h("button", { type: "button", class: "ap-big-play", "aria-label": T.play }, icon("play"));
    const flash = h("div", { class: "ap-flash", "aria-hidden": "true" });
    const spinner = h("div", { class: "ap-spinner", hidden: true });
    const downloadButton = button("download", "ap-corner");
    downloadButton.setTip(T.download);
    const errorBox = h(
      "div",
      { class: "ap-error", hidden: true },
      icon("error"),
      h("strong", {}, T.videoError),
      h("span", {}, T.errorHint),
    );

    const play = button("play");
    const vol = volume(video);
    const clock = h("span", { class: "ap-time" }, "0:00 / 0:00");
    const repeat = button("repeat", "ap-toggle");
    const settings = button("settings");
    settings.setTip(T.speed);
    const pip = button("pip");
    pip.setTip(T.pip);
    const full = button("fullscreen", "ap-edge");
    const overlay = h("div", { class: "ap-video" });
    const seek = progress(video, { onDrag: (on) => (dragging = on, wake()) });
    const menu = speedMenu(settings, overlay, { onOpen: wake });
    const speedBadge = h("span", { class: "ap-speed-badge", hidden: true });
    settings.append(speedBadge);

    overlay.append(
      spinner,
      flash,
      bigPlay,
      errorBox,
      downloadButton,
      h(
        "div",
        { class: "ap-bottom" },
        seek.root,
        h(
          "div",
          { class: "ap-bar" },
          play,
          vol.root,
          clock,
          h("span", { class: "ap-spacer" }),
          repeat,
          settings,
          document.pictureInPictureEnabled ? pip : null,
          full,
        ),
      ),
    );
    host.append(overlay);

    let started = false;
    let dragging = false;
    let hideTimer = 0;
    let spinnerTimer = 0;
    let frame = 0;

    const toggle = () => {
      if (video.paused || video.ended) void video.play().catch(() => {});
      else video.pause();
    };

    // Управление видно, пока мышь над видео и двигается; на паузе — пока
    // мышь над видео. Мышь ушла — управление и «скачать» прячутся.
    let hovering = false;
    function wake() {
      overlay.classList.add("ap-active");
      host.classList.remove("ap-idle");
      clearTimeout(hideTimer);
      hideTimer = setTimeout(sleep, HIDE_MS);
    }
    function sleep() {
      if (dragging || menu.isOpen() || (hovering && video.paused)) return;
      overlay.classList.remove("ap-active");
      host.classList.toggle("ap-idle", hovering);
    }

    function showFlash(name) {
      flash.replaceChildren(icon(name));
      flash.classList.remove("ap-flashing");
      void flash.offsetWidth;
      flash.classList.add("ap-flashing");
    }

    function sync() {
      const paused = video.paused || video.ended;
      play.setIcon(video.ended ? "replay" : paused ? "play" : "pause");
      play.setTip(video.ended ? T.replay : paused ? T.play : T.pause);
      overlay.classList.toggle("ap-started", started);
      overlay.classList.toggle("ap-paused", paused);
      overlay.classList.toggle("ap-ended", video.ended && !video.loop);
      setIcon(bigPlay, video.ended ? "replay" : "play");
      repeat.classList.toggle("ap-on", video.loop);
      repeat.setTip(video.loop ? T.repeatOn : T.repeatOff);
      const fullscreen = document.fullscreenElement === host;
      overlay.classList.toggle("ap-fullscreen", fullscreen);
      full.setIcon(fullscreen ? "fullscreenExit" : "fullscreen");
      full.setTip(fullscreen ? T.exitFullscreen : T.fullscreen);
      clock.textContent = `${time(video.currentTime)} / ${time(video.duration)}`;
      seek.paint();
      if (hovering) wake();
    }

    function tick() {
      seek.paint();
      clock.textContent = `${time(video.currentTime)} / ${time(video.duration)}`;
      frame = video.paused ? 0 : requestAnimationFrame(tick);
    }

    const fullscreen = () => {
      if (document.fullscreenElement === host) void document.exitFullscreen();
      else void host.requestFullscreen().catch(() => {});
    };

    const controls = { toggle, volume: vol };
    const onKey = keys(video, controls, {
      f: fullscreen,
      ArrowUp: () => vol.step(0.05),
      ArrowDown: () => vol.step(-0.05),
    });

    const listeners = [
      [video, "play", () => ((started = true), sync(), (frame ||= requestAnimationFrame(tick)))],
      [video, "pause", sync],
      [video, "ended", sync],
      [video, "loadedmetadata", sync],
      [video, "durationchange", sync],
      [video, "progress", () => seek.paint()],
      [video, "seeked", sync],
      [video, "waiting", () => ((spinnerTimer = setTimeout(() => (spinner.hidden = false), SPINNER_DELAY)))],
      [video, "playing", () => (clearTimeout(spinnerTimer), (spinner.hidden = true))],
      [video, "canplay", () => (clearTimeout(spinnerTimer), (spinner.hidden = true))],
      [video, "error", () => ((errorBox.hidden = false), overlay.classList.add("ap-failed"))],
      [
        video,
        "click",
        () => {
          if (!started) return toggle();
          showFlash(video.paused ? "play" : "pause");
          toggle();
          host.focus({ preventScroll: true });
        },
      ],
      [video, "dblclick", fullscreen],
      [host, "pointermove", () => ((hovering = true), wake())],
      [host, "pointerleave", () => ((hovering = false), clearTimeout(hideTimer), (hideTimer = setTimeout(sleep, 300)))],
      [host, "keydown", onKey],
      [document, "fullscreenchange", sync],
    ];
    for (const [target, type, handler] of listeners) target.addEventListener(type, handler);

    bigPlay.addEventListener("click", toggle);
    play.addEventListener("click", toggle);
    repeat.addEventListener("click", () => ((video.loop = !video.loop), sync()));
    full.addEventListener("click", fullscreen);
    pip.addEventListener("click", () =>
      document.pictureInPictureElement === video
        ? void document.exitPictureInPicture()
        : void video.requestPictureInPicture().catch(() => {}),
    );
    downloadButton.addEventListener("click", () => download(video.currentSrc || video.src));
    // правый щелчок по управлению — меню for-web у самого видео
    overlay.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      video.dispatchEvent(new MouseEvent("contextmenu", event));
    });

    const player = {
      applySpeed() {
        video.playbackRate = speed;
        speedBadge.hidden = speed === 1;
        speedBadge.textContent = `${String(speed).replace(".", ",")}×`;
      },
      destroy() {
        for (const [target, type, handler] of listeners) target.removeEventListener(type, handler);
        cancelAnimationFrame(frame);
        clearTimeout(hideTimer);
        menu.remove();
        overlay.remove();
        host.classList.remove("ap-host", "ap-idle");
        if (before.tabindex === null) host.removeAttribute("tabindex");
        else host.setAttribute("tabindex", before.tabindex);
        video.controls = before.controls;
        video.playbackRate = before.rate;
        players.delete(player);
      },
    };
    players.add(player);
    player.applySpeed();
    sync();
    if (video.error) video.dispatchEvent(new Event("error"));
    return player;
  }

  // ───────────────────────────────── аудио ─────────────────────────────────

  /**
   * Варианты карточки (для превью):
   * 1 — квадратная обложка-кнопка на месте значка наушников;
   * 2 — круглая обложка-кнопка с кольцом прогресса;
   * 3 — большая обложка-кнопка слева во всю высоту карточки;
   * 4 — компактно: круглая обложка-кнопка, справа имя, перемотка и кнопки.
   */
  function enhanceAudio(audio, { download, cover, layout = 1 }) {
    const card = audio.parentElement;
    const info = audio.previousElementSibling;
    const headphones = info?.firstElementChild;
    const downloadButton = info?.lastElementChild;
    const before = { controls: audio.controls, rate: audio.playbackRate };
    audio.controls = false;
    card.classList.add("ap-audio-card", `ap-layout-${layout}`);

    // обложка — она же кнопка воспроизведения
    const ring = layout === 2 ? progressRing() : null;
    const state = h("span", { class: "ap-cover-state" }, icon("play"), equalizer());
    const art = h(
      "button",
      { type: "button", class: "ap-cover" },
      h("span", { class: "ap-cover-image" }, icon("note")),
      state,
      ring?.root,
    );

    const current = h("span", { class: "ap-time" }, "0:00");
    const total = h("span", { class: "ap-time" }, "0:00");
    const seek = progress(audio, { onDrag: () => {} });
    const vol = volume(audio);
    const repeat = button("repeat", "ap-toggle");
    const speedButton = h("button", { type: "button", class: "ap-button ap-speed-button", "data-tip": T.speed }, "1×");
    const errorLine = h("div", { class: "ap-audio-error", hidden: true }, icon("error"), T.audioError);
    const added = [art, errorLine];

    let bar;
    if (layout === 4) {
      // кнопки — в строке с именем, перед «скачать»; ниже — перемотка и время
      const tools = h("div", { class: "ap-audio-tools" }, vol.root, repeat, speedButton);
      downloadButton.before(tools);
      bar = h("div", { class: "ap-audio" }, seek.root, h("span", { class: "ap-time ap-time-both" }, current, " / ", total));
      added.push(tools);
    } else {
      bar = h("div", { class: "ap-audio" }, current, seek.root, total, vol.root, repeat, speedButton);
    }
    added.push(bar);
    if (layout === 1 || layout === 2) headphones?.before(art);
    else card.prepend(art);
    headphones?.classList.add("ap-replaced");
    audio.after(bar, errorLine);
    const menu = speedMenu(speedButton, bar, { onOpen: () => {}, floating: true });

    const toggle = () => {
      if (audio.paused || audio.ended) void audio.play().catch(() => {});
      else audio.pause();
    };
    let frame = 0;

    function paintTime() {
      current.textContent = time(audio.currentTime);
      total.textContent = time(audio.duration);
      seek.paint();
      ring?.paint(audio.currentTime / audio.duration);
    }
    function sync() {
      const paused = audio.paused || audio.ended;
      const name = audio.ended ? "replay" : paused ? "play" : "pause";
      setIcon(state, name);
      const label = audio.ended ? T.replay : paused ? T.listen : T.pause;
      art.setAttribute("aria-label", label);
      art.dataset.tip = label;
      card.classList.toggle("ap-playing", !paused);
      repeat.classList.toggle("ap-on", audio.loop);
      repeat.setTip(audio.loop ? T.repeatOn : T.repeatOff);
      paintTime();
    }
    // на каждом кадре — только время и полосы, без перестройки кнопок
    function tick() {
      paintTime();
      frame = audio.paused ? 0 : requestAnimationFrame(tick);
    }

    const onKey = keys(audio, { toggle, volume: vol });
    const listeners = [
      [audio, "play", () => (sync(), (frame ||= requestAnimationFrame(tick)))],
      [audio, "pause", sync],
      [audio, "ended", sync],
      [audio, "loadedmetadata", sync],
      [audio, "durationchange", sync],
      [audio, "progress", () => seek.paint()],
      [audio, "seeked", sync],
      [audio, "error", () => ((errorLine.hidden = false), card.classList.add("ap-failed"))],
      [card, "keydown", onKey],
    ];
    for (const [target, type, handler] of listeners) target.addEventListener(type, handler);
    art.addEventListener("click", toggle);
    repeat.addEventListener("click", () => ((audio.loop = !audio.loop), sync()));

    // обложка — когда карточка подходит к экрану
    let alive = true;
    const watcher = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        watcher.disconnect();
        cover(audio.currentSrc || audio.src).then((url) => {
          if (!alive || !url) return;
          const image = h("img", { src: url, alt: "", draggable: "false" });
          image.addEventListener("load", () => {
            art.firstChild.replaceChildren(image);
            art.classList.add("ap-has-cover");
          });
        });
      },
      { rootMargin: "100% 0px" },
    );
    watcher.observe(card);

    const player = {
      applySpeed() {
        audio.playbackRate = speed;
        speedButton.textContent = `${String(speed).replace(".", ",")}×`;
      },
      destroy() {
        alive = false;
        watcher.disconnect();
        for (const [target, type, handler] of listeners) target.removeEventListener(type, handler);
        cancelAnimationFrame(frame);
        menu.remove();
        for (const node of added) node.remove();
        headphones?.classList.remove("ap-replaced");
        card.classList.remove("ap-audio-card", `ap-layout-${layout}`, "ap-playing", "ap-failed");
        audio.controls = before.controls;
        audio.playbackRate = before.rate;
        players.delete(player);
      },
    };
    players.add(player);
    player.applySpeed();
    sync();
    if (audio.error) audio.dispatchEvent(new Event("error"));
    return player;
  }

  /** Три полоски «играет» поверх обложки */
  function equalizer() {
    return h("span", { class: "ap-eq", "aria-hidden": "true" }, h("i"), h("i"), h("i"));
  }

  /** Кольцо прогресса вокруг круглой обложки */
  function progressRing() {
    const root = document.createElementNS(SVG, "svg");
    root.setAttribute("class", "ap-ring");
    root.setAttribute("viewBox", "0 0 56 56");
    root.setAttribute("aria-hidden", "true");
    const circle = (className) => {
      const element = document.createElementNS(SVG, "circle");
      element.setAttribute("class", className);
      element.setAttribute("cx", "28");
      element.setAttribute("cy", "28");
      element.setAttribute("r", "26");
      element.setAttribute("pathLength", "100");
      root.append(element);
      return element;
    };
    circle("ap-ring-track");
    const value = circle("ap-ring-value");
    return {
      root,
      paint(ratio) {
        const part = Number.isFinite(ratio) ? ratio : 0;
        value.style.strokeDashoffset = String(100 - part * 100);
        value.style.opacity = part > 0 ? "1" : "0";
      },
    };
  }

  return { enhanceVideo, enhanceAudio };
})();
