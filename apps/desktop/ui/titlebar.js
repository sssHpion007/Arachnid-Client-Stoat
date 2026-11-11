// Своя рамка окна (Titlebar.tsx браузерного клиента Stoat): полоса 29 px с
// названием, областью перетаскивания и кнопками «свернуть», «развернуть»,
// «закрыть». Видна, когда в «ПК» включена «Собственная рамка окна» или когда
// нет соединения со Stoat (тогда полоса подсвечена и показывает состояние).
//
// Подключается и на странице входа, и в основном окне, поэтому не зависит
// от помощников app.js.

"use strict";

(function () {
  const tauri = window.__TAURI__;
  const appWindow = tauri && tauri.window ? tauri.window.getCurrentWindow() : null;
  const invoke = tauri && tauri.core ? tauri.core.invoke : null;
  const isMacOS = /^Mac/.test(navigator.platform || "");
  const SVG = "http://www.w3.org/2000/svg";

  let customFrame = false;
  let connection = { state: "connected", retry: null };

  // строки переводятся при каждой отрисовке: каталог языка грузится позже
  const translate = (text) => (window.I18N ? window.I18N.t(text) : text);

  /** Значок Material Symbols из icons.js; без него — пустое место того же размера. */
  function icon(name) {
    const node = document.createElementNS(SVG, "svg");
    node.setAttribute("viewBox", "0 -960 960 960");
    node.setAttribute("width", "20");
    node.setAttribute("height", "20");
    node.setAttribute("aria-hidden", "true");
    const path = window.STOAT_ICONS && window.STOAT_ICONS[name];
    if (path) {
      const shape = document.createElementNS(SVG, "path");
      shape.setAttribute("d", path);
      node.append(shape);
    }
    return node;
  }

  const bar = document.createElement("div");
  bar.className = "titlebar hidden" + (isMacOS ? " macos" : "");
  bar.id = "titlebar";

  const title = document.createElement("div");
  title.className = "titlebar-title";
  title.setAttribute("data-tauri-drag-region", "");
  title.textContent = "Arachnid Client";

  const handle = document.createElement("div");
  handle.className = "titlebar-drag";
  handle.setAttribute("data-tauri-drag-region", "");

  const action = (name, label, run) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "titlebar-action";
    button.dataset.label = label;
    button.append(icon(name));
    button.addEventListener("click", run);
    return button;
  };

  const maximise = action("expand_content", /* i18n */ "Maximise", async () => {
    if (appWindow) await appWindow.toggleMaximize();
  });
  const actions = isMacOS || !appWindow
    ? []
    : [
        action("minimize", /* i18n */ "Minimise", () => appWindow.minimize()),
        maximise,
        // закрытие проходит через CloseRequested: при «Сворачивать в трей» окно прячется
        action("close", /* i18n */ "Close", () => appWindow.close()),
      ];
  bar.append(title, handle, ...actions);

  async function syncMaximised() {
    if (!appWindow) return;
    try {
      const maximised = await appWindow.isMaximized();
      maximise.replaceChildren(icon(maximised ? "collapse_content" : "expand_content"));
    } catch {
      /* окно уже закрывается */
    }
  }

  function render() {
    const disconnected = connection.state !== "connected";
    bar.classList.toggle("hidden", !customFrame && !disconnected);
    bar.classList.toggle("disconnected", disconnected);
    document.documentElement.classList.toggle("with-titlebar", !bar.classList.contains("hidden"));

    for (const button of actions) button.title = translate(button.dataset.label);
    handle.replaceChildren();
    const text = {
      connecting: /* i18n */ "Connecting",
      reconnecting: /* i18n */ "Reconnecting",
      disconnected: /* i18n */ "Disconnected",
      offline: /* i18n */ "Device is offline",
    }[connection.state];
    if (text) handle.append(document.createTextNode(translate(text)));
    if (connection.retry && (connection.state === "disconnected" || connection.state === "offline")) {
      const retry = document.createElement("a");
      retry.className = "titlebar-retry";
      retry.href = "#";
      const strong = document.createElement("strong");
      strong.textContent = " " + translate(/* i18n */ "(reconnect now)");
      retry.append(strong);
      retry.addEventListener("click", (event) => {
        event.preventDefault();
        connection.retry();
      });
      handle.append(retry);
    }
  }

  /** Применить настройки «ПК», которые касаются страницы. */
  function applyDesktopConfig(config) {
    if (!config) return;
    customFrame = Boolean(config.customFrame);
    // проверка орфографии наследуется всеми полями ввода от корня
    document.documentElement.spellcheck = config.spellchecker !== false;
    render();
  }

  /**
   * Состояние соединения: "connected", "connecting", "reconnecting",
   * "disconnected" или "offline"; `retry` — повторить подключение сейчас.
   */
  function setTitlebarConnection(state, retry = null) {
    connection = { state, retry };
    render();
  }

  window.applyDesktopConfig = applyDesktopConfig;
  window.setTitlebarConnection = setTitlebarConnection;

  const mount = () => {
    document.body.prepend(bar);
    render();
    syncMaximised();
    if (appWindow && appWindow.onResized) appWindow.onResized(syncMaximised);
    if (invoke) {
      invoke("desktop_config")
        .then(applyDesktopConfig)
        .catch((error) => console.warn("настройки ПК:", error));
    }
  };
  window.addEventListener("arachnid-locale", render);
  if (window.I18N) window.I18N.ready.then(render);
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
})();
