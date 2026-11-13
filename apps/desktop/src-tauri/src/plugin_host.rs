//! Нативная часть плагинов-папок и их данные: модуль WebAssembly,
//! хранилище и сеть.
//!
//! Исходники на Rust (или C, Zig, AssemblyScript…) у пользователя не
//! соберутся — компилятора у него нет, — поэтому плагин приносит уже
//! собранный модуль `native.wasm` (`wasm32-unknown-unknown`). Модуль
//! выполняет интерпретатор wasmi в песочнице: у модуля нет доступа к файлам,
//! процессам и сети, кроме функций клиента ниже, а время работы и память
//! ограничены. Модуль загружается при первом вызове и живёт, пока плагин
//! включён; новый файл модуля подхватывается при следующем вызове.
//!
//! Договор с модулем (подробно — в `docs/extensions.md`):
//!
//! * модуль экспортирует `memory` и `arachnid_alloc(len) -> ptr` — буфер,
//!   куда клиент кладёт входные данные (и ответы своих функций);
//! * код страницы вызывает `plugin.native.call("имя", вход)`: клиент кладёт
//!   вход (JSON) в буфер и вызывает экспорт `имя(ptr, len) -> i32`; буфер
//!   после этого принадлежит модулю. Результат модуль отдаёт функцией
//!   `output(ptr, len)` (JSON); код `0` — успех, другой — ошибка, тогда
//!   `output` — её текст;
//! * функции клиента — модуль `arachnid`: `log`, `output`, `storage_get`,
//!   `storage_set`, `storage_delete`, `fetch`. Буфер с ответом клиента модуль
//!   получает упакованным в i64 (`ptr << 32 | len`), `-1` — нет значения.
//!
//! Хранилище — `plugin-data/<плагин>/storage.json`, общее у кода страницы
//! (`plugin.storage`) и модуля. Сеть (`plugin.fetch` и `fetch` модуля) —
//! только к адресам из `[permissions] network`, подтверждённым при
//! включении плагина.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use url::Url;
use wasmi::errors::LinkerError;
use wasmi::{
    Caller, Config, Engine, Extern, Linker, Memory, Module, Store, StoreLimits,
    StoreLimitsBuilder, TrapCode, TypedFunc,
};

use crate::manifest;

/// Каталог данных плагинов в каталоге клиента.
pub const DATA_DIR: &str = "plugin-data";
/// Хранилище плагина в его каталоге данных.
const STORAGE_FILE: &str = "storage.json";
/// Наибольший размер хранилища одного плагина.
const MAX_STORAGE: usize = 8 * 1024 * 1024;
/// Наибольшая длина ключа хранилища.
const MAX_KEY: usize = 256;

/// Наибольший размер файла модуля.
const MAX_MODULE: u64 = 32 * 1024 * 1024;
/// Наибольшая память модуля.
const MAX_MEMORY: usize = 256 * 1024 * 1024;
/// Наибольший размер входа, ответа и буферов функций клиента.
const MAX_MESSAGE: usize = 16 * 1024 * 1024;
/// «Топливо» на один вызов: примерно столько инструкций модуль успевает
/// выполнить, прежде чем его остановят (несколько секунд работы).
const FUEL: u64 = 5_000_000_000;
/// Модуль функций клиента.
const IMPORTS: &str = "arachnid";
/// Префикс служебных экспортов: их нельзя вызвать со страницы.
const RESERVED: &str = "arachnid_";

