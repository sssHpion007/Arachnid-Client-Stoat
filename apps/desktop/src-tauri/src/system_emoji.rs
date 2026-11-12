//! Эмодзи, которые уже есть в Windows: системный шрифт Segoe UI Emoji.
//!
//! В Windows 11 (с обновления 23H2) Segoe UI Emoji — цветной шрифт COLR
//! версии 1 с эмодзи Fluent от Microsoft: каждый эмодзи в нём — те же слои с
//! градиентами, что и в наборе Fluent Color, а для программ, которые не умеют
//! COLRv1, в том же шрифте лежат плоские слои COLRv0 — набор Fluent Flat.
//! Скачивать эти наборы на такой системе незачем: клиент рисует картинку
//! набора из шрифта сам.
//!
//! * Что есть в системе, решает сам шрифт, а не номер версии Windows: таблица
//!   COLR версии 1 (её нет ни в одной Windows 10, там другие рисунки) и у 😀
//!   глиф нужной версии COLR. Набор Fluent 3D — объёмные растровые рисунки,
//!   в шрифте их нет, он по-прежнему скачивается.
//! * Кодовые точки из адреса картинки for-web (`1f469-200d-1f4bb`) — в глиф
//!   шрифта через harfrust: последовательности с ZWJ, оттенками кожи и
//!   keycap — лигатуры GSUB шрифта. Если шрифт рисует последовательность
//!   не одним глифом (флагов в Segoe UI Emoji нет), картинки из шрифта нет и
//!   она берётся там же, где без шрифта.
//! * Слои глифа (read-fonts) — в SVG: контуры — пути, заливки — цвета палитры
//!   и градиенты, режимы наложения — `mix-blend-mode` и маски. Угловой
//!   градиент в SVG есть только как CSS `conic-gradient` (в `foreignObject`).
//!
//! Шрифт отображается в память, а не читается в неё: страницы файла общие с
//! другими программами, которые им пишут, и читаются по мере надобности.

// В Linux и macOS шрифта нет: картинки там идут с сервера (emoji_packs.rs)
#![cfg_attr(not(windows), allow(dead_code))]

use std::collections::HashMap;
use std::fmt::{self, Write};

use harfrust::{Buffer, BufferFlags, Direction, Script, ShapeOptions, ShapePlan, ShaperFont};
use read_fonts::model::Font;
use read_fonts::model::glyph::color::{
    Brush, Color, ColorGlyph, ColorStop, ColorVersion, CompositeMode, Extend, PaintSink,
};
use read_fonts::model::glyph::outline::{DrawMemory, DrawOptions, PathSink};
use read_fonts::types::{BoundingBox, GlyphId, Matrix, Point};

/// Наборы for-web, которые рисует системный шрифт, и версия COLR их слоёв.
const SETS: [(&str, ColorVersion); 2] = [
    ("fluent-color", ColorVersion::V1),
    ("fluent-flat", ColorVersion::V0),
];

/// 😀: по нему видно, есть ли в шрифте слои нужной версии.
const PROBE: char = '\u{1F600}';

/// Селектор эмодзи-варианта.
const VARIATION_SELECTOR: char = '\u{FE0F}';

/// Цвет текста (индекс палитры 0xFFFF): у картинки `<img>` он чёрный.
const FOREGROUND: u16 = 0xFFFF;
const BLACK: Color = Color {
    red: 0,
    green: 0,
    blue: 0,
    alpha: 255,
};

/// Набор for-web может быть в системном шрифте (без чтения шрифта).
pub fn covers(pack: &str) -> bool {
    SETS.iter().any(|(id, _)| *id == pack)
}

/// Системный шрифт эмодзи с наборами, которые в нём есть.
pub struct SystemEmoji {
    font: Font,
    plan: ShapePlan,
    packs: Vec<(&'static str, ColorVersion)>,
}

impl SystemEmoji {
    /// Segoe UI Emoji из папки шрифтов Windows; None — его нет или в нём
    /// нет эмодзи Fluent.
    pub fn load() -> Option<Self> {
        let loaded = platform::load()?;
        let system = Self::new(loaded.font);
        let version = loaded.version;
        match &system {
            Some(system) => {
                let packs: Vec<_> = system.packs().collect();
                tracing::info!(%version, ?packs, "наборы эмодзи в системном шрифте");
            }
            None => tracing::info!(%version, "в системном шрифте нет эмодзи Fluent"),
        }
        system
    }

    fn new(font: Font) -> Option<Self> {
        let packs: Vec<_> = {
            let glyphs = font.color_glyphs();
            if glyphs.version() != Some(ColorVersion::V1) || font.palettes().is_empty() {
                return None;
            }
            let probe = font.charmap().map_unicode(PROBE)?;
            SETS.into_iter()
                .filter(|(_, version)| glyphs.get_with_version(probe, *version).is_some())
                .collect()
        };
        if packs.is_empty() {
            return None;
        }
        let script = Some(Script::COMMON);
        let plan = ShapePlan::new(&font, Direction::LeftToRight, script, None, &[]);
        Some(Self { font, plan, packs })
    }

    /// Наборы for-web, которые есть в шрифте.
    pub fn packs(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.packs.iter().map(|(id, _)| *id)
    }

    pub fn provides(&self, pack: &str) -> bool {
        self.version(pack).is_some()
    }

    fn version(&self, pack: &str) -> Option<ColorVersion> {
        let (_, version) = self.packs.iter().find(|(id, _)| *id == pack)?;
        Some(*version)
    }

    /// SVG эмодзи набора `pack` по кодовым точкам из адреса картинки.
    pub fn svg(&self, pack: &str, stem: &str) -> Option<Vec<u8>> {
        let version = self.version(pack)?;
        let glyph = self.glyph(stem)?;
        let color = self.font.color_glyphs().get_with_version(glyph, version)?;
        let colors = self.font.palettes().get(0)?.colors();
        let outlines = self.font.outline_glyphs();
        let path = |glyph: GlyphId| {
            let outline = outlines.get(glyph)?;
            let mut data = PathData::default();
            outline
                .draw(&DrawOptions::new(), DrawMemory::Scratch, &mut data)
                .ok()?;
            Some(data.0)
        };
        render(&color, colors, &path).map(String::into_bytes)
    }

