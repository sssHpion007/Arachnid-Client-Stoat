//! Картинки эмодзи растром: странице отдаётся PNG, а не SVG.
//!
//! Каждая картинка SVG в Chromium (значит, и в WebView2) — отдельный документ
//! SVG со своим планировщиком задач (`SVGImage` заводит `AgentGroupScheduler`).
//! Документ живёт, пока картинка лежит в кэше памяти, то есть и после того,
//! как её `<img>` ушёл из окна выбора эмодзи. После каждой задачи главного
//! потока Blink обходит все планировщики
//! (`MainThreadSchedulerImpl::PerformMicrotaskCheckpoint`, crbug.com/582923445),
//! поэтому цена любой задачи растёт с числом уже показанных эмодзи. Окно
//! выбора for-web — виртуальный список, в DOM только видимые ~150 картинок,
//! но после прокрутки всего списка кадр стоил 110 мс вместо 28, а в WebView2
//! пустая задача после 1100 эмодзи — 6,5 мс вместо 0,01. У растровой картинки
//! документа нет: клиент рисует эмодзи сам (SVG наборов — resvg, слои
//! системного шрифта — tiny-skia в `system_emoji.rs`) и отдаёт PNG по тому же
//! адресу, а цена задачи остаётся постоянной.
//!
//! Сторона картинки — под самый крупный эмодзи for-web (`--emoji-size-large`,
//! 96 px: сообщение из одного эмодзи) с учётом масштаба экрана; в окне выбора
//! и в тексте картинка уменьшается.
//!
//! Рисование идёт в фоновых потоках (`Workers`), готовые картинки — в памяти
//! (`Cache`): прокрутка туда и обратно не рисует их заново.

// Картинки наборов подменяются только в Windows (emoji_packs.rs)
#![cfg_attr(not(windows), allow(dead_code))]

use std::collections::{BTreeMap, HashMap};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};

use resvg::{tiny_skia, usvg};

/// Самый крупный эмодзи for-web в пикселях CSS (`--emoji-size-large`).
const LARGEST_CSS_PX: f64 = 96.0;

/// Пределы стороны картинки в пикселях экрана.
const MIN_SIDE: u32 = 48;
const MAX_SIDE: u32 = 384;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Сторона картинки в пикселях для масштаба экрана `scale` (1.0 — 96 dpi).
pub fn side(scale: f64) -> u32 {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let pixels = (LARGEST_CSS_PX * scale).ceil();
    // после clamp значение помещается в u32
    pixels.clamp(f64::from(MIN_SIDE), f64::from(MAX_SIDE)) as u32
}

/// Картинка SVG набора — в PNG со стороной `side`.
///
/// Наборы, где SVG — только обёртка вокруг готового PNG (Fluent 3D:
/// `<image href="data:image/png;base64,…">`), отдают этот PNG как есть.
pub fn from_svg(svg: &[u8], side: u32) -> Option<Vec<u8>> {
    let options = usvg::Options {
        // внешние файлы не читаются: картинки наборов самодостаточны
        image_href_resolver: usvg::ImageHrefResolver {
            resolve_data: usvg::ImageHrefResolver::default_data_resolver(),
            resolve_string: Box::new(no_files),
        },
        ..usvg::Options::default()
    };
    let tree = usvg::Tree::from_data(svg, &options).ok()?;
    if let Some(png) = only_png(tree.root()) {
        return Some(png.to_vec());
    }
    let mut pixmap = tiny_skia::Pixmap::new(side, side)?;
    let size = tree.size();
    let target = side as f32;
    let fit = target / size.width().max(size.height());
    let dx = (target - size.width() * fit) / 2.0;
    let dy = (target - size.height() * fit) / 2.0;
    let transform = tiny_skia::Transform::from_row(fit, 0.0, 0.0, fit, dx, dy);
    resvg::render(&tree, transform, &mut pixmap.as_mut());
    pixmap.encode_png().ok()
}

/// Адрес не data: (путь к файлу) — картинки нет.
fn no_files(_href: &str, _options: &usvg::Options<'_>) -> Option<usvg::ImageKind> {
    None
}

/// PNG, если вся картинка — одно растровое изображение PNG.
fn only_png(group: &usvg::Group) -> Option<&[u8]> {
    let [node] = group.children() else {
        return None;
    };
    match node {
        usvg::Node::Group(group) => only_png(group),
        usvg::Node::Image(image) => match image.kind() {
            usvg::ImageKind::PNG(data) => Some(data.as_slice()),
            _ => None,
        },
        _ => None,
    }
}