/// Наибольший размер ответа сервера на запрос плагина.
#[cfg(windows)]
const MAX_RESPONSE: usize = 32 * 1024 * 1024;
/// Методы запросов плагинов.
const METHODS: &[&str] = &["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
/// Заголовки, которые выставляет сама система.
const SYSTEM_HEADERS: &[&str] = &[
    "host",
    "content-length",
    "connection",
    "transfer-encoding",
    "upgrade",
];

// ─────────────────────────────── хранилище ───────────────────────────────

/// Хранилище плагинов: ключ → значение JSON, файл на плагин.
pub struct Storage {
    dir: PathBuf,
    /// Чтение и запись файла целиком: по одному изменению за раз
    lock: Mutex<()>,
}

impl Storage {
    /// Хранилища в `dir` (`plugin-data`).
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            lock: Mutex::new(()),
        }
    }

    fn file(&self, plugin: &str) -> Result<PathBuf, String> {
        if !manifest::valid_id(plugin) {
            return Err("у плагина нет своего хранилища".into());
        }
        Ok(self.dir.join(plugin).join(STORAGE_FILE))
    }

    fn load(path: &Path) -> BTreeMap<String, Value> {
        let Ok(text) = std::fs::read_to_string(path) else {
            return BTreeMap::new();
        };
        serde_json::from_str(&text).unwrap_or_else(|error| {
            tracing::warn!(%error, path = %path.display(), "хранилище плагина повреждено");
            BTreeMap::new()
        })
    }

    /// Значение ключа; `None` — ключа нет.
    pub fn get(&self, plugin: &str, key: &str) -> Result<Option<Value>, String> {
        check_key(key)?;
        let path = self.file(plugin)?;
        let _guard = self.lock.lock().unwrap_or_else(PoisonError::into_inner);
        Ok(Self::load(&path).remove(key))
    }

    /// Записать значение; `None` — удалить ключ.
    pub fn set(&self, plugin: &str, key: &str, value: Option<Value>) -> Result<(), String> {
        check_key(key)?;
        let path = self.file(plugin)?;
        let _guard = self.lock.lock().unwrap_or_else(PoisonError::into_inner);
        let mut values = Self::load(&path);
        let changed = match value {
            Some(value) => values.insert(key.to_owned(), value.clone()) != Some(value),
            None => values.remove(key).is_some(),
        };
        if !changed {
            return Ok(());
        }
        let text = serde_json::to_string_pretty(&values).map_err(|error| error.to_string())?;
        if text.len() > MAX_STORAGE {
            return Err("хранилище плагина больше 8 МБ".into());
        }
        write_atomically(&path, &text).map_err(|error| {
            tracing::warn!(%error, path = %path.display(), "хранилище плагина не записано");
            error.to_string()
        })
    }
}

fn check_key(key: &str) -> Result<(), String> {
    if key.is_empty() || key.len() > MAX_KEY {
        return Err(format!("ключ хранилища — строка от 1 до {MAX_KEY} байт"));
    }
    Ok(())
}

/// Записать файл через временный: при сбое старый текст остаётся целым.
fn write_atomically(path: &Path, text: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut temp = path.as_os_str().to_owned();
    temp.push(".tmp");
    std::fs::write(&temp, text)?;
    std::fs::rename(&temp, path)
}

// ─────────────────────────────────── сеть ───────────────────────────────────

/// Запрос плагина (`plugin.fetch`, `fetch` модуля).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchRequest {
    /// Метод; по умолчанию GET
    #[serde(default)]
    method: Option<String>,
    /// Адрес https
    url: String,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    /// Тело запроса текстом
    #[serde(default)]
    body: Option<String>,
    /// Как вернуть тело ответа
    #[serde(default)]
    response_type: ResponseType,
}

/// Тело ответа: текстом (UTF-8) или в Base64 (картинки, архивы).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResponseType {
    #[default]
    Text,
    Base64,
}

/// Ответ сервера плагину.
#[derive(Debug, Serialize)]
pub struct FetchResponse {
    status: u32,
    headers: BTreeMap<String, String>,
    body: String,
}

/// Выполнить запрос плагина, если адрес разрешён.
pub fn fetch(request: &FetchRequest, allowed: &[String]) -> Result<FetchResponse, String> {
    let method = request
        .method
        .as_deref()
        .unwrap_or("GET")
        .to_ascii_uppercase();
    if !METHODS.contains(&method.as_str()) {
        return Err(format!("метод {method} не поддерживается"));
    }
    let mut url =
        Url::parse(&request.url).map_err(|error| format!("адрес не разобран: {error}"))?;
    // фрагмент (#…) серверу не отправляется
    url.set_fragment(None);
    if url.scheme() != "https" {
        return Err("плагинам доступны только адреса https".into());
    }
    let host = url.host_str().unwrap_or_default();
    if !manifest::host_allowed(allowed, host) {
        return Err(format!("адреса {host} нет в [permissions] network плагина"));
    }
    let headers = header_block(&request.headers)?;
    let body = request.body.as_deref().unwrap_or_default().as_bytes();
    send(&method, &url, &headers, body, request.response_type)
}