    /// Глиф эмодзи: последовательность так, как её прислал for-web, или без
    /// селекторов варианта, если с ними шрифт её не знает.
    fn glyph(&self, stem: &str) -> Option<GlyphId> {
        let sequence = codepoints(stem)?;
        if let Some(glyph) = self.shape(&sequence) {
            return Some(glyph);
        }
        let bare: Vec<char> = sequence
            .iter()
            .copied()
            .filter(|c| *c != VARIATION_SELECTOR)
            .collect();
        if bare.len() == sequence.len() || bare.is_empty() {
            return None;
        }
        self.shape(&bare)
    }

    /// Глиф, которым шрифт рисует всю последовательность, или None.
    fn shape(&self, sequence: &[char]) -> Option<GlyphId> {
        let first = *sequence.first()?;
        let shaper = ShaperFont::new(&self.font);
        let mut buffer = Buffer::new();
        for (cluster, c) in (0u32..).zip(sequence) {
            buffer.push(u32::from(*c), cluster);
        }
        buffer.set_direction(Direction::LeftToRight);
        buffer.set_script(Some(Script::COMMON));
        buffer.set_flags(
            BufferFlags::BEGINNING_OF_TEXT
                | BufferFlags::END_OF_TEXT
                | BufferFlags::REMOVE_DEFAULT_IGNORABLES,
        );
        let options = ShapeOptions::new().plan(Some(&self.plan));
        harfrust::shape(&shaper, &mut buffer, options).ok()?;

        let infos = buffer.glyph_infos();
        if infos.len() != 1 {
            return None;
        }
        let glyph = GlyphId::new(infos[0].glyph_id);
        if glyph == GlyphId::NOTDEF {
            return None;
        }
        // невидимые ZWJ и теги (флаги Англии, Шотландии) убираются при
        // разборе: если шрифт не заменил последовательность своим глифом,
        // от неё остаётся первый эмодзи — это другая картинка
        let joined = sequence.iter().any(|c| invisible_joiner(*c));
        if joined && self.font.charmap().map_unicode(first) == Some(glyph) {
            return None;
        }
        Some(glyph)
    }
}

/// ZWJ или тег: без них последовательность — другой эмодзи.
fn invisible_joiner(c: char) -> bool {
    c == '\u{200D}' || ('\u{E0020}'..='\u{E007F}').contains(&c)
}

/// Кодовые точки из имени картинки for-web (`1f3f3-fe0f-200d-1f308`).
fn codepoints(stem: &str) -> Option<Vec<char>> {
    stem.split('-')
        .map(|part| char::from_u32(u32::from_str_radix(part, 16).ok()?))
        .collect()
}

// ─────────────────────────────── SVG ───────────────────────────────

/// Число для SVG: не больше `.1` знаков после запятой, без лишних нулей.
struct Num(f32, usize);

impl fmt::Display for Num {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if !self.0.is_finite() {
            return f.write_str("0");
        }
        let full = format!("{:.*}", self.1, self.0);
        let short = if full.contains('.') {
            full.trim_end_matches('0').trim_end_matches('.')
        } else {
            full.as_str()
        };
        f.write_str(if short == "-0" { "0" } else { short })
    }
}

/// Координата в единицах шрифта (их тысячи на em).
fn n(value: f32) -> Num {
    Num(value, 2)
}

/// Коэффициент матрицы, смещение градиента, прозрачность.
fn k(value: f32) -> Num {
    Num(value, 5)
}

/// Контур глифа как атрибут `d` пути.
#[derive(Default)]
struct PathData(String);

impl PathSink for PathData {
    fn move_to(&mut self, x: f32, y: f32) {
        let _ = write!(self.0, "M{} {}", n(x), n(y));
    }

    fn line_to(&mut self, x: f32, y: f32) {
        let _ = write!(self.0, "L{} {}", n(x), n(y));
    }

    fn quad_to(&mut self, cx0: f32, cy0: f32, x: f32, y: f32) {
        let _ = write!(self.0, "Q{} {} {} {}", n(cx0), n(cy0), n(x), n(y));
    }

    fn curve_to(&mut self, cx0: f32, cy0: f32, cx1: f32, cy1: f32, x: f32, y: f32) {
        let (a, b, c, d, e, f) = (n(cx0), n(cy0), n(cx1), n(cy1), n(x), n(y));
        let _ = write!(self.0, "C{a} {b} {c} {d} {e} {f}");
    }

    fn close(&mut self) {
        self.0.push('Z');
    }
}

/// Цвет без палитры: красный, зелёный, синий и непрозрачность 0…1.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Rgba([f32; 4]);

impl Rgba {
    fn mix(self, other: Rgba, t: f32) -> Rgba {
        let mut out = self.0;
        for (value, target) in out.iter_mut().zip(other.0) {
            *value += (target - *value) * t;
        }
        Rgba(out)
    }

    fn channel(self, index: usize) -> u8 {
        // значения 0…255 после округления
        (self.0[index].clamp(0.0, 1.0) * 255.0).round() as u8
    }

    fn hex(self) -> String {
        let (r, g, b) = (self.channel(0), self.channel(1), self.channel(2));
        format!("#{r:02x}{g:02x}{b:02x}")
    }

    fn alpha(self) -> f32 {
        self.0[3].clamp(0.0, 1.0)
    }

    /// Цвет для CSS (угловой градиент).
    fn css(self) -> String {
        let (r, g, b) = (self.channel(0), self.channel(1), self.channel(2));
        format!("rgb({r} {g} {b} / {})", k(self.alpha()))
    }
}

/// Точка цветовой линии градиента.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Stop {
    offset: f32,
    color: Rgba,
}

