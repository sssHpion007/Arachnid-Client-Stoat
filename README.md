# Tauri-Stoat

Приватный набор плагинов и заметок по клиенту [Stoat](https://stoat.chat/) (бывший Revolt) на Windows.

## Состав

```
docs/avia-setup-windows.md   — установка Avia Client, темы, гифки, переводчик, риски
plugins/                     — свои плагины (JS, формат Avia Client)
```

## Исходная вводная

- ОС: Windows
- Хочется: темы, меню избранных гифок, переводчик с заменой текста сообщения (как в BetterDiscord/Vencord)
- Rust-клиенты Stoat (Ermine, RuSToat, VimStoat) plugin API не имеют → выбран Avia Client
  (форк официального `for-desktop`, ~Vencord для Stoat)

## План

- [ ] поставить Avia Client и проверить базу (логин, панель Avia, QuickCSS)
- [ ] темы с https://rvlt.gg/discover/themes + собственные правки через QuickCSS
- [ ] избранные гифки: `BetterFavourites` + `KlipyV2` (нужен Klipy API key)
- [ ] переводчик: `Translate` (переключить язык на `ru`), либо свой плагин — см. `docs/`
- [ ] свой плагин перевода через настраиваемый движок (без Google по умолчанию)
- [ ] свой плагин меню избранных гифок с категориями и вставкой в поле ввода
- [ ] опционально: каркас своего клиента/оверлея на Tauri (Rust + web UI)

## Почему Tauri (опциональная ветка)

Avia даёт темы/плагины сегодня и работает как форк Electron-клиента. Если позже захочется
нативный Rust-клиент **с** плагинами — практичный путь не GPUI/Freya с нуля, а Tauri:
Rust-ядро (сеть, кэш, плагины на WASM/`libloading`) + web-UI, куда можно переиспользовать
CSS-темы и часть логики клиента Stoat.

## Формат плагина Avia (кратко)

Плагин — самовызывающийся IIFE с guard-флагом в `window`, метаданными в комментарии
(`@UPDATEURL`, `@VERSION`) и настройками в `localStorage`. UI вставляется через
`MutationObserver` по классам Stoat (`.Toolbar`, `span.material-symbols-outlined` и т.п.).

```js
/*
  @UPDATEURL: <url до raw-файла>
  @VERSION: 1.0
*/
(function () {
    if (window.__MY_PLUGIN__) return;
    window.__MY_PLUGIN__ = true;
    // ...
})();
```

## Заметки по безопасности

Плагины исполняются с доступом к сессии Stoat. Ставить только из проверенных источников,
перед включением читать исходник (кнопка **View source** в Avia).

Секреты (API-ключи, токены) в репозиторий не коммитим — `.gitignore` уже настроен.