/// Заголовки запроса одной строкой `Имя: значение\r\n…`.
fn header_block(headers: &BTreeMap<String, String>) -> Result<String, String> {
    let mut block = String::new();
    for (name, value) in headers {
        let token = !name.is_empty()
            && name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte));
        if !token {
            return Err(format!("заголовок «{name}»: недопустимое имя"));
        }
        if SYSTEM_HEADERS.contains(&name.to_ascii_lowercase().as_str()) {
            return Err(format!("заголовок {name} выставляет система"));
        }
        if value.contains(['\r', '\n', '\0']) {
            return Err(format!("заголовок {name}: перевод строки в значении"));
        }
        block.push_str(&format!("{name}: {value}\r\n"));
    }
    Ok(block)
}

#[cfg(windows)]
fn send(
    method: &str,
    url: &Url,
    headers: &str,
    body: &[u8],
    response_type: ResponseType,
) -> Result<FetchResponse, String> {
    use crate::http::{Error, StopReason};

    let response = crate::http::request(method, url, headers, body, MAX_RESPONSE).map_err(
        |error| match error {
            Error::Network(code) => format!("сервер недоступен (код Windows {code})"),
            Error::Status(status) => format!("сервер ответил {status}"),
            Error::Url => "адрес не подходит".to_owned(),
            Error::Stopped(StopReason::TooLarge) => "ответ сервера больше 32 МБ".to_owned(),
            Error::Stopped(_) => "запрос прерван".to_owned(),
        },
    )?;
    let body = match response_type {
        ResponseType::Text => String::from_utf8_lossy(&response.body).into_owned(),
        ResponseType::Base64 => base64(&response.body),
    };
    Ok(FetchResponse {
        status: response.status,
        headers: response.headers.into_iter().collect(),
        body,
    })
}

/// Сеть для плагинов — средствами Windows (WinHTTP), как и наборы эмодзи.
#[cfg(not(windows))]
fn send(
    _method: &str,
    _url: &Url,
    _headers: &str,
    _body: &[u8],
    _response_type: ResponseType,
) -> Result<FetchResponse, String> {
    Err("сеть для плагинов есть только в Windows".into())
}