/// Цвет цветовой линии в точке `t` (точки по возрастанию).
fn color_at(stops: &[Stop], t: f32) -> Rgba {
    let mut previous = match stops.first() {
        Some(first) if t > first.offset => *first,
        Some(first) => return first.color,
        None => return Rgba([0.0; 4]),
    };
    for stop in stops {
        if t <= stop.offset {
            let span = stop.offset - previous.offset;
            if span <= 0.0 {
                return stop.color;
            }
            return previous.color.mix(stop.color, (t - previous.offset) / span);
        }
        previous = *stop;
    }
    previous.color
}

/// Глиф эмодзи в SVG. `path` — контур глифа шрифта.
fn render(
    glyph: &ColorGlyph<'_>,
    colors: &[Color],
    path: &dyn Fn(GlyphId) -> Option<String>,
) -> Option<String> {
    let extents = glyph.extents().ok()?;
    if extents.width <= 0.0 || extents.height <= 0.0 {
        return None;
    }
    // квадрат вокруг рисунка: эмодзи наборов for-web квадратные
    let side = extents.width.max(extents.height);
    let center_x = extents.x_bearing + extents.width / 2.0;
    let center_y = extents.y_bearing - extents.height / 2.0;
    let view = BoundingBox {
        x_min: center_x - side / 2.0,
        y_min: center_y - side / 2.0,
        x_max: center_x + side / 2.0,
        y_max: center_y + side / 2.0,
    };
    let mut painter = Painter::new(view, colors, path);
    glyph.paint(&mut painter).ok()?;
    painter.finish()
}

/// Слой наложения: содержимое и как оно ложится на то, что под ним.
struct Layer {
    mode: CompositeMode,
    body: String,
    /// В слое есть `mix-blend-mode`: смешивать только внутри него
    isolate: bool,
}

impl Layer {
    fn new(mode: CompositeMode) -> Self {
        Self {
            mode,
            body: String::new(),
            isolate: false,
        }
    }
}

/// Пишет операции рисования глифа COLR в SVG.
///
/// Координаты — единицы шрифта (ось y вверх); весь рисунок отражается по y
/// одной группой. Градиенты, обрезки и маски — в `<defs>` с
/// `userSpaceOnUse`, то есть в координатах ссылающегося на них элемента:
/// тех, что действуют в точке рисования.
struct Painter<'a> {
    /// Рамка картинки (viewBox) в единицах шрифта
    view: BoundingBox<f32>,
    colors: &'a [Color],
    path: &'a dyn Fn(GlyphId) -> Option<String>,
    defs: String,
    layers: Vec<Layer>,
    /// Текущая матрица для каждой открытой группы преобразования
    transforms: Vec<Matrix<f32>>,
    /// Обрезка по контуру глифа: номер `<clipPath>`
    clips: HashMap<GlyphId, usize>,
    /// Фильтр, делающий содержимое чёрным (для инвертированных масок)
    black: bool,
    ids: usize,
}

impl<'a> Painter<'a> {
    fn new(
        view: BoundingBox<f32>,
        colors: &'a [Color],
        path: &'a dyn Fn(GlyphId) -> Option<String>,
    ) -> Self {
        Self {
            view,
            colors,
            path,
            defs: String::new(),
            layers: vec![Layer::new(CompositeMode::SrcOver)],
            transforms: vec![Matrix::IDENTITY],
            clips: HashMap::new(),
            black: false,
            ids: 0,
        }
    }