// ─────────────────────────────── память ───────────────────────────────

/// Готовая картинка и кто её отдал (`Server-Timing`).
#[derive(Clone, Debug)]
pub struct Image {
    pub png: Arc<[u8]>,
    /// builtin, downloaded, system или network
    pub source: &'static str,
}

impl Image {
    pub fn new(png: Vec<u8>, source: &'static str) -> Self {
        Self {
            png: png.into(),
            source,
        }
    }
}

/// Недавние картинки в пределах `budget` байт; первыми уходят те, что
/// дольше всех не спрашивали.
pub struct Cache {
    budget: usize,
    used: usize,
    clock: u64,
    entries: HashMap<String, (Image, u64)>,
    /// Ключи по времени последнего обращения
    order: BTreeMap<u64, String>,
}

impl Cache {
    pub fn new(budget: usize) -> Self {
        Self {
            budget,
            used: 0,
            clock: 0,
            entries: HashMap::new(),
            order: BTreeMap::new(),
        }
    }

    pub fn get(&mut self, key: &str) -> Option<Image> {
        self.clock += 1;
        let clock = self.clock;
        let (image, used) = self.entries.get_mut(key)?;
        self.order.remove(used);
        *used = clock;
        self.order.insert(clock, key.to_owned());
        Some(image.clone())
    }

    pub fn insert(&mut self, key: String, image: Image) {
        if image.png.len() > self.budget {
            return;
        }
        self.remove(&key);
        self.clock += 1;
        self.used += image.png.len();
        self.order.insert(self.clock, key.clone());
        self.entries.insert(key, (image, self.clock));
        while self.used > self.budget {
            let Some((_, oldest)) = self.order.pop_first() else {
                break;
            };
            if let Some((image, _)) = self.entries.remove(&oldest) {
                self.used -= image.png.len();
            }
        }
    }

    fn remove(&mut self, key: &str) {
        if let Some((image, used)) = self.entries.remove(key) {
            self.order.remove(&used);
            self.used -= image.png.len();
        }
    }

    /// Забыть картинки, ключ которых начинается с `prefix`.
    pub fn forget(&mut self, prefix: &str) {
        let keys: Vec<String> = self
            .entries
            .keys()
            .filter(|key| key.starts_with(prefix))
            .cloned()
            .collect();
        for key in keys {
            self.remove(&key);
        }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries.len()
    }
}

// ─────────────────────────────── потоки ───────────────────────────────

type Task = Box<dyn FnOnce() + Send>;

/// Очередь задач и сигнал о новой задаче.
type Queue = (Mutex<Vec<Task>>, Condvar);

/// Потоки, которые рисуют картинки. Последняя задача берётся первой: при
/// быстрой прокрутке сначала рисуется то, что видно сейчас.
pub struct Workers {
    queue: Arc<Queue>,
    threads: usize,
}

impl Workers {
    /// Столько потоков, сколько ядер, кроме одного (для страницы), но не
    /// больше четырёх.
    pub fn new(name: &str) -> Self {
        let cores = std::thread::available_parallelism().map_or(2, usize::from);
        let wanted = cores.saturating_sub(1).clamp(1, 4);
        let queue: Arc<Queue> = Arc::default();
        let mut threads = 0;
        for index in 0..wanted {
            let queue = Arc::clone(&queue);
            let spawned = std::thread::Builder::new()
                .name(format!("{name}-{index}"))
                .spawn(move || work(&queue));
            match spawned {
                Ok(_) => threads += 1,
                Err(error) => tracing::warn!(%error, "поток картинок эмодзи не запущен"),
            }
        }
        Self { queue, threads }
    }

    pub fn run(&self, task: impl FnOnce() + Send + 'static) {
        if self.threads == 0 {
            // потоков нет — медленнее, но ответ будет
            task();
            return;
        }
        let (tasks, ready) = &*self.queue;
        lock(tasks).push(Box::new(task));
        ready.notify_one();
    }
}

