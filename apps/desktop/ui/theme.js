// Выбор темы: светлая, тёмная или как в системе. Подключается в <head>
// до отрисовки, чтобы окно не мигало чужой темой при запуске.

"use strict";

(() => {
  const query = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;
  let choice = "system";

  function read() {
    try {
      const raw = localStorage.getItem("stoat.ui.appearance");
      const saved = raw ? JSON.parse(raw) : null;
      return saved && typeof saved.theme === "string" ? saved.theme : "system";
    } catch {
      return "system";
    }
  }

  function apply() {
    const light = choice === "light" || (choice === "system" && query && query.matches);
    document.documentElement.dataset.theme = light ? "light" : "dark";
  }

  if (query) {
    const onchange = () => choice === "system" && apply();
    if (query.addEventListener) query.addEventListener("change", onchange);
    else if (query.addListener) query.addListener(onchange);
  }

  window.ArachnidTheme = {
    set(next) {
      choice = ["light", "dark", "system"].includes(next) ? next : "system";
      apply();
    },
  };

  choice = read();
  apply();
})();