    fn finish(mut self) -> Option<String> {
        if self.layers.len() != 1 || self.transforms.len() != 1 {
            return None;
        }
        let body = self.layers.pop()?.body;
        let view = self.view;
        let width = view.x_max - view.x_min;
        Some(format!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"32\" height=\"32\" \
             viewBox=\"{} {} {} {}\"><defs>{}</defs><g transform=\"scale(1 -1)\">{body}</g></svg>",
            n(view.x_min),
            n(-view.y_max),
            n(width),
            n(width),
            self.defs
        ))
    }

    fn id(&mut self) -> usize {
        self.ids += 1;
        self.ids
    }

    fn top(&mut self) -> &mut Layer {
        if self.layers.is_empty() {
            self.layers.push(Layer::new(CompositeMode::SrcOver));
        }
        let last = self.layers.len() - 1;
        &mut self.layers[last]
    }

    fn body(&mut self) -> &mut String {
        &mut self.top().body
    }

    fn current(&self) -> Matrix<f32> {
        self.transforms.last().copied().unwrap_or(Matrix::IDENTITY)
    }

    /// Рамка картинки в текущих координатах: столько закрашивает заливка
    /// без обрезки. None — текущая матрица вырождена, видно не будет ничего.
    fn cover(&self) -> Option<BoundingBox<f32>> {
        let inverse = invert(self.current())?;
        let view = self.view;
        let corners = [
            (view.x_min, view.y_min),
            (view.x_max, view.y_min),
            (view.x_min, view.y_max),
            (view.x_max, view.y_max),
        ];
        let mut cover = BoundingBox {
            x_min: f32::INFINITY,
            y_min: f32::INFINITY,
            x_max: f32::NEG_INFINITY,
            y_max: f32::NEG_INFINITY,
        };
        for (x, y) in corners {
            let (x, y) = inverse.transform(x, y);
            cover.x_min = cover.x_min.min(x);
            cover.y_min = cover.y_min.min(y);
            cover.x_max = cover.x_max.max(x);
            cover.y_max = cover.y_max.max(y);
        }
        Some(cover)
    }

    fn color(&self, index: u16, alpha: f32) -> Rgba {
        let color = match self.colors.get(usize::from(index)) {
            Some(color) if index != FOREGROUND => *color,
            _ => BLACK,
        };
        let channel = |value: u8| f32::from(value) / 255.0;
        Rgba([
            channel(color.red),
            channel(color.green),
            channel(color.blue),
            channel(color.alpha) * alpha,
        ])
    }

    fn stops(&self, stops: &[ColorStop]) -> Vec<Stop> {
        stops
            .iter()
            .map(|stop| Stop {
                offset: stop.offset,
                color: self.color(stop.palette_index, stop.alpha),
            })
            .collect()
    }

    /// Атрибуты заливки кистью (`fill=…`); None — угловой градиент, его
    /// рисует `sweep`.
    fn paint(&mut self, brush: &Brush<'_>, transform: Option<Matrix<f32>>) -> Option<String> {
        match brush {
            Brush::Solid {
                palette_index,
                alpha,
            } => Some(solid(self.color(*palette_index, *alpha))),
            Brush::LinearGradient {
                p0,
                p1,
                color_stops,
                extend,
            } => {
                let stops = self.stops(color_stops);
                let id = self.id();
                let _ = write!(
                    self.defs,
                    "<linearGradient id=\"g{id}\" gradientUnits=\"userSpaceOnUse\" \
                     x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\"{}{}>",
                    n(p0.x),
                    n(p0.y),
                    n(p1.x),
                    n(p1.y),
                    spread(*extend),
                    gradient_transform(transform)
                );
                write_stops(&mut self.defs, &stops);
                self.defs.push_str("</linearGradient>");
                Some(format!("fill=\"url(#g{id})\""))
            }
            Brush::RadialGradient {
                c0,
                r0,
                c1,
                r1,
                color_stops,
                extend,
            } => {
                let radial = Radial {
                    c0: *c0,
                    r0: *r0,
                    c1: *c1,
                    r1: *r1,
                    stops: self.stops(color_stops),
                };
                let Some(radial) = radial.truncated() else {
                    return Some("fill=\"none\"".into());
                };
                let id = self.id();
                let _ = write!(
                    self.defs,
                    "<radialGradient id=\"g{id}\" gradientUnits=\"userSpaceOnUse\" \
                     cx=\"{}\" cy=\"{}\" r=\"{}\" fx=\"{}\" fy=\"{}\" fr=\"{}\"{}{}>",
                    n(radial.c1.x),
                    n(radial.c1.y),
                    n(radial.r1),
                    n(radial.c0.x),
                    n(radial.c0.y),
                    n(radial.r0),
                    spread(*extend),
                    gradient_transform(transform)
                );
                write_stops(&mut self.defs, &radial.stops);
                self.defs.push_str("</radialGradient>");
                Some(format!("fill=\"url(#g{id})\""))
            }
            Brush::SweepGradient { .. } => None,
        }
    }

    /// Угловой градиент на всю рамку: CSS `conic-gradient` в `foreignObject`.
    ///
    /// Углы кисти — по часовой стрелке от оси x при оси y вниз, то есть
    /// точка под углом a — (cos a, −sin a) в единицах шрифта. В CSS угол
    /// отсчитывается по часовой от «верха» блока, а «верх» блока здесь —
    /// направление −y единиц шрифта: угол a кисти — угол CSS 90° − a. Он
    /// убывает с ростом a, поэтому точки идут в обратном порядке, а отсчёт
    /// начинается с 90° (−270°), чтобы весь круг 0…360° кисти лёг в 0…360° CSS.
    fn sweep(&mut self, center: Point<f32>, start: f32, end: f32, stops: &[Stop], extend: Extend) {
        let Some(cover) = self.cover() else {
            return;
        };
        let span = end - start;
        let mut line: Vec<(f32, Rgba)> = stops
            .iter()
            .map(|stop| (start + stop.offset * span, stop.color))
            .collect();
        if extend == Extend::Reflect {
            // отражённый период за прямым, повтор — через два периода
            let back: Vec<_> = stops
                .iter()
                .rev()
                .map(|stop| (start + (2.0 - stop.offset) * span, stop.color))
                .collect();
            line.extend(back);
        }
        let function = match extend {
            Extend::Repeat | Extend::Reflect => "repeating-conic-gradient",
            _ => "conic-gradient",
        };
        let colors: Vec<String> = line
            .iter()
            .rev()
            .map(|(angle, color)| format!("{} {}deg", color.css(), k(360.0 - angle)))
            .collect();
        let (x, y) = (cover.x_min, cover.y_min);
        let (width, height) = (cover.x_max - cover.x_min, cover.y_max - cover.y_min);
        let (at_x, at_y) = (n(center.x - x), n(center.y - y));
        let colors = colors.join(",");
        let _ = write!(
            self.body(),
            "<foreignObject x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\">\
             <div xmlns=\"http://www.w3.org/1999/xhtml\" style=\"width:100%;height:100%;\
             background:{function}(from 90deg at {at_x}px {at_y}px,{colors})\"/></foreignObject>",
            n(x),
            n(y),
            n(width),
            n(height)
        );
    }

    /// `content`, видимое по непрозрачности `mask` (или там, где `mask`
    /// прозрачна, если `invert`).
    fn masked(&mut self, content: &str, mask: &str, invert: bool) -> String {
        let Some(cover) = self.cover() else {
            return String::new();
        };
        let id = self.id();
        let region = format!(
            "maskUnits=\"userSpaceOnUse\" x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\"",
            n(cover.x_min),
            n(cover.y_min),
            n(cover.x_max - cover.x_min),
            n(cover.y_max - cover.y_min)
        );
        if invert {
            if !self.black {
                self.black = true;
                self.defs.push_str(
                    "<filter id=\"black\" color-interpolation-filters=\"sRGB\">\
                     <feColorMatrix values=\"0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0\"/></filter>",
                );
            }
            // яркость: белое везде, кроме непрозрачного в `mask`
            let _ = write!(
                self.defs,
                "<mask id=\"m{id}\" {region}><rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" \
                 fill=\"#fff\"/><g filter=\"url(#black)\">{mask}</g></mask>",
                n(cover.x_min),
                n(cover.y_min),
                n(cover.x_max - cover.x_min),
                n(cover.y_max - cover.y_min)
            );
        } else {
            let _ = write!(
                self.defs,
                "<mask id=\"m{id}\" {region} style=\"mask-type:alpha\">{mask}</mask>"
            );
        }
        format!("<g mask=\"url(#m{id})\">{content}</g>")
    }

    /// Наложение слоя `source` на `backdrop` (всё, что под ним в слое ниже).
    /// Второе значение — понадобилось смешивание.
    fn composite(
        &mut self,
        backdrop: String,
        source: String,
        mode: CompositeMode,
    ) -> (String, bool) {
        if let Some(name) = blend_mode(mode) {
            let blended = format!("{backdrop}<g style=\"mix-blend-mode:{name}\">{source}</g>");
            return (blended, true);
        }
        match mode {
            CompositeMode::Clear => (String::new(), false),
            CompositeMode::Src => (source, false),
            CompositeMode::Dest => (backdrop, false),
            CompositeMode::DestOver => (source + &backdrop, false),
            CompositeMode::SrcIn => (self.masked(&source, &backdrop, false), false),
            CompositeMode::DestIn => (self.masked(&backdrop, &source, false), false),
            CompositeMode::SrcOut => (self.masked(&source, &backdrop, true), false),
            CompositeMode::DestOut => (self.masked(&backdrop, &source, true), false),
            CompositeMode::SrcAtop => {
                let inside = self.masked(&source, &backdrop, false);
                (backdrop + &inside, false)
            }
            CompositeMode::DestAtop => {
                let inside = self.masked(&backdrop, &source, false);
                (source + &inside, false)
            }
            CompositeMode::Xor => {
                let first = self.masked(&source, &backdrop, true);
                let second = self.masked(&backdrop, &source, true);
                let added = format!("<g style=\"mix-blend-mode:plus-lighter\">{second}</g>");
                (first + &added, true)
            }
            // SrcOver и неизвестные режимы
            _ => (backdrop + &source, false),
        }
    }
}