/// Base64 (RFC 4648, с `=`).
#[cfg_attr(not(windows), allow(dead_code))]
fn base64(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let bytes = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let triple = u32::from_be_bytes([0, bytes[0], bytes[1], bytes[2]]);
        for index in 0..4 {
            if index <= chunk.len() {
                let sextet = (triple >> (18 - 6 * index)) & 0x3f;
                out.push(char::from(ALPHABET[sextet as usize]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

// ───────────────────────────────── WebAssembly ─────────────────────────────────

/// Состояние модуля для функций клиента.
struct HostState {
    plugin: String,
    storage: Arc<Storage>,
    /// Разрешённые адреса сети (подтверждённые при включении)
    network: Vec<String>,
    /// Результат вызова (`output`)
    output: Option<Vec<u8>>,
    limits: StoreLimits,
}

/// Загруженный модуль плагина.
struct Loaded {
    store: Store<HostState>,
    instance: wasmi::Instance,
    memory: Memory,
    alloc: TypedFunc<i32, i32>,
}

/// Отметка файла модуля: новый файл загружается заново.
type Stamp = Option<(SystemTime, u64)>;

/// Почему вызов не удался.
enum Failure {
    /// Модуль упал или работал слишком долго: его состояние больше не
    /// годится, при следующем вызове он загрузится заново
    Trap(String),
    /// Неправильный вызов (нет такой функции, слишком большой вход)
    Usage(String),
    /// Модуль сам вернул ошибку
    Plugin(String),
}

/// Загруженные модули по плагинам.
type Modules = HashMap<String, (Stamp, Arc<Mutex<Loaded>>)>;

/// Модули плагинов.
pub struct NativeHost {
    engine: Engine,
    linker: Linker<HostState>,
    storage: Arc<Storage>,
    loaded: Mutex<Modules>,
    /// Топливо на вызов ([`FUEL`]; в тестах меньше)
    fuel: u64,
}

impl NativeHost {
    pub fn new(storage: Arc<Storage>) -> Self {
        let mut config = Config::default();
        config.consume_fuel(true);
        let engine = Engine::new(&config);
        let mut linker = Linker::new(&engine);
        if let Err(error) = define_imports(&mut linker) {
            tracing::error!(%error, "функции клиента для модулей плагинов не объявлены");
        }
        Self {
            engine,
            linker,
            storage,
            loaded: Mutex::new(HashMap::new()),
            fuel: FUEL,
        }
    }

    /// Хранилище плагинов.
    pub fn storage(&self) -> &Storage {
        &self.storage
    }

    /// Выгрузить модуль плагина: плагин выключен или удалён.
    pub fn unload(&self, plugin: &str) {
        let removed = self
            .loaded
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(plugin);
        if removed.is_some() {
            tracing::info!(plugin, "модуль плагина выгружен");
        }
    }

    /// Вызвать функцию модуля `wasm` плагина `plugin`.
    pub fn call(
        &self,
        plugin: &str,
        wasm: &Path,
        network: &[String],
        function: &str,
        input: &Value,
    ) -> Result<Value, String> {
        if function.is_empty() || function.starts_with(RESERVED) {
            return Err(format!("функцию «{function}» нельзя вызвать со страницы"));
        }
        let input = serde_json::to_vec(input).map_err(|error| error.to_string())?;
        if input.len() > MAX_MESSAGE {
            return Err("вход больше 16 МБ".into());
        }
        let loaded = self.loaded(plugin, wasm)?;
        let result = {
            let mut loaded = loaded.lock().unwrap_or_else(PoisonError::into_inner);
            loaded.call(function, &input, network, self.fuel)
        };
        let output = match result {
            Ok(output) => output,
            Err(Failure::Trap(message)) => {
                tracing::warn!(plugin, function, %message, "модуль плагина упал");
                self.unload(plugin);
                return Err(message);
            }
            Err(Failure::Usage(message) | Failure::Plugin(message)) => return Err(message),
        };
        match output {
            Some(bytes) => serde_json::from_slice(&bytes)
                .map_err(|error| format!("модуль вернул не JSON: {error}")),
            None => Ok(Value::Null),
        }
    }

    /// Загруженный модуль; файл изменился — загрузить заново.
    fn loaded(&self, plugin: &str, wasm: &Path) -> Result<Arc<Mutex<Loaded>>, String> {
        let stamp = std::fs::metadata(wasm)
            .ok()
            .and_then(|meta| Some((meta.modified().ok()?, meta.len())));
        {
            let loaded = self.loaded.lock().unwrap_or_else(PoisonError::into_inner);
            if let Some((known, module)) = loaded.get(plugin)
                && *known == stamp
            {
                return Ok(Arc::clone(module));
            }
        }
        // компиляция — без общей блокировки: модули других плагинов ждать не должны
        let module = Arc::new(Mutex::new(self.load(plugin, wasm)?));
        tracing::info!(plugin, "модуль плагина загружен");
        self.loaded
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(plugin.to_owned(), (stamp, Arc::clone(&module)));
        Ok(module)
    }

    fn load(&self, plugin: &str, wasm: &Path) -> Result<Loaded, String> {
        let size = std::fs::metadata(wasm)
            .map_err(|error| format!("модуль не читается: {error}"))?
            .len();
        if size > MAX_MODULE {
            return Err("модуль больше 32 МБ".into());
        }
        let bytes = std::fs::read(wasm).map_err(|error| format!("модуль не читается: {error}"))?;
        let module = Module::new(&self.engine, bytes)
            .map_err(|error| format!("модуль не разобран: {error}"))?;
        let state = HostState {
            plugin: plugin.to_owned(),
            storage: Arc::clone(&self.storage),
            network: Vec::new(),
            output: None,
            limits: StoreLimitsBuilder::new().memory_size(MAX_MEMORY).build(),
        };
        let mut store = Store::new(&self.engine, state);
        store.limiter(|state| &mut state.limits);
        store.set_fuel(self.fuel).map_err(|error| error.to_string())?;
        let instance = self
            .linker
            .instantiate_and_start(&mut store, &module)
            .map_err(|error| format!("модуль не запущен: {}", describe(&error)))?;
        let memory = instance
            .get_memory(&store, "memory")
            .ok_or("модуль не экспортирует memory")?;
        let alloc = instance
            .get_typed_func::<i32, i32>(&store, "arachnid_alloc")
            .map_err(|_| "модуль не экспортирует arachnid_alloc(len: i32) -> i32")?;
        Ok(Loaded {
            store,
            instance,
            memory,
            alloc,
        })
    }
}

impl Loaded {
    fn call(
        &mut self,
        function: &str,
        input: &[u8],
        network: &[String],
        fuel: u64,
    ) -> Result<Option<Vec<u8>>, Failure> {
        let missing = || Failure::Usage(format!("у модуля нет функции {function}"));
        let func = self
            .instance
            .get_typed_func::<(i32, i32), i32>(&self.store, function)
            .map_err(|_| missing())?;
        let state = self.store.data_mut();
        state.network = network.to_vec();
        state.output = None;
        let trap = |error: wasmi::Error| Failure::Trap(describe(&error));
        self.store.set_fuel(fuel).map_err(trap)?;
        let len = i32::try_from(input.len())
            .map_err(|_| Failure::Usage("вход слишком большой".into()))?;
        let ptr = self.alloc.call(&mut self.store, len).map_err(trap)?;
        self.memory
            .write(&mut self.store, offset(ptr), input)
            .map_err(|_| Failure::Trap("arachnid_alloc вернул неверный адрес".into()))?;
        let status = func.call(&mut self.store, (ptr, len)).map_err(trap)?;
        let output = self.store.data_mut().output.take();
        if status == 0 {
            return Ok(output);
        }
        let message = output
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            .filter(|message| !message.is_empty())
            .unwrap_or_else(|| format!("модуль вернул код {status}"));
        Err(Failure::Plugin(message))
    }
}

/// Понятный текст ошибки модуля.
fn describe(error: &wasmi::Error) -> String {
    if error.as_trap_code() == Some(TrapCode::OutOfFuel) {
        return "модуль работал слишком долго и остановлен".into();
    }
    error.to_string()
}

/// Адрес в памяти модуля: указатели wasm32 — беззнаковые 32 бита.
fn offset(ptr: i32) -> usize {
    ptr as u32 as usize
}

/// Упаковать буфер в i64: `ptr << 32 | len`.
fn pack(ptr: i32, len: i32) -> i64 {
    (i64::from(ptr as u32) << 32) | i64::from(len as u32)
}

// ─────────────────────────── функции клиента для модуля ───────────────────────────

fn define_imports(linker: &mut Linker<HostState>) -> Result<(), LinkerError> {
    linker.func_wrap(IMPORTS, "log", host_log)?;
    linker.func_wrap(IMPORTS, "output", host_output)?;
    linker.func_wrap(IMPORTS, "storage_get", host_storage_get)?;
    linker.func_wrap(IMPORTS, "storage_set", host_storage_set)?;
    linker.func_wrap(IMPORTS, "storage_delete", host_storage_delete)?;
    linker.func_wrap(IMPORTS, "fetch", host_fetch)?;
    Ok(())
}

fn memory_of(caller: &Caller<'_, HostState>) -> Result<Memory, wasmi::Error> {
    caller
        .get_export("memory")
        .and_then(Extern::into_memory)
        .ok_or_else(|| wasmi::Error::new("модуль не экспортирует memory"))
}

/// Прочитать буфер модуля.
fn read(caller: &Caller<'_, HostState>, ptr: i32, len: i32) -> Result<Vec<u8>, wasmi::Error> {
    let len = usize::try_from(len).map_err(|_| wasmi::Error::new("отрицательная длина"))?;
    if len > MAX_MESSAGE {
        return Err(wasmi::Error::new("буфер больше 16 МБ"));
    }
    let mut buffer = vec![0; len];
    memory_of(caller)?.read(caller, offset(ptr), &mut buffer)?;
    Ok(buffer)
}

/// Прочитать строку UTF-8 из памяти модуля.
fn read_text(caller: &Caller<'_, HostState>, ptr: i32, len: i32) -> Result<String, wasmi::Error> {
    String::from_utf8(read(caller, ptr, len)?)
        .map_err(|_| wasmi::Error::new("строка модуля — не UTF-8"))
}

/// Отдать модулю буфер: память выделяет его `arachnid_alloc`.
fn give(caller: &mut Caller<'_, HostState>, bytes: &[u8]) -> Result<i64, wasmi::Error> {
    if bytes.len() > MAX_MESSAGE {
        return Err(wasmi::Error::new("ответ клиента больше 16 МБ"));
    }
    let len = i32::try_from(bytes.len()).map_err(|_| wasmi::Error::new("слишком большой ответ"))?;
    let alloc = caller
        .get_export("arachnid_alloc")
        .and_then(Extern::into_func)
        .ok_or_else(|| wasmi::Error::new("модуль не экспортирует arachnid_alloc"))?
        .typed::<i32, i32>(&*caller)?;
    let ptr = alloc.call(&mut *caller, len)?;
    memory_of(caller)?.write(&mut *caller, offset(ptr), bytes)?;
    Ok(pack(ptr, len))
}

/// `log(level, ptr, len)`: 0 — ошибка, 1 — предупреждение, 2 — сведения,
/// остальное — отладка. Строка попадает в журнал клиента.
fn host_log(
    caller: Caller<'_, HostState>,
    level: i32,
    ptr: i32,
    len: i32,
) -> Result<(), wasmi::Error> {
    let text = String::from_utf8_lossy(&read(&caller, ptr, len)?).into_owned();
    let plugin = caller.data().plugin.as_str();
    match level {
        0 => tracing::error!(plugin, "{text}"),
        1 => tracing::warn!(plugin, "{text}"),
        2 => tracing::info!(plugin, "{text}"),
        _ => tracing::debug!(plugin, "{text}"),
    }
    Ok(())
}

/// `output(ptr, len)`: результат вызова (JSON) или текст ошибки.
fn host_output(mut caller: Caller<'_, HostState>, ptr: i32, len: i32) -> Result<(), wasmi::Error> {
    let bytes = read(&caller, ptr, len)?;
    caller.data_mut().output = Some(bytes);
    Ok(())
}

/// `storage_get(key_ptr, key_len) -> i64`: значение (JSON) или `-1`.
fn host_storage_get(
    mut caller: Caller<'_, HostState>,
    key_ptr: i32,
    key_len: i32,
) -> Result<i64, wasmi::Error> {
    let key = read_text(&caller, key_ptr, key_len)?;
    let state = caller.data();
    let value = state.storage.get(&state.plugin, &key).map_err(wasmi::Error::new)?;
    let Some(value) = value else {
        return Ok(-1);
    };
    let bytes = serde_json::to_vec(&value).map_err(|error| wasmi::Error::new(error.to_string()))?;
    give(&mut caller, &bytes)
}

/// `storage_set(key_ptr, key_len, value_ptr, value_len) -> i32`: значение —
/// текст JSON; `0` — записано, `-1` — не JSON или хранилище переполнено.
fn host_storage_set(
    caller: Caller<'_, HostState>,
    key_ptr: i32,
    key_len: i32,
    value_ptr: i32,
    value_len: i32,
) -> Result<i32, wasmi::Error> {
    let key = read_text(&caller, key_ptr, key_len)?;
    let Ok(value) = serde_json::from_slice::<Value>(&read(&caller, value_ptr, value_len)?) else {
        return Ok(-1);
    };
    let state = caller.data();
    Ok(store_result(state.storage.set(&state.plugin, &key, Some(value))))
}

/// `storage_delete(key_ptr, key_len) -> i32`: `0` — удалено (или не было).
fn host_storage_delete(
    caller: Caller<'_, HostState>,
    key_ptr: i32,
    key_len: i32,
) -> Result<i32, wasmi::Error> {
    let key = read_text(&caller, key_ptr, key_len)?;
    let state = caller.data();
    Ok(store_result(state.storage.set(&state.plugin, &key, None)))
}

fn store_result(result: Result<(), String>) -> i32 {
    match result {
        Ok(()) => 0,
        Err(error) => {
            tracing::warn!(%error, "модуль плагина не записал хранилище");
            -1
        }
    }
}

/// `fetch(ptr, len) -> i64`: запрос JSON как у `plugin.fetch`, ответ JSON
/// `{ status, headers, body }` или `{ error }`.
fn host_fetch(mut caller: Caller<'_, HostState>, ptr: i32, len: i32) -> Result<i64, wasmi::Error> {
    let request = read(&caller, ptr, len)?;
    let response = match serde_json::from_slice::<FetchRequest>(&request) {
        Ok(request) => match fetch(&request, &caller.data().network) {
            Ok(response) => serde_json::to_value(response).unwrap_or(Value::Null),
            Err(error) => json!({ "error": error }),
        },
        Err(error) => json!({ "error": format!("запрос не разобран: {error}") }),
    };
    let bytes = serde_json::to_vec(&response).unwrap_or_default();
    give(&mut caller, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        std::env::temp_dir().join(format!("arachnid-native-{name}-{nanos:x}"))
    }

    /// Модуль: `echo` возвращает вход, `count` считает вызовы в хранилище,
    /// `fail` — ошибка, `spin` — бесконечный цикл.
    const MODULE: &str = r#"
(module
  (import "arachnid" "output" (func $output (param i32 i32)))
  (import "arachnid" "log" (func $log (param i32 i32 i32)))
  (import "arachnid" "storage_get" (func $get (param i32 i32) (result i64)))
  (import "arachnid" "storage_set" (func $set (param i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (global $next (mut i32) (i32.const 1024))
  (data (i32.const 0) "count")
  (data (i32.const 16) "boom")
  (data (i32.const 32) "1")
  (data (i32.const 33) "2")
  (func (export "arachnid_alloc") (param $len i32) (result i32)
    (local $ptr i32)
    global.get $next
    local.set $ptr
    global.get $next
    local.get $len
    i32.add
    global.set $next
    local.get $ptr)
  (func (export "echo") (param $ptr i32) (param $len i32) (result i32)
    (call $log (i32.const 2) (local.get $ptr) (local.get $len))
    (call $output (local.get $ptr) (local.get $len))
    i32.const 0)
  (func (export "count") (param i32 i32) (result i32)
    (local $packed i64)
    (local.set $packed (call $get (i32.const 0) (i32.const 5)))
    (if (i64.eq (local.get $packed) (i64.const -1))
      (then
        (drop (call $set (i32.const 0) (i32.const 5) (i32.const 32) (i32.const 1)))
        (call $output (i32.const 32) (i32.const 1)))
      (else
        (drop (call $set (i32.const 0) (i32.const 5) (i32.const 33) (i32.const 1)))
        (call $output (i32.const 33) (i32.const 1))))
    i32.const 0)
  (func (export "fail") (param i32 i32) (result i32)
    (call $output (i32.const 16) (i32.const 4))
    i32.const 1)
  (func (export "spin") (param i32 i32) (result i32)
    (loop $forever (br $forever))
    i32.const 0))
"#;

    fn host_with_module(name: &str) -> (NativeHost, PathBuf, PathBuf) {
        let dir = temp_dir(name);
        std::fs::create_dir_all(&dir).unwrap();
        let wasm = dir.join("native.wasm");
        std::fs::write(&wasm, wat::parse_str(MODULE).unwrap()).unwrap();
        let storage = Arc::new(Storage::new(dir.join(DATA_DIR)));
        let mut host = NativeHost::new(storage);
        // отладочная сборка интерпретатора медленная: бесконечный цикл
        // должен остановиться быстро
        host.fuel = 10_000_000;
        (host, wasm, dir)
    }

    #[test]
    fn module_echoes_and_keeps_storage() {
        let (host, wasm, dir) = host_with_module("echo");
        let input = json!({ "name": "Ava", "n": [1, 2] });
        assert_eq!(host.call("demo", &wasm, &[], "echo", &input).unwrap(), input);

        assert_eq!(host.call("demo", &wasm, &[], "count", &Value::Null).unwrap(), 1);
        assert_eq!(host.call("demo", &wasm, &[], "count", &Value::Null).unwrap(), 2);
        // хранилище общее с кодом страницы
        assert_eq!(host.storage().get("demo", "count").unwrap(), Some(json!(2)));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn module_errors_are_reported() {
        let (host, wasm, dir) = host_with_module("errors");
        assert_eq!(host.call("demo", &wasm, &[], "fail", &Value::Null), Err("boom".into()));
        let missing = host.call("demo", &wasm, &[], "nothing", &Value::Null).unwrap_err();
        assert!(missing.contains("нет функции"), "{missing}");
        let reserved = host.call("demo", &wasm, &[], "arachnid_alloc", &Value::Null);
        assert!(reserved.is_err());

        let spin = host.call("demo", &wasm, &[], "spin", &Value::Null).unwrap_err();
        assert!(spin.contains("слишком долго"), "{spin}");
        // после остановки модуль загружается заново и снова работает
        assert_eq!(host.call("demo", &wasm, &[], "echo", &json!(1)).unwrap(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn storage_is_per_plugin() {
        let dir = temp_dir("storage");
        let storage = Storage::new(dir.clone());
        storage.set("a", "key", Some(json!({ "x": 1 }))).unwrap();
        assert_eq!(storage.get("a", "key").unwrap(), Some(json!({ "x": 1 })));
        assert_eq!(storage.get("b", "key").unwrap(), None);
        storage.set("a", "key", None).unwrap();
        assert_eq!(storage.get("a", "key").unwrap(), None);
        assert!(storage.get("a", "").is_err());
        assert!(storage.get("../evil", "key").is_err());
        assert!(storage.set("a", "big", Some(json!("x".repeat(MAX_STORAGE)))).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn fetch_checks_permissions_first() {
        let request = |url: &str| FetchRequest {
            method: None,
            url: url.to_owned(),
            headers: BTreeMap::new(),
            body: None,
            response_type: ResponseType::Text,
        };
        let allowed = vec!["api.example.com".to_owned()];
        let denied = fetch(&request("https://evil.example.com/"), &allowed).unwrap_err();
        assert!(denied.contains("permissions"), "{denied}");
        let plain = fetch(&request("http://api.example.com/"), &allowed).unwrap_err();
        assert!(plain.contains("https"), "{plain}");

        let mut headers = BTreeMap::new();
        headers.insert("Host".to_owned(), "x".to_owned());
        assert!(header_block(&headers).is_err());
        headers.clear();
        headers.insert("X-Key".to_owned(), "a\r\nb".to_owned());
        assert!(header_block(&headers).is_err());
        headers.clear();
        headers.insert("Authorization".to_owned(), "Bearer t".to_owned());
        assert_eq!(header_block(&headers).unwrap(), "Authorization: Bearer t\r\n");
    }

    #[test]
    fn base64_matches_rfc() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn buffers_are_packed_unsigned() {
        assert_eq!(pack(16, 4), (16 << 32) | 4);
        assert_eq!(pack(-1, 1) as u64 >> 32, u64::from(u32::MAX));
        assert_eq!(offset(-1), u32::MAX as usize);
    }
}
