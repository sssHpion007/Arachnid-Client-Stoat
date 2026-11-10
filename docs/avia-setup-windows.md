# Stoat на Windows: темы + избранные гифки + переводчик

Краткий вывод: Rust-клиенты Stoat (Ermine, RuSToat, VimStoat) **не имеют plugin API**, поэтому
темы/плагины с заменой текста сообщений там недоступны без форка UI.
Нужный набор даёт **Avia Client** — форк официального desktop-клиента, аналог Vencord/BetterDiscord.

---

## 1. Установка Avia Client (desktop, Windows)

1. Скачать последний релиз: https://github.com/AvaLilac/for-desktop/releases
   (на момент проверки — `1.8.4`, assets: Windows `.exe` / portable)
2. Запустить, залогиниться в свой аккаунт Stoat (включая self-hosted инстанс, если нужен)
3. В настройках клиента появится раздел **Avia**: плагины, QuickCSS, Themes, Fonts, Local Plugins

Альтернатива без установки приложения: **userscript** в Tampermonkey на `web.stoat.chat`
https://github.com/AvaLilac/Ava-Client/raw/refs/heads/main/userscript/AviaClient.user.js

Сайт/док: https://avalilac.codeberg.page/Avia-Client-Home/
Репозиторий плагинов: https://avalilac.github.io/PluginRepo/ (44 плагина, кнопка View source у каждого)

---

## 2. Темы

- **Панель Themes** внутри Avia (создание/включение своих тем, без QuickCSS)
- **QuickCSS** — живое редактирование CSS, применяется без перезагрузки
- Готовые темы от сообщества: https://rvlt.gg/discover/themes
  (Catppuccin Frappé/Latte/Macchiato/Mocha, Dracula, Gruvbox, AMOLED, Deep Ocean,
   Material Dark, Discord / Discord Colours & Layout, Horizon, Solarized и др.)

Полезные плагины под внешний вид:

| Плагин | Что делает |
|---|---|
| `Horizontal_Server_Bar` | переносит панель серверов в горизонтальную (unreads пока не отображаются) |
| `CustomHomeButton` | своя картинка на кнопке Home |
| `AppleEmojiPack` / `AppleEmoji` | эмодзи в стиле Apple |
| `ShrinkEmojis` | уменьшает эмодзи в сообщениях |
| `NoSmoothScroll` | отключает плавный скролл |
| `HideImageLinks` | скрывает ссылки на картинки, если это всё содержимое сообщения |
| `ChunkyMembers` | список участников / пинов на всю высоту чата |

---

## 3. Избранные гифки (меню «favourites»)

**`BetterFavourites`** (0simp)
- кнопка «добавить в избранное» в просмотрщике изображений
- панель избранного + кнопка обновления, чтобы свежедобавленное сразу появлялось
- клик по гифке/картинке **вставляет ссылку в строку ввода** (а не копирует в буфер) — это и есть
  быстрое меню отправки любимых гифок

**`KlipyV2`** (AvaLilac)
- подменяет встроенный GIF-провайдер Stoat на Klipy, используя нативный пикер
- кнопка favorite на каждой карточке гифки, лимиты загрузки (в коде: `GIF_LOAD_LIMIT`, `TRENDING_LOAD_LIMIT`)
- требует бесплатный API key с https://klipy.com (вводится в модалке плагина, хранится в `localStorage`)

Плюс встроенная **Favourites system** Avia — хранит избранные ссылки YouTube/картинок и выводит их
отдельной панелью.

Порядок: поставить `BetterFavourites`, затем `KlipyV2` (или наоборот — они работают с одним и тем же
ключом `avia_favorites` в localStorage).

---

## 4. Переводчик с заменой текста сообщения

**Плагин `Translate`** (AvaLilac, v1.2) — механика как у переводчиков для BetterDiscord:

- оборачивает `window.fetch`; если это `POST` на `/api/channels/<id>/messages`, парсит body
  и **заменяет `content` на перевод** → на сервер уходит уже переведённый текст
- отдельная кнопка в toolbar сообщения (иконка translate рядом с «kebab»-меню) — инлайн-перевод
  чужого сообщения с подписью «Translated from <язык>»
- панель настроек: выбор целевого языка, поиск по списку, ON/OFF, `Set Default` для toolbar-кнопки
- настройки в localStorage: `avia_translate_lang`, `avia_translate_enabled`, `avia_default_toolbar_lang`

**Что сделать сразу после установки:** открыть панель перевода и переключить язык с `de` на `ru`
(по умолчанию стоит немецкий).

**Ограничения (важно):**
- используется неофициальный эндпоинт `translate.googleapis.com/translate_a/single?client=gtx` —
  может отвалиться или упереться в лимиты
- весь отправляемый текст уходит в Google (приватность)
- перевод применяется к исходящим сообщениям целиком, включая команды/код, если они есть в тексте

---

## 5. Прочие полезные плагины из репозитория

- `CharacterCounter` — счётчик символов до лимита Stoat
- `Timestamps` / `TimezoneV2` — кастомные таймстампы и часовые пояса (per-user)
- `SilentLeaveGCs` — тихий выход из групповых чатов
- `File Syntaxer` — подсветка синтаксиса в прикреплённых файлах
- `CopyFileContents` — копировать содержимое текстовых вложений
- `NotificationPings` — пинг при ЛС/упоминании (со звуком)
- `BAN_LIST` — полный бан-лист сервера в читаемом виде
- `Pretend/NoBlockedMessages`, `BetterImageViewer`, `BetterDownloadButton` — мелкие QoL

---

## 6. Риски и гигиена

- Avia — форк одного разработчика; после обновлений upstream Stoat плагины ломаются
  (в KlipyV2 прямо есть changelog «Fix the plugin after stoat update broke everything»)
- плагины исполняют JS с доступом к сессии/токену. В репозитории есть `Gradient roles`,
  помеченный автором как **TOKEN GRABBER** (ему нужен токен для создания ролей через API) —
  пример того, что код надо читать
- всегда смотреть исходник кнопкой **View** перед включением; не ставить плагины «пачкой»
- не вводить пароль/токен в сторонние модалки плагинов, кроме явно необходимых (Klipy API key)

---

## 7. Если всё-таки хочется на Rust

| Вариант | Что даёт | Цена |
|---|---|---|
| Форк [Ermine](https://github.com/Zomatree/ermine) (Freya/Skia) | свои экраны/фичи прямо в коде | нет CSS-тем; UI-код руками; апстрим мержить больно |
| Свой клиент на [`stoat-rs`](https://crates.io/crates/stoat-rs) (Apache-2.0, есть `voice`) | плагинная архитектура закладывается сразу, полный контроль | писать UI с нуля |
| Бот/автоматизация на `stoat-rs` / `kaho` | команды, бриджи, уведомления | без UI |

Практичный компромисс: интерфейс и плагины — Avia (JS), а «мозги» для сложной автоматизации
(перевод через свой бэкенд с кэшем, зеркалирование, статистика) — отдельный сервис на Rust,
к которому плагин Avia обращается по HTTP.