impl PaintSink for Painter<'_> {
    fn push_transform(&mut self, transform: Matrix<f32>) {
        let next = self.current() * transform;
        self.transforms.push(next);
        let t = transform;
        let (a, b, c, d) = (k(t.xx), k(t.yx), k(t.xy), k(t.yy));
        let (e, f) = (n(t.dx), n(t.dy));
        let _ = write!(self.body(), "<g transform=\"matrix({a} {b} {c} {d} {e} {f})\">");
    }

    fn pop_transform(&mut self) {
        if self.transforms.len() > 1 {
            self.transforms.pop();
        }
        self.body().push_str("</g>");
    }

    fn push_clip_glyph(&mut self, glyph: GlyphId) {
        let id = match self.clips.get(&glyph) {
            Some(id) => *id,
            None => {
                let id = self.id();
                // глиф без контура обрезает всё
                let d = (self.path)(glyph).unwrap_or_default();
                let _ = write!(self.defs, "<clipPath id=\"c{id}\"><path d=\"{d}\"/></clipPath>");
                self.clips.insert(glyph, id);
                id
            }
        };
        let _ = write!(self.body(), "<g clip-path=\"url(#c{id})\">");
    }

    fn push_clip_box(&mut self, clip_box: BoundingBox<f32>) {
        let id = self.id();
        let _ = write!(
            self.defs,
            "<clipPath id=\"c{id}\"><rect x=\"{}\" y=\"{}\" width=\"{}\" \
             height=\"{}\"/></clipPath>",
            n(clip_box.x_min),
            n(clip_box.y_min),
            n(clip_box.x_max - clip_box.x_min),
            n(clip_box.y_max - clip_box.y_min)
        );
        let _ = write!(self.body(), "<g clip-path=\"url(#c{id})\">");
    }

    fn pop_clip(&mut self) {
        self.body().push_str("</g>");
    }

    fn fill(&mut self, brush: Brush<'_>) {
        if let Brush::SweepGradient {
            c0,
            start_angle,
            end_angle,
            color_stops,
            extend,
        } = &brush
        {
            let stops = self.stops(color_stops);
            self.sweep(*c0, *start_angle, *end_angle, &stops, *extend);
            return;
        }
        let Some(cover) = self.cover() else {
            return;
        };
        let Some(paint) = self.paint(&brush, None) else {
            return;
        };
        let _ = write!(
            self.body(),
            "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" {paint}/>",
            n(cover.x_min),
            n(cover.y_min),
            n(cover.x_max - cover.x_min),
            n(cover.y_max - cover.y_min)
        );
    }

    fn fill_glyph(
        &mut self,
        glyph: GlyphId,
        brush_transform: Option<Matrix<f32>>,
        brush: Brush<'_>,
    ) {
        if matches!(brush, Brush::SweepGradient { .. }) {
            // угловой градиент — не атрибут fill: обрезка и заливка рамки
            self.push_clip_glyph(glyph);
            if let Some(transform) = brush_transform {
                self.push_transform(transform);
                self.fill(brush);
                self.pop_transform();
            } else {
                self.fill(brush);
            }
            self.pop_clip();
            return;
        }
        let Some(d) = (self.path)(glyph) else {
            return;
        };
        let Some(paint) = self.paint(&brush, brush_transform) else {
            return;
        };
        let _ = write!(self.body(), "<path d=\"{d}\" {paint}/>");
    }

    fn push_layer(&mut self, composite_mode: CompositeMode) {
        self.layers.push(Layer::new(composite_mode));
    }

    fn pop_layer_with_mode(&mut self, _composite_mode: CompositeMode) {
        if self.layers.len() < 2 {
            return;
        }
        let Some(layer) = self.layers.pop() else {
            return;
        };
        let source = if layer.isolate {
            format!("<g style=\"isolation:isolate\">{}</g>", layer.body)
        } else {
            layer.body
        };
        let backdrop = std::mem::take(&mut self.top().body);
        let (body, blended) = self.composite(backdrop, source, layer.mode);
        let top = self.top();
        top.body = body;
        top.isolate |= blended;
    }
}

