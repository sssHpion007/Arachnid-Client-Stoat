# stoat-core — ядро клиента

Транспортный и протокольный слой клиента Stoat на Rust. Ничего не знает про UI
и про плагины: поверх него строятся и Tauri-команды, и plugin-host.

```
crates/stoat-core/
├── src/lib.rs        Instance, ApiRoot, ReadyField — конфигурация инстанса
├── src/http.rs       REST-клиент (сессии и боты, Idempotency-Key, разбор ошибок)
├── src/gateway.rs    WebSocket-протокол Bonfire: Authenticate, Ping, Bulk, Ready
├── src/cache.rs      состояние: пользователи, серверы, каналы, сообщения, typing
├── src/ratelimit.rs  бакеты X-RateLimit-*, ожидание вместо ретраев наугад
└── src/error.rs      Error/Result и признаки retryable/auth-failure
```

## Что уже проверено на живом API

Проверки выполнялись против `https://api.stoat.chat` (версия **0.16.3**) и
`wss://events.stoat.chat`:

| Проверка | Результат |
|---|---|
| `GET /` (discovery) | версия `0.16.3`, `ws=wss://events.stoat.chat`, Autumn `https://cdn.stoatusercontent.com`, LiveKit включён |
| REST-транспорт | заголовки и URL собираются верно, ответ парсится |
| Gateway: handshake | `101 Switching Protocols` |
| Gateway: `Authenticate` | пакет уходит в ожидаемом формате |
| Gateway: разбор ошибки | получено `InvalidSession` и корректно распознано |

Примеры для повторной проверки:

```bash
cargo run -p stoat-core --example probe           # REST + discovery
cargo run -p stoat-core --example gateway_probe   # gateway (без токена ждём InvalidSession)
STOAT_TOKEN=... cargo run -p stoat-core --example gateway_probe   # реальные события
```

## Решения, которые стоит знать

**Типы берём из официального крейта.** `revolt-models = 0.16.3` (MIT) — это модели
самого бэкенда Stoat, поэтому поля не приходится переобъявлять и они не разъезжаются
с API. Требуются фичи `serde`, `schemas`, `partials` (без них крейт не собирается).

**Токен не попадает в URL.** Авторизация — событием `Authenticate` после подключения,
а не query-параметром `token`: URL попадает в логи прокси и в историю.

**Формат ошибки gateway отличается от документации.** Документация обещает
`{"type":"Error","error":"InvalidSession"}`, реальный сервер присылает
`{"type":"Error","data":{"type":"InvalidSession","location":"…"}}`.
[`ErrorEvent`] понимает оба варианта, плюс третий — объект в `error`.
Есть тесты на все три формы; формат зафиксирован по реальному ответу 2026-11-10.

**Rate-limit — это ожидание, а не ретрай.** Заголовки `X-RateLimit-Bucket/Limit/
Remaining/Reset-After` складываются в бакеты, и перед запросом клиент ждёт
остаток окна. Имя бакета на первом запросе угадывается по шаблону пути
(`channels/{id}/messages`), дальше берётся из ответа сервера.

**Идемпотентность отправки.** `send_message` принимает `Idempotency-Key` — если
сеть отвалилась после отправки, повтор не создаст дубликат сообщения.

**Провайдер TLS выбирается явно.** `reqwest` собран с `rustls-no-provider`
и провайдером `ring`, который ставится один раз на процесс через `std::sync::Once`.
Так сборка не требует cmake и периферии `aws-lc`.

**Bulk разворачивается.** Пакет `{"type":"Bulk","v":[…]}` превращается в очередь
отдельных событий, а неизвестные типы событий не рвут поток: они приходят как
`GatewayEvent::Unknown`, чтобы новые фичи Stoat не ломали клиент.

**Переподключение с экспоненциальной задержкой.** 1s → 2s → 4s … с потолком
`max_backoff` (60 с); при `InvalidSession` переподключаться бессмысленно, поэтому
такая ошибка не считается retryable.

## Кэш

`Cache::apply(GatewayEvent)` применяет событие и возвращает список изменений;
параллельно они уходят в `broadcast`-канал. Поддерживаются частичные обновления
(`MessageUpdate.data`, `ChannelUpdate.clear`, `ServerMemberUpdate`), сортировка
истории по ULID, состояние «кто печатает».

## Ограничения текущего шага

- Нет голоса (LiveKit) и загрузки файлов в Autumn — это следующий шаг.
- Реакции учитываются только как события: счётчики кэш не пересчитывает.
- `ServerUpdate`/`ChannelUpdate` мержатся по основным полям; для полного набора
  полей нужен `OverwriteField`-aware merge (планируется вместе с UI).
- Живой gateway с настоящим токеном не проверялся (в песочнице нет аккаунта):
  путь ошибки проверен, успешный `Ready` — на стороне пользователя.

[`ErrorEvent`]: ../src/gateway.rs
