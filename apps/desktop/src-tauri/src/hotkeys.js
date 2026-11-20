// Горячие клавиши: часть встроенного плагина «Quality of Life» (выполняется
// вместе с emoji.js и gifs.js), настройка `hotkeys`.
//
// * Сочетания ловит клиент (hotkeys.rs) — и когда окно свёрнуто или
//   спрятано в трей. Эта часть только сообщает ему, включена ли настройка
//   (команда hotkeys_activate), и выполняет действия звонка.
// * Действие звонка — как щелчок по кнопке в карточке звонка for-web
//   (VoiceCallCardActions): микрофон, звук, камера, демонстрация экрана,
//   выход. Кнопки ищутся рядом с кнопкой выхода (значок call_end) — в той же
//   полосе кнопок, в развёрнутой карточке и в маленькой (PiP). Не в звонке —
//   ничего не происходит. «Скрыть окно в трей» выполняет клиент.
// * Пока настройка включена, боковые кнопки мыши не листают страницы назад
//   и вперёд, как в браузере: их можно назначить. Сочетания браузера (F5,
//   F11, Ctrl+R…) в это время отключает клиент.
//
// Работает только там, где bridge.js создал window.__arachnidDesktop;
// объект `plugin` — от встроенного плагина (extensions.rs).
(() => {
  "use strict";

  const desktop = window.__arachnidDesktop;
  const internals = window.__TAURI_INTERNALS__;
  if (!desktop || !internals) return;

  const invoke = (command, args) => internals.invoke(command, args);

  /** Значки (Material Symbols) кнопок карточки звонка for-web по действиям */
  const CALL_BUTTONS = {
    toggle_mute: ["mic", "mic_off"],
    toggle_deafen: ["headset", "headset_off"],
    toggle_camera: ["camera_video"],
    toggle_screenshare: ["screen_share", "stop_screen_share"],
    disconnect: ["call_end"],
  };
  /** Кнопка выхода из звонка: остальные — в той же полосе */
  const END_CALL = "call_end";
  /** MouseEvent.button боковых кнопок «Назад» и «Вперёд» */
  const BACK_BUTTON = 3;
  const FORWARD_BUTTON = 4;

  let active = false;

  // ─────────────────────────────── звонок ───────────────────────────────

  /** Значок for-web — span, в тексте которого имя символа */
  const symbolOf = (element) =>
    element.childElementCount === 0 ? element.textContent.trim() : "";

  /** Полосы кнопок карточек звонка: родитель кнопки с call_end */
  function callBars() {
    const floating = document.getElementById("floating");
    if (!floating) return [];
    const bars = new Set();
    for (const span of floating.querySelectorAll("button span")) {
      if (symbolOf(span) !== END_CALL) continue;
      const bar = span.closest("button")?.parentElement;
      if (bar) bars.add(bar);
    }
    return [...bars];
  }

  /** Кнопка действия в карточке звонка; выключенная for-web не нажимается */
  function callButton(action) {
    const symbols = CALL_BUTTONS[action];
    if (!symbols) return null;
    for (const bar of callBars()) {
      for (const button of bar.querySelectorAll(":scope > button")) {
        const icon = [...button.querySelectorAll("span")].some((span) =>
          symbols.includes(symbolOf(span)),
        );
        if (icon && !button.disabled) return button;
      }
    }
    return null;
  }

  function onHotkey(action) {
    if (!active) return;
    const button = callButton(action);
    // click() без указателя — «виртуальное» нажатие, его for-web принимает
    // как нажатие с клавиатуры
    if (button) button.click();
  }

  // ─────────────────────── боковые кнопки мыши ───────────────────────

  /** Chromium листает историю по отпусканию боковой кнопки, если его не
   *  отменили */
  function onSideButton(event) {
    if (!active) return;
    if (event.button !== BACK_BUTTON && event.button !== FORWARD_BUTTON) return;
    event.preventDefault();
  }

  // ─────────────────────────────── настройка ───────────────────────────────

  function apply(values) {
    const next = values.hotkeys === true;
    if (next === active) return;
    active = next;
    invoke("hotkeys_activate", { active }).catch((error) =>
      console.error("[Arachnid] горячие клавиши", error),
    );
  }

  addEventListener("mouseup", onSideButton, true);
  addEventListener("auxclick", onSideButton, true);
  desktop.subscribe((type, detail) => {
    if (type === "hotkey") onHotkey(detail);
  });
  plugin.onSettingsChange(apply);
  apply(plugin.settings);
})();