/// Режим наложения, который в CSS — `mix-blend-mode`.
fn blend_mode(mode: CompositeMode) -> Option<&'static str> {
    Some(match mode {
        CompositeMode::Plus => "plus-lighter",
        CompositeMode::Screen => "screen",
        CompositeMode::Overlay => "overlay",
        CompositeMode::Darken => "darken",
        CompositeMode::Lighten => "lighten",
        CompositeMode::ColorDodge => "color-dodge",
        CompositeMode::ColorBurn => "color-burn",
        CompositeMode::HardLight => "hard-light",
        CompositeMode::SoftLight => "soft-light",
        CompositeMode::Difference => "difference",
        CompositeMode::Exclusion => "exclusion",
        CompositeMode::Multiply => "multiply",
        CompositeMode::HslHue => "hue",
        CompositeMode::HslSaturation => "saturation",
        CompositeMode::HslColor => "color",
        CompositeMode::HslLuminosity => "luminosity",
        _ => return None,
    })
}

/// Заливка одним цветом.
fn solid(color: Rgba) -> String {
    let alpha = color.alpha();
    if alpha >= 1.0 {
        format!("fill=\"{}\"", color.hex())
    } else {
        format!("fill=\"{}\" fill-opacity=\"{}\"", color.hex(), k(alpha))
    }
}

fn spread(extend: Extend) -> &'static str {
    match extend {
        Extend::Repeat => " spreadMethod=\"repeat\"",
        Extend::Reflect => " spreadMethod=\"reflect\"",
        _ => "",
    }
}

fn gradient_transform(transform: Option<Matrix<f32>>) -> String {
    match transform {
        Some(t) => format!(
            " gradientTransform=\"matrix({} {} {} {} {} {})\"",
            k(t.xx),
            k(t.yx),
            k(t.xy),
            k(t.yy),
            n(t.dx),
            n(t.dy)
        ),
        None => String::new(),
    }
}

fn write_stops(out: &mut String, stops: &[Stop]) {
    for stop in stops {
        let alpha = stop.color.alpha();
        let _ = write!(
            out,
            "<stop offset=\"{}\" stop-color=\"{}\"",
            k(stop.offset),
            stop.color.hex()
        );
        if alpha < 1.0 {
            let _ = write!(out, " stop-opacity=\"{}\"", k(alpha));
        }
        out.push_str("/>");
    }
}

/// Радиальный градиент: от круга (c0, r0) к кругу (c1, r1).
struct Radial {
    c0: Point<f32>,
    r0: f32,
    c1: Point<f32>,
    r1: f32,
    stops: Vec<Stop>,
}

impl Radial {
    /// Без отрицательных радиусов: после приведения точек к 0…1 радиус может
    /// уйти ниже нуля, и цветовая линия обрывается там, где он равен нулю.
    /// None — не видно ничего.
    fn truncated(self) -> Option<Self> {
        if self.r0 >= 0.0 && self.r1 >= 0.0 {
            return Some(self);
        }
        if self.r0 < 0.0 && self.r1 < 0.0 {
            return None;
        }
        // радиус равен нулю в точке t цветовой линии
        let t = self.r0 / (self.r0 - self.r1);
        let center = Point {
            x: self.c0.x + (self.c1.x - self.c0.x) * t,
            y: self.c0.y + (self.c1.y - self.c0.y) * t,
        };
        let edge = color_at(&self.stops, t);
        if self.r0 < 0.0 {
            // линия начинается в t
            let mut stops = vec![Stop {
                offset: 0.0,
                color: edge,
            }];
            for stop in self.stops.iter().filter(|stop| stop.offset > t) {
                let offset = (stop.offset - t) / (1.0 - t);
                stops.push(Stop { offset, ..*stop });
            }
            Some(Self {
                c0: center,
                r0: 0.0,
                stops,
                ..self
            })
        } else {
            // линия кончается в t
            let mut stops = Vec::new();
            for stop in self.stops.iter().filter(|stop| stop.offset < t) {
                let offset = stop.offset / t;
                stops.push(Stop { offset, ..*stop });
            }
            stops.push(Stop {
                offset: 1.0,
                color: edge,
            });
            Some(Self {
                c1: center,
                r1: 0.0,
                stops,
                ..self
            })
        }
    }
}

/// Обратная матрица; None — вырожденная.
fn invert(m: Matrix<f32>) -> Option<Matrix<f32>> {
    let det = m.xx * m.yy - m.xy * m.yx;
    if !det.is_normal() {
        return None;
    }
    Some(Matrix {
        xx: m.yy / det,
        yx: -m.yx / det,
        xy: -m.xy / det,
        yy: m.xx / det,
        dx: (m.xy * m.dy - m.yy * m.dx) / det,
        dy: (m.yx * m.dx - m.xx * m.dy) / det,
    })
}

// ─────────────────────────────── шрифт ───────────────────────────────

/// Прочитанный системный шрифт.
struct Loaded {
    font: Font,
    /// Версия из таблицы name — для журнала
    version: String,
}

#[cfg(windows)]
mod platform {
    use std::fs::File;
    use std::io;
    use std::os::windows::io::AsRawHandle;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;

    use read_fonts::model::{Blob, Font};
    use read_fonts::types::NameId;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::Memory::{
        CreateFileMappingW, FILE_MAP_READ, MEMORY_MAPPED_VIEW_ADDRESS, MapViewOfFile,
        PAGE_READONLY, UnmapViewOfFile,
    };
    use windows_core::PCWSTR;

    use super::Loaded;

    /// Segoe UI Emoji в папке шрифтов Windows.
    fn font_path() -> PathBuf {
        let root = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        root.join("Fonts").join("seguiemj.ttf")
    }

