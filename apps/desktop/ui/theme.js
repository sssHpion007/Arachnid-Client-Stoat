// Тема клиента (Theme.ts и materialTheme.ts браузерного клиента Stoat):
// светлая/тёмная/как в системе, палитра Material You из акцента,
// контраста и варианта, размытие, шрифты и размеры сообщений.
// Подключается в <head> после vendor/material-color.js и до отрисовки,
// чтобы окно не мигало чужой темой при запуске.

"use strict";

(() => {
  const KEY = "stoat.ui.theme";

  /** Шрифты интерфейса (fonts.ts): имя в списке → семейство CSS. */
  const FONTS = {
    "Atkinson Hyperlegible": "Atkinson Hyperlegible",
    Bitter: "Bitter",
    "Comic Neue": "Comic Neue",
    "IBM Plex Sans Variable": "IBM Plex Sans Variable",
    Inter: "Inter",
    Lato: "Lato",
    Lexend: "Lexend",
    Montserrat: "Montserrat",
    "Noto Sans": "Noto Sans",
    "Open Sans": "Open Sans",
    OpenDyslexic: "OpenDyslexic",
    "Plus Jakarta Sans Variable": "Plus Jakarta Sans Variable",
    Poppins: "Poppins",
    Raleway: "Raleway",
    Roboto: "Roboto",
    Ubuntu: "Ubuntu",
  };

  /** Моноширинные шрифты. */
  const MONOSPACE_FONTS = {
    "Fira Code": "Fira Code",
    "IBM Plex Mono": "IBM Plex Mono",
    "JetBrains Mono": "JetBrains Mono Variable",
    "Roboto Mono": "Roboto Mono",
    "Source Code Pro": "Source Code Pro",
    "Space Mono": "Space Mono",
    "Ubuntu Mono": "Ubuntu Mono",
  };

  const VARIANTS = ["monochrome", "neutral", "tonal_spot", "vibrant", "expressive", "fidelity", "content", "rainbow", "fruit_salad"];

  /** Значения по умолчанию (Theme.default()). */
  const DEFAULTS = {
    mode: "system",
    accent: "#5470ec",
    contrast: 0,
    variant: "tonal_spot",
    blur: true,
    interfaceFont: "Inter",
    monospaceFont: "Fira Code",
    messageSize: 14,
    messageGroupSpacing: 12,
  };

  const query = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  /** Привести сохранённое к допустимым значениям (Theme.clean()). */
  function clean(input) {
    const data = Object.assign({}, DEFAULTS);
    if (!input || typeof input !== "object") return data;
    if (["light", "dark", "system"].includes(input.mode)) data.mode = input.mode;
    if (typeof input.accent === "string" && /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(input.accent)) {
      data.accent = input.accent;
    }
    if (typeof input.contrast === "number" && input.contrast >= -1 && input.contrast <= 1) data.contrast = input.contrast;
    if (VARIANTS.includes(input.variant)) data.variant = input.variant;
    if (typeof input.blur === "boolean") data.blur = input.blur;
    if (input.interfaceFont in FONTS) data.interfaceFont = input.interfaceFont;
    if (input.monospaceFont in MONOSPACE_FONTS) data.monospaceFont = input.monospaceFont;
    if (typeof input.messageSize === "number") data.messageSize = Math.min(24, Math.max(12, input.messageSize));
    if (typeof input.messageGroupSpacing === "number") {
      data.messageGroupSpacing = Math.min(16, Math.max(0, input.messageGroupSpacing));
    }
    return data;
  }

  /** Перенести настройки 0.8 («appearance») в новое хранилище темы. */
  function migrate() {
    try {
      const old = JSON.parse(localStorage.getItem("stoat.ui.appearance") || "null");
      if (!old) return null;
      const theme = clean({ mode: old.theme, messageSize: old.messageSize, messageGroupSpacing: old.groupSpacing });
      localStorage.setItem(KEY, JSON.stringify(theme));
      if (typeof old.sendButton === "boolean") {
        const settings = JSON.parse(localStorage.getItem("stoat.ui.settings") || "{}");
        settings["appearance:show_send_button"] = old.sendButton;
        localStorage.setItem("stoat.ui.settings", JSON.stringify(settings));
      }
      localStorage.removeItem("stoat.ui.appearance");
      return theme;
    } catch {
      return null;
    }
  }

  function read() {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? clean(JSON.parse(raw)) : migrate() || clean(null);
    } catch {
      return clean(null);
    }
  }

  let current = read();

  function isDark(theme) {
    return theme.mode === "dark" || (theme.mode === "system" && (!query || query.matches));
  }

  /** Палитра Material You (generateMaterialYouScheme). */
  function palette(theme, dark) {
    const lib = window.MaterialColor;
    if (!lib) return null;
    const schemes = {
      content: lib.SchemeContent,
      expressive: lib.SchemeExpressive,
      fidelity: lib.SchemeFidelity,
      fruit_salad: lib.SchemeFruitSalad,
      monochrome: lib.SchemeMonochrome,
      neutral: lib.SchemeNeutral,
      rainbow: lib.SchemeRainbow,
      vibrant: lib.SchemeVibrant,
      tonal_spot: lib.SchemeTonalSpot,
    };
    const Scheme = schemes[theme.variant] || lib.SchemeTonalSpot;
    const scheme = new Scheme(lib.Hct.fromInt(lib.argbFromHex(theme.accent)), dark, theme.contrast);
    const hex = (value) => lib.hexFromArgb(value);
    return {
      primary: hex(scheme.primary),
      "on-primary": hex(scheme.onPrimary),
      "primary-container": hex(scheme.primaryContainer),
      "on-primary-container": hex(scheme.onPrimaryContainer),
      secondary: hex(scheme.secondary),
      "on-secondary": hex(scheme.onSecondary),
      "secondary-container": hex(scheme.secondaryContainer),
      "on-secondary-container": hex(scheme.onSecondaryContainer),
      tertiary: hex(scheme.tertiary),
      "on-tertiary": hex(scheme.onTertiary),
      "tertiary-container": hex(scheme.tertiaryContainer),
      "on-tertiary-container": hex(scheme.onTertiaryContainer),
      error: hex(scheme.error),
      "on-error": hex(scheme.onError),
      "error-container": hex(scheme.errorContainer),
      "on-error-container": hex(scheme.onErrorContainer),
      "primary-fixed": hex(scheme.primaryFixed),
      "primary-fixed-dim": hex(scheme.primaryFixedDim),
      "on-primary-fixed": hex(scheme.onPrimaryFixed),
      "on-primary-fixed-variant": hex(scheme.onPrimaryFixedVariant),
      "secondary-fixed": hex(scheme.secondaryFixed),
      "secondary-fixed-dim": hex(scheme.secondaryFixedDim),
      "on-secondary-fixed": hex(scheme.onSecondaryFixed),
      "on-secondary-fixed-variant": hex(scheme.onSecondaryFixedVariant),
      "tertiary-fixed": hex(scheme.tertiaryFixed),
      "tertiary-fixed-dim": hex(scheme.tertiaryFixedDim),
      "on-tertiary-fixed": hex(scheme.onTertiaryFixed),
      "on-tertiary-fixed-variant": hex(scheme.onTertiaryFixedVariant),
      "surface-dim": hex(scheme.surfaceDim),
      surface: hex(scheme.surface),
      "surface-bright": hex(scheme.surfaceBright),
      "surface-variant": hex(scheme.surfaceVariant),
      "surface-container-lowest": hex(scheme.surfaceContainerLowest),
      "surface-container-low": hex(scheme.surfaceContainerLow),
      "surface-container": hex(scheme.surfaceContainer),
      "surface-container-high": hex(scheme.surfaceContainerHigh),
      "surface-container-highest": hex(scheme.surfaceContainerHighest),
      "on-surface": hex(scheme.onSurface),
      "on-surface-variant": hex(scheme.onSurfaceVariant),
      outline: hex(scheme.outline),
      "outline-variant": hex(scheme.outlineVariant),
      "inverse-surface": hex(scheme.inverseSurface),
      "inverse-on-surface": hex(scheme.inverseOnSurface),
      "inverse-primary": hex(scheme.inversePrimary),
      scrim: hex(scheme.scrim),
      shadow: hex(scheme.shadow),
    };
  }

  function apply() {
    const root = document.documentElement;
    const dark = isDark(current);
    root.dataset.theme = dark ? "dark" : "light";
    root.style.colorScheme = dark ? "dark" : "light";
    try {
      const colours = palette(current, dark);
      // без библиотеки остаются запасные цвета из theme.css
      if (colours) for (const [key, value] of Object.entries(colours)) root.style.setProperty("--md-sys-color-" + key, value);
    } catch (error) {
      console.warn("палитра темы не построена:", error);
    }
    root.style.setProperty("--font-sans", `"${FONTS[current.interfaceFont]}", "Inter", system-ui, sans-serif`);
    root.style.setProperty("--font-mono", `"${MONOSPACE_FONTS[current.monospaceFont]}", "Fira Code", ui-monospace, monospace`);
    root.style.setProperty("--message-size", current.messageSize + "px");
    root.style.setProperty("--message-group-spacing", current.messageGroupSpacing + "px");
    root.classList.toggle("no-blur", !current.blur);
  }

  if (query) {
    const onchange = () => current.mode === "system" && apply();
    if (query.addEventListener) query.addEventListener("change", onchange);
    else if (query.addListener) query.addListener(onchange);
  }

  window.ArachnidTheme = {
    FONTS,
    MONOSPACE_FONTS,
    DEFAULTS,
    get() {
      return Object.assign({}, current);
    },
    /** Изменить и сохранить часть темы. */
    set(patch) {
      current = clean(Object.assign({}, current, patch));
      try {
        localStorage.setItem(KEY, JSON.stringify(current));
      } catch {
        /* хранилище недоступно — тема действует до перезапуска */
      }
      apply();
      return this.get();
    },
    isDark() {
      return isDark(current);
    },
  };

  apply();
})();