fn work(queue: &Queue) {
    let (tasks, ready) = queue;
    loop {
        let task = {
            let mut waiting = lock(tasks);
            loop {
                if let Some(task) = waiting.pop() {
                    break task;
                }
                waiting = ready.wait(waiting).unwrap_or_else(PoisonError::into_inner);
            }
        };
        // ошибка в одной картинке не останавливает поток
        let _ = catch_unwind(AssertUnwindSafe(task));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image(bytes: usize) -> Image {
        Image::new(vec![0; bytes], "builtin")
    }

    #[test]
    fn side_follows_screen_scale() {
        assert_eq!(side(1.0), 96);
        assert_eq!(side(1.25), 120);
        assert_eq!(side(1.5), 144);
        assert_eq!(side(2.0), 192);
        assert_eq!(side(0.1), MIN_SIDE);
        assert_eq!(side(100.0), MAX_SIDE);
        assert_eq!(side(f64::NAN), 96);
    }

    #[test]
    fn cache_forgets_least_recent() {
        let mut cache = Cache::new(30);
        cache.insert("a".into(), image(10));
        cache.insert("b".into(), image(10));
        cache.insert("c".into(), image(10));
        // «a» спрошена — дольше всех не спрашивали «b»
        assert!(cache.get("a").is_some());
        cache.insert("d".into(), image(10));
        assert!(cache.get("b").is_none());
        assert!(cache.get("a").is_some() && cache.get("c").is_some());
        // замена не считается дважды
        cache.insert("d".into(), image(10));
        assert_eq!(cache.len(), 3);
        // больше бюджета — не кладётся
        cache.insert("e".into(), image(31));
        assert!(cache.get("e").is_none());

        cache.forget("a");
        assert!(cache.get("a").is_none());
        assert_eq!(cache.len(), 2);
    }

    #[test]
    fn workers_run_every_task() {
        let workers = Workers::new("test-emoji");
        let (sender, receiver) = std::sync::mpsc::channel();
        for index in 0..20 {
            let sender = sender.clone();
            workers.run(move || {
                assert!(index != 7, "ошибка в задаче");
                let _ = sender.send(index);
            });
        }
        drop(sender);
        let mut done: Vec<i32> = receiver.iter().collect();
        done.sort_unstable();
        let expected: Vec<i32> = (0..20).filter(|index| *index != 7).collect();
        assert_eq!(done, expected);
    }

    /// Base64 для data: адреса в проверке.
    fn base64(data: &[u8]) -> String {
        const ALPHABET: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for chunk in data.chunks(3) {
            let bytes = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
            let n = u32::from_be_bytes([0, bytes[0], bytes[1], bytes[2]]);
            for i in 0..4 {
                if i <= chunk.len() {
                    out.push(char::from(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize]));
                } else {
                    out.push('=');
                }
            }
        }
        out
    }

    #[test]
    fn svg_becomes_png() {
        let svg = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36">
            <circle cx="18" cy="18" r="18" fill="#ffcc4d"/></svg>"##;
        let png = from_svg(svg, 96).unwrap();
        let pixmap = tiny_skia::Pixmap::decode_png(&png).unwrap();
        assert_eq!((pixmap.width(), pixmap.height()), (96, 96));
        let center = pixmap.pixel(48, 48).unwrap();
        assert_eq!((center.red(), center.green(), center.blue()), (0xff, 0xcc, 0x4d));
        assert_eq!(pixmap.pixel(1, 1).unwrap().alpha(), 0);
        assert_eq!(from_svg(b"not svg", 96), None);
    }

    #[test]
    fn wrapped_png_is_served_as_is() {
        let mut inner = tiny_skia::Pixmap::new(4, 4).unwrap();
        inner.fill(tiny_skia::Color::from_rgba8(10, 20, 30, 255));
        let png = inner.encode_png().unwrap();
        let svg = format!(
            "<svg width=\"32\" height=\"32\" viewBox=\"0 0 32 32\" fill=\"none\" \
             xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\">\n\
             <image width=\"32\" height=\"32\" xlink:href=\"data:image/png;base64,{}\"/>\n</svg>",
            base64(&png)
        );
        assert_eq!(from_svg(svg.as_bytes(), 96), Some(png));
    }

    #[test]
    fn external_files_are_not_read() {
        let svg = br#"<svg xmlns="http://www.w3.org/2000/svg"
            xmlns:xlink="http://www.w3.org/1999/xlink" width="32" height="32">
            <image width="32" height="32" xlink:href="C:/Windows/win.ini"/></svg>"#;
        let png = from_svg(svg, 48).unwrap();
        let pixmap = tiny_skia::Pixmap::decode_png(&png).unwrap();
        assert!(pixmap.pixels().iter().all(|pixel| pixel.alpha() == 0));
    }
}