    pub(super) fn load() -> Option<Loaded> {
        let path = font_path();
        let mapped = match Mapped::open(&path) {
            Ok(mapped) => mapped,
            Err(error) => {
                tracing::info!(%error, path = %path.display(), "системного шрифта эмодзи нет");
                return None;
            }
        };
        let data: Arc<dyn AsRef<[u8]> + Send + Sync> = Arc::new(mapped);
        let Some(font) = Font::new(Blob::from(data), 0) else {
            tracing::warn!(path = %path.display(), "системный шрифт эмодзи не читается");
            return None;
        };
        let version = font
            .names()
            .get(NameId::VERSION_STRING)
            .and_then(|name| name.english_or_first())
            .map(|text| text.name().to_string())
            .unwrap_or_default();
        Some(Loaded { font, version })
    }

    /// Файл, отображённый в память только для чтения.
    struct Mapped {
        view: MEMORY_MAPPED_VIEW_ADDRESS,
        len: usize,
    }

    // SAFETY: представление только для чтения и не меняет адрес до Drop
    unsafe impl Send for Mapped {}
    unsafe impl Sync for Mapped {}

    impl Mapped {
        fn open(path: &Path) -> io::Result<Self> {
            let file = File::open(path)?;
            let len = usize::try_from(file.metadata()?.len())
                .map_err(|_| io::Error::from(io::ErrorKind::InvalidData))?;
            if len == 0 {
                return Err(io::ErrorKind::InvalidData.into());
            }
            let handle = HANDLE(file.as_raw_handle());
            // SAFETY: дескриптор файла действителен, пока жив `file`;
            // представление держит отображение и файл и после закрытия
            // дескрипторов
            unsafe {
                let name = PCWSTR::null();
                let mapping = CreateFileMappingW(handle, None, PAGE_READONLY, 0, 0, name)
                    .map_err(|_| io::Error::last_os_error())?;
                let view = MapViewOfFile(mapping, FILE_MAP_READ, 0, 0, 0);
                let error = io::Error::last_os_error();
                let _ = CloseHandle(mapping);
                if view.Value.is_null() {
                    return Err(error);
                }
                Ok(Self { view, len })
            }
        }
    }

    impl AsRef<[u8]> for Mapped {
        fn as_ref(&self) -> &[u8] {
            // SAFETY: представление длиной в файл живёт до Drop
            unsafe { std::slice::from_raw_parts(self.view.Value.cast::<u8>(), self.len) }
        }
    }

    impl Drop for Mapped {
        fn drop(&mut self) {
            // SAFETY: представление создано в open и больше не используется
            let _ = unsafe { UnmapViewOfFile(self.view) };
        }
    }
}

/// Системного шрифта эмодзи Fluent вне Windows нет.
#[cfg(not(windows))]
mod platform {
    pub(super) fn load() -> Option<super::Loaded> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RED: Color = Color {
        red: 255,
        green: 0,
        blue: 0,
        alpha: 255,
    };

    /// Контур глифа в проверках: треугольник шириной в номер глифа.
    fn triangle(glyph: GlyphId) -> Option<String> {
        Some(format!("M0 0L{} 0L0 10Z", glyph.to_u32()))
    }

    /// SVG того, что нарисовано в рамке 0…100 с палитрой из красного.
    fn painted(paint: impl FnOnce(&mut Painter<'_>)) -> String {
        let view = BoundingBox {
            x_min: 0.0,
            y_min: 0.0,
            x_max: 100.0,
            y_max: 100.0,
        };
        let colors = [RED];
        let mut painter = Painter::new(view, &colors, &triangle);
        paint(&mut painter);
        painter.finish().unwrap()
    }

    fn solid_brush(palette_index: u16, alpha: f32) -> Brush<'static> {
        Brush::Solid {
            palette_index,
            alpha,
        }
    }

    fn balanced(svg: &str) -> bool {
        svg.matches("<g").count() == svg.matches("</g>").count()
    }

    #[test]
    fn numbers_are_short() {
        assert_eq!(n(1.0).to_string(), "1");
        assert_eq!(n(-0.001).to_string(), "0");
        assert_eq!(n(12.345).to_string(), "12.35");
        assert_eq!(k(0.012_345_67).to_string(), "0.01235");
        assert_eq!(n(f32::NAN).to_string(), "0");
    }

    #[test]
    fn stems_become_codepoints() {
        assert_eq!(codepoints("1f600"), Some(vec!['😀']));
        let keycap = vec!['#', '\u{fe0f}', '\u{20e3}'];
        assert_eq!(codepoints("23-fe0f-20e3"), Some(keycap));
        assert_eq!(codepoints("d800"), None);
        assert_eq!(codepoints("x"), None);
        assert!(covers("fluent-color") && covers("fluent-flat"));
        assert!(!covers("fluent-3d") && !covers("twemoji"));
    }

    #[test]
    fn layers_become_svg() {
        let scale = Matrix {
            xx: 2.0,
            yx: 0.0,
            xy: 0.0,
            yy: 2.0,
            dx: 10.0,
            dy: 0.0,
        };
        let svg = painted(|painter| {
            painter.fill_glyph(GlyphId::new(7), None, solid_brush(0, 0.5));
            painter.push_transform(scale);
            painter.push_clip_glyph(GlyphId::new(3));
            painter.fill(solid_brush(FOREGROUND, 1.0));
            painter.pop_clip();
            painter.pop_transform();
        });
        assert!(svg.starts_with("<svg xmlns=\"http://www.w3.org/2000/svg\""));
        assert!(svg.contains("viewBox=\"0 -100 100 100\""));
        let half_red = "fill=\"#ff0000\" fill-opacity=\"0.5\"";
        assert!(svg.contains(&format!("<path d=\"M0 0L7 0L0 10Z\" {half_red}/>")));
        assert!(svg.contains("<clipPath id=\"c1\"><path d=\"M0 0L3 0L0 10Z\"/></clipPath>"));
        assert!(svg.contains("<g transform=\"matrix(2 0 0 2 10 0)\"><g clip-path=\"url(#c1)\">"));
        // заливка без обрезки — рамка картинки в координатах группы
        let cover = "<rect x=\"-5\" y=\"0\" width=\"50\" height=\"50\"";
        assert!(svg.contains(&format!("{cover} fill=\"#000000\"/>")), "{svg}");
        assert!(balanced(&svg));
    }

    #[test]
    fn gradients_and_blending() {
        let stops = [
            ColorStop {
                offset: 0.0,
                palette_index: 0,
                alpha: 1.0,
            },
            ColorStop {
                offset: 1.0,
                palette_index: FOREGROUND,
                alpha: 0.25,
            },
        ];
        let linear = Brush::LinearGradient {
            p0: Point { x: 0.0, y: 0.0 },
            p1: Point { x: 100.0, y: 0.0 },
            color_stops: &stops,
            extend: Extend::Reflect,
        };
        let sweep = Brush::SweepGradient {
            c0: Point { x: 50.0, y: 50.0 },
            start_angle: 0.0,
            end_angle: 360.0,
            color_stops: &stops,
            extend: Extend::Pad,
        };
        let svg = painted(|painter| {
            painter.push_layer(CompositeMode::SrcOver);
            painter.fill(linear);
            painter.push_layer(CompositeMode::Multiply);
            painter.fill(sweep);
            painter.pop_layer_with_mode(CompositeMode::Multiply);
            painter.pop_layer_with_mode(CompositeMode::SrcOver);
        });
        assert!(svg.contains("spreadMethod=\"reflect\""));
        let stop = "<stop offset=\"1\" stop-color=\"#000000\" stop-opacity=\"0.25\"/>";
        assert!(svg.contains(stop), "{svg}");
        assert!(svg.contains("<g style=\"isolation:isolate\">"));
        assert!(svg.contains("<g style=\"mix-blend-mode:multiply\"><foreignObject"));
        // 0° кисти — справа (90° CSS), 360° — там же: полный круг
        let conic = "conic-gradient(from 90deg at 50px 50px,\
                     rgb(0 0 0 / 0.25) 0deg,rgb(255 0 0 / 1) 360deg)";
        assert!(svg.contains(conic), "{svg}");
        assert!(balanced(&svg));
    }

    #[test]
    fn porter_duff_modes_use_masks() {
        let svg = painted(|painter| {
            painter.push_layer(CompositeMode::SrcOver);
            painter.fill_glyph(GlyphId::new(1), None, solid_brush(0, 1.0));
            painter.push_layer(CompositeMode::DestOut);
            painter.fill_glyph(GlyphId::new(2), None, solid_brush(0, 1.0));
            painter.pop_layer_with_mode(CompositeMode::DestOut);
            painter.pop_layer_with_mode(CompositeMode::SrcOver);
        });
        assert!(svg.contains("<filter id=\"black\""));
        assert!(svg.contains("<g mask=\"url(#m1)\"><path d=\"M0 0L1 0L0 10Z\""), "{svg}");
        assert!(balanced(&svg));
    }

    #[test]
    fn negative_radius_is_cut() {
        let red = Rgba([1.0, 0.0, 0.0, 1.0]);
        let blue = Rgba([0.0, 0.0, 1.0, 1.0]);
        let radial = |r0: f32, r1: f32| Radial {
            c0: Point { x: 0.0, y: 0.0 },
            r0,
            c1: Point { x: 10.0, y: 0.0 },
            r1,
            stops: vec![
                Stop {
                    offset: 0.0,
                    color: red,
                },
                Stop {
                    offset: 1.0,
                    color: blue,
                },
            ],
        };
        let cut = radial(-10.0, 10.0).truncated().unwrap();
        assert_eq!((cut.c0.x, cut.r0, cut.r1), (5.0, 0.0, 10.0));
        assert_eq!(cut.stops[0].color, red.mix(blue, 0.5));
        assert_eq!(cut.stops.last().unwrap().offset, 1.0);
        assert!(radial(-1.0, -2.0).truncated().is_none());
    }

    #[test]
    fn inverse_matrix() {
        let m = Matrix {
            xx: 2.0,
            yx: 1.0,
            xy: 0.5,
            yy: 3.0,
            dx: 7.0,
            dy: -4.0,
        };
        let inverse = invert(m).unwrap();
        let (x, y) = m.transform(3.0, 5.0);
        let (back_x, back_y) = inverse.transform(x, y);
        assert!((back_x - 3.0).abs() < 1e-4 && (back_y - 5.0).abs() < 1e-4);
        assert!(invert(m.map(|_| 0.0)).is_none());
    }

    /// Эмодзи набора из системного шрифта как текст.
    fn drawn(system: &SystemEmoji, pack: &str, stem: &str) -> Option<String> {
        let image = system.svg(pack, stem)?;
        Some(String::from_utf8(image).unwrap())
    }

    /// Настоящий Segoe UI Emoji, если он есть на машине проверки.
    #[test]
    fn system_font_draws_fluent() {
        let Some(system) = SystemEmoji::load() else {
            eprintln!("эмодзи Fluent в системном шрифте нет — проверка пропущена");
            return;
        };
        let packs: Vec<_> = system.packs().collect();
        for pack in packs {
            let grin = drawn(&system, pack, "1f600").unwrap();
            assert!(grin.starts_with("<svg") && grin.contains("<path"), "{grin}");
            assert!(balanced(&grin));
            // ZWJ: 👩‍💻, оттенок кожи: 👋🏽, keycap: #️⃣, с fe0f и без
            let coder = drawn(&system, pack, "1f469-200d-1f4bb");
            assert!(coder.is_some());
            assert_ne!(coder, drawn(&system, pack, "1f469"));
            assert!(drawn(&system, pack, "1f44b-1f3fd").is_some());
            assert!(drawn(&system, pack, "23-fe0f-20e3").is_some());
            assert!(drawn(&system, pack, "2764-fe0f").is_some());
            assert!(drawn(&system, pack, "2764").is_some());
            // флагов стран в шрифте нет: два буквенных глифа — не картинка
            assert_eq!(drawn(&system, pack, "1f1f7-1f1fa"), None);
        }
        assert!(!system.provides("fluent-3d"));
    }
}
