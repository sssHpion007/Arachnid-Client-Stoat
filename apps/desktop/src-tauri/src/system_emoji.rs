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
//! * Слои глифа (read-fonts) рисуются сразу в растр (tiny-skia): контуры —
//!   пути, заливки — цвета палитры и градиенты (линейный, радиальный,
//!   угловой), режимы наложения COLR — режимы tiny-skia, обрезки — маски.
//!   Странице уходит PNG (почему не SVG — в `emoji_raster.rs`).
//!
//! Шрифт отображается в память, а не читается в неё: страницы файла общие с
//! другими программами, которые им пишут, и читаются по мере надобности.

// В Linux и macOS шрифта нет: картинки там идут с сервера (emoji_packs.rs)
#![cfg_attr(not(windows), allow(dead_code))]

use harfrust::{Buffer, BufferFlags, Direction, Script, ShapeOptions, ShapePlan, ShaperFont};
use read_fonts::model::Font;
use read_fonts::model::glyph::color::{
    Brush, Color, ColorGlyph, ColorStop, ColorVersion, CompositeMode, Extend, PaintSink,
};
use read_fonts::model::glyph::outline::{DrawMemory, DrawOptions, PathSink};
use read_fonts::types::{BoundingBox, GlyphId, Matrix, Point};
use resvg::tiny_skia::{
    BlendMode, Color as SkiaColor, FillRule, GradientStop, LinearGradient, Mask, Paint, Path,
    PathBuilder, Pixmap, PixmapPaint, Point as SkiaPoint, RadialGradient, Rect, Shader, SpreadMode,
    SweepGradient, Transform,
};

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

    /// PNG эмодзи набора `pack` по кодовым точкам из адреса картинки,
    /// сторона — `side` пикселей.
    pub fn png(&self, pack: &str, stem: &str, side: u32) -> Option<Vec<u8>> {
        self.pixmap(pack, stem, side)?.encode_png().ok()
    }

    fn pixmap(&self, pack: &str, stem: &str, side: u32) -> Option<Pixmap> {
        let version = self.version(pack)?;
        let glyph = self.glyph(stem)?;
        let color = self.font.color_glyphs().get_with_version(glyph, version)?;
        let colors = self.font.palettes().get(0)?.colors();
        let outlines = self.font.outline_glyphs();
        let outline = |glyph: GlyphId| {
            let drawn = outlines.get(glyph)?;
            let mut sink = Outline::default();
            drawn
                .draw(&DrawOptions::new(), DrawMemory::Scratch, &mut sink)
                .ok()?;
            sink.0.finish()
        };
        render(&color, colors, &outline, side)
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

// ─────────────────────────────── рисование ───────────────────────────────

/// Контур глифа в единицах шрифта.
#[derive(Default)]
struct Outline(PathBuilder);

impl PathSink for Outline {
    fn move_to(&mut self, x: f32, y: f32) {
        self.0.move_to(x, y);
    }

    fn line_to(&mut self, x: f32, y: f32) {
        self.0.line_to(x, y);
    }

    fn quad_to(&mut self, cx0: f32, cy0: f32, x: f32, y: f32) {
        self.0.quad_to(cx0, cy0, x, y);
    }

    fn curve_to(&mut self, cx0: f32, cy0: f32, cx1: f32, cy1: f32, x: f32, y: f32) {
        self.0.cubic_to(cx0, cy0, cx1, cy1, x, y);
    }

    fn close(&mut self) {
        self.0.close();
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

    fn skia(self) -> SkiaColor {
        let [r, g, b, a] = self.0.map(|value| value.clamp(0.0, 1.0));
        let color = SkiaColor::from_rgba(r, g, b, a);
        color.unwrap_or(SkiaColor::TRANSPARENT)
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

fn gradient_stops(stops: &[Stop]) -> Vec<GradientStop> {
    stops
        .iter()
        .map(|stop| GradientStop::new(stop.offset, stop.color.skia()))
        .collect()
}

/// Глиф эмодзи в квадратной картинке со стороной `side` пикселей.
/// `outline` — контур глифа шрифта.
fn render(
    glyph: &ColorGlyph<'_>,
    colors: &[Color],
    outline: &dyn Fn(GlyphId) -> Option<Path>,
    side: u32,
) -> Option<Pixmap> {
    let extents = glyph.extents().ok()?;
    if extents.width <= 0.0 || extents.height <= 0.0 {
        return None;
    }
    // квадрат вокруг рисунка: эмодзи наборов for-web квадратные
    let size = extents.width.max(extents.height);
    let center_x = extents.x_bearing + extents.width / 2.0;
    let center_y = extents.y_bearing - extents.height / 2.0;
    let view = BoundingBox {
        x_min: center_x - size / 2.0,
        y_min: center_y - size / 2.0,
        x_max: center_x + size / 2.0,
        y_max: center_y + size / 2.0,
    };
    let mut painter = Painter::new(view, side, colors, outline)?;
    glyph.paint(&mut painter).ok()?;
    painter.finish()
}

/// Контуры глифов TrueType заполняются по ненулевому правилу.
const WINDING: FillRule = FillRule::Winding;

/// Слой наложения: что в нём нарисовано и как он ляжет на слой ниже.
struct Layer {
    pixmap: Pixmap,
    mode: BlendMode,
}

/// Рисует операции глифа COLR в растр (tiny-skia).
///
/// Координаты операций — единицы шрифта с осью y вверх; первая матрица
/// переводит их в пиксели картинки с осью y вниз. Обрезки — маски
/// размером с картинку, слои наложения — отдельные растры, которые при
/// закрытии ложатся на слой ниже в режиме слоя.
struct Painter<'a> {
    side: u32,
    colors: &'a [Color],
    outline: &'a dyn Fn(GlyphId) -> Option<Path>,
    layers: Vec<Layer>,
    /// Текущая матрица для каждой открытой группы преобразования
    transforms: Vec<Transform>,
    /// Обрезка для каждой открытой обрезки; None — без обрезки
    clips: Vec<Option<Mask>>,
}

impl<'a> Painter<'a> {
    /// `view` — рамка картинки в единицах шрифта.
    fn new(
        view: BoundingBox<f32>,
        side: u32,
        colors: &'a [Color],
        outline: &'a dyn Fn(GlyphId) -> Option<Path>,
    ) -> Option<Self> {
        let scale = side as f32 / (view.x_max - view.x_min);
        if !scale.is_finite() {
            return None;
        }
        let x = -view.x_min * scale;
        let y = view.y_max * scale;
        let base = Transform::from_row(scale, 0.0, 0.0, -scale, x, y);
        let pixmap = Pixmap::new(side, side)?;
        Some(Self {
            side,
            colors,
            outline,
            layers: vec![Layer {
                pixmap,
                mode: BlendMode::SourceOver,
            }],
            transforms: vec![base],
            clips: vec![None],
        })
    }

    fn finish(mut self) -> Option<Pixmap> {
        let balanced = self.layers.len() == 1 && self.transforms.len() == 1;
        if !balanced || self.clips.len() != 1 {
            return None;
        }
        Some(self.layers.pop()?.pixmap)
    }

    fn current(&self) -> Transform {
        self.transforms.last().copied().unwrap_or_default()
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

    /// Точки цветовой линии по возрастанию.
    fn stops(&self, stops: &[ColorStop]) -> Vec<Stop> {
        let mut line: Vec<Stop> = stops
            .iter()
            .map(|stop| Stop {
                offset: stop.offset,
                color: self.color(stop.palette_index, stop.alpha),
            })
            .collect();
        line.sort_by(|a, b| a.offset.total_cmp(&b.offset));
        line
    }

    /// Шейдер кисти; `transform` — из координат кисти в координаты, в
    /// которых рисуется заливка. None — кисть ничего не рисует.
    fn shader(&self, brush: &Brush<'_>, transform: Transform) -> Option<Shader<'static>> {
        match brush {
            Brush::Solid {
                palette_index,
                alpha,
            } => {
                let color = self.color(*palette_index, *alpha);
                Some(Shader::SolidColor(color.skia()))
            }
            Brush::LinearGradient {
                p0,
                p1,
                color_stops,
                extend,
            } => {
                let stops = gradient_stops(&self.stops(color_stops));
                let (start, end) = (point(*p0), point(*p1));
                LinearGradient::new(start, end, stops, spread(*extend), transform)
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
                let radial = radial.truncated()?;
                RadialGradient::new(
                    point(radial.c0),
                    radial.r0,
                    point(radial.c1),
                    radial.r1,
                    gradient_stops(&radial.stops),
                    spread(*extend),
                    transform,
                )
            }
            Brush::SweepGradient {
                c0,
                start_angle,
                end_angle,
                color_stops,
                extend,
            } => {
                let stops = self.stops(color_stops);
                let circle = sweep_stops(*start_angle, *end_angle, &stops, *extend)?;
                let stops = gradient_stops(&circle);
                // Угол кисти a — точка (cos a, −sin a) в единицах шрифта (по
                // часовой стрелке при оси y вниз). tiny-skia берёт угол как
                // atan2(y, x) в координатах шейдера: в них ось y отражена.
                let flipped = transform.pre_scale(1.0, -1.0);
                let center = SkiaPoint::from_xy(c0.x, -c0.y);
                SweepGradient::new(center, 0.0, 360.0, stops, SpreadMode::Pad, flipped)
            }
        }
    }

    /// Открыть обрезку по контуру `path` в текущих координатах (None —
    /// пустой контур, он обрезает всё).
    fn push_clip(&mut self, path: Option<&Path>) {
        let transform = self.current();
        let mask = match (self.clips.last(), path) {
            (Some(Some(current)), Some(path)) => {
                let mut mask = current.clone();
                mask.intersect_path(path, WINDING, true, transform);
                Some(mask)
            }
            (_, Some(path)) => {
                let mut mask = Mask::new(self.side, self.side);
                if let Some(mask) = mask.as_mut() {
                    mask.fill_path(path, WINDING, true, transform);
                }
                mask
            }
            (_, None) => Mask::new(self.side, self.side),
        };
        self.clips.push(mask);
    }
}

impl PaintSink for Painter<'_> {
    fn push_transform(&mut self, transform: Matrix<f32>) {
        let next = self.current().pre_concat(skia_transform(transform));
        self.transforms.push(next);
    }

    fn pop_transform(&mut self) {
        if self.transforms.len() > 1 {
            self.transforms.pop();
        }
    }

    fn push_clip_glyph(&mut self, glyph: GlyphId) {
        let path = (self.outline)(glyph);
        self.push_clip(path.as_ref());
    }

    fn push_clip_box(&mut self, clip_box: BoundingBox<f32>) {
        let BoundingBox {
            x_min,
            y_min,
            x_max,
            y_max,
        } = clip_box;
        let rect = Rect::from_ltrb(x_min, y_min, x_max, y_max);
        let path = rect.map(PathBuilder::from_rect);
        self.push_clip(path.as_ref());
    }

    fn pop_clip(&mut self) {
        if self.clips.len() > 1 {
            self.clips.pop();
        }
    }

    fn fill(&mut self, brush: Brush<'_>) {
        let Some(shader) = self.shader(&brush, self.current()) else {
            return;
        };
        let side = self.side as f32;
        let Some(area) = Rect::from_xywh(0.0, 0.0, side, side) else {
            return;
        };
        let paint = Paint {
            shader,
            ..Paint::default()
        };
        let mask = self.clips.last().and_then(Option::as_ref);
        if let Some(Layer { pixmap, .. }) = self.layers.last_mut() {
            pixmap.fill_rect(area, &paint, Transform::identity(), mask);
        }
    }

    fn fill_glyph(
        &mut self,
        glyph: GlyphId,
        brush_transform: Option<Matrix<f32>>,
        brush: Brush<'_>,
    ) {
        let Some(path) = (self.outline)(glyph) else {
            return;
        };
        let local = brush_transform.map_or_else(Transform::identity, skia_transform);
        let Some(shader) = self.shader(&brush, local) else {
            return;
        };
        let paint = Paint {
            shader,
            ..Paint::default()
        };
        let transform = self.current();
        let mask = self.clips.last().and_then(Option::as_ref);
        if let Some(Layer { pixmap, .. }) = self.layers.last_mut() {
            pixmap.fill_path(&path, &paint, WINDING, transform, mask);
        }
    }

    fn push_layer(&mut self, composite_mode: CompositeMode) {
        // сторона картинки не нулевая: растр создаётся всегда
        if let Some(pixmap) = Pixmap::new(self.side, self.side) {
            let mode = blend_mode(composite_mode);
            self.layers.push(Layer { pixmap, mode });
        }
    }

    fn pop_layer_with_mode(&mut self, _composite_mode: CompositeMode) {
        if self.layers.len() < 2 {
            return;
        }
        let Some(layer) = self.layers.pop() else {
            return;
        };
        let paint = PixmapPaint {
            blend_mode: layer.mode,
            ..PixmapPaint::default()
        };
        if let Some(Layer { pixmap: below, .. }) = self.layers.last_mut() {
            let source = layer.pixmap.as_ref();
            let identity = Transform::identity();
            below.draw_pixmap(0, 0, source, &paint, identity, None);
        }
    }
}

/// Режим наложения слоя COLR в tiny-skia (там есть все).
fn blend_mode(mode: CompositeMode) -> BlendMode {
    match mode {
        CompositeMode::Clear => BlendMode::Clear,
        CompositeMode::Src => BlendMode::Source,
        CompositeMode::Dest => BlendMode::Destination,
        CompositeMode::DestOver => BlendMode::DestinationOver,
        CompositeMode::SrcIn => BlendMode::SourceIn,
        CompositeMode::DestIn => BlendMode::DestinationIn,
        CompositeMode::SrcOut => BlendMode::SourceOut,
        CompositeMode::DestOut => BlendMode::DestinationOut,
        CompositeMode::SrcAtop => BlendMode::SourceAtop,
        CompositeMode::DestAtop => BlendMode::DestinationAtop,
        CompositeMode::Xor => BlendMode::Xor,
        CompositeMode::Plus => BlendMode::Plus,
        CompositeMode::Screen => BlendMode::Screen,
        CompositeMode::Overlay => BlendMode::Overlay,
        CompositeMode::Darken => BlendMode::Darken,
        CompositeMode::Lighten => BlendMode::Lighten,
        CompositeMode::ColorDodge => BlendMode::ColorDodge,
        CompositeMode::ColorBurn => BlendMode::ColorBurn,
        CompositeMode::HardLight => BlendMode::HardLight,
        CompositeMode::SoftLight => BlendMode::SoftLight,
        CompositeMode::Difference => BlendMode::Difference,
        CompositeMode::Exclusion => BlendMode::Exclusion,
        CompositeMode::Multiply => BlendMode::Multiply,
        CompositeMode::HslHue => BlendMode::Hue,
        CompositeMode::HslSaturation => BlendMode::Saturation,
        CompositeMode::HslColor => BlendMode::Color,
        CompositeMode::HslLuminosity => BlendMode::Luminosity,
        // SrcOver и неизвестные режимы
        _ => BlendMode::SourceOver,
    }
}

fn skia_transform(m: Matrix<f32>) -> Transform {
    Transform::from_row(m.xx, m.yx, m.xy, m.yy, m.dx, m.dy)
}

fn point(p: Point<f32>) -> SkiaPoint {
    SkiaPoint::from_xy(p.x, p.y)
}

fn spread(extend: Extend) -> SpreadMode {
    match extend {
        Extend::Repeat => SpreadMode::Repeat,
        Extend::Reflect => SpreadMode::Reflect,
        _ => SpreadMode::Pad,
    }
}

/// Сколько периодов повтора углового градиента разворачивать на круг.
const MAX_PERIODS: f32 = 512.0;

/// Точки углового градиента на всём круге 0…360°.
///
/// tiny-skia рисует угловой градиент с углами не 0…360° неверно (масштаб
/// цветовой линии не применяется, если начало — 0° или период — ровно круг),
/// поэтому градиент всегда рисуется от 0° до 360°, а продолжение крайних
/// цветов, повтор и отражение разворачиваются в точки здесь. Как в COLR (и
/// Skia), угол не сворачивается: при Pad точка под углом 300° в градиенте
/// −90…90° — последнего цвета.
fn sweep_stops(start: f32, end: f32, stops: &[Stop], extend: Extend) -> Option<Vec<Stop>> {
    if stops.is_empty() || !start.is_finite() || !end.is_finite() {
        return None;
    }
    // обратный ход — те же цвета от конца к началу
    let (start, end, stops) = if start <= end {
        (start, end, stops.to_vec())
    } else {
        let reversed: Vec<Stop> = stops
            .iter()
            .rev()
            .map(|stop| Stop {
                offset: 1.0 - stop.offset,
                color: stop.color,
            })
            .collect();
        (end, start, reversed)
    };
    let (first, last) = (stops.first()?.color, stops.last()?.color);
    let span = end - start;
    let repeated = matches!(extend, Extend::Repeat | Extend::Reflect);

    // (угол, цвет) по возрастанию угла, с запасом за пределами круга
    let mut line: Vec<(f32, Rgba)> = Vec::new();
    if repeated && span > f32::EPSILON && 360.0 / span <= MAX_PERIODS {
        let from = (-start / span).floor() as i64 - 1;
        let to = ((360.0 - start) / span).ceil() as i64 + 1;
        for period in from..=to {
            let base = start + period as f32 * span;
            if extend == Extend::Reflect && period.rem_euclid(2) == 1 {
                for stop in stops.iter().rev() {
                    line.push((base + (1.0 - stop.offset) * span, stop.color));
                }
            } else {
                for stop in &stops {
                    line.push((base + stop.offset * span, stop.color));
                }
            }
        }
    } else {
        line.push((start.min(0.0) - 1.0, first));
        for stop in &stops {
            line.push((start + stop.offset * span, stop.color));
        }
        line.push((end.max(360.0) + 1.0, last));
    }

    let mut circle = vec![(0.0, line_color(&line, 0.0, true))];
    for &(angle, color) in &line {
        if angle > 0.0 && angle < 360.0 {
            circle.push((angle, color));
        }
    }
    circle.push((360.0, line_color(&line, 360.0, false)));
    // на стыке отражённых периодов точка повторяется
    circle.dedup();
    let stops = circle
        .into_iter()
        .map(|(angle, color)| Stop {
            offset: angle / 360.0,
            color,
        })
        .collect();
    Some(stops)
}

/// Цвет линии (угол, цвет) под углом `angle`. На резкой границе (две точки с
/// одним углом) — цвет сразу после неё (`after`) или сразу перед ней.
fn line_color(line: &[(f32, Rgba)], angle: f32, after: bool) -> Rgba {
    for pair in line.windows(2) {
        let [(a0, c0), (a1, c1)] = [pair[0], pair[1]];
        let inside = if after {
            a0 <= angle && angle < a1
        } else {
            a0 < angle && angle <= a1
        };
        if inside {
            return c0.mix(c1, (angle - a0) / (a1 - a0));
        }
    }
    match line.first() {
        Some((a0, c0)) if angle <= *a0 => *c0,
        _ => line.last().map_or(Rgba([0.0; 4]), |(_, color)| *color),
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

    /// Контур глифа в проверках: квадрат со стороной в номер глифа от (0, 0).
    fn square(glyph: GlyphId) -> Option<Path> {
        let side = glyph.to_u32() as f32;
        let rect = Rect::from_xywh(0.0, 0.0, side, side)?;
        Some(PathBuilder::from_rect(rect))
    }

    /// Нарисованное в рамке 0…100 единиц шрифта, картинка 100×100 пикселей,
    /// палитра из красного.
    fn painted(paint: impl FnOnce(&mut Painter<'_>)) -> Pixmap {
        let view = BoundingBox {
            x_min: 0.0,
            y_min: 0.0,
            x_max: 100.0,
            y_max: 100.0,
        };
        let colors = [RED];
        let mut painter = Painter::new(view, 100, &colors, &square).unwrap();
        paint(&mut painter);
        painter.finish().unwrap()
    }

    /// Цвет пикселя по координатам шрифта (ось y вверх).
    fn at(pixmap: &Pixmap, x: u32, y: u32) -> [u8; 4] {
        let pixel = pixmap.pixel(x, 99 - y).unwrap();
        [pixel.red(), pixel.green(), pixel.blue(), pixel.alpha()]
    }

    fn solid_brush(palette_index: u16, alpha: f32) -> Brush<'static> {
        Brush::Solid {
            palette_index,
            alpha,
        }
    }

    fn red_to_blue() -> Vec<Stop> {
        vec![
            Stop {
                offset: 0.0,
                color: Rgba([1.0, 0.0, 0.0, 1.0]),
            },
            Stop {
                offset: 1.0,
                color: Rgba([0.0, 0.0, 1.0, 1.0]),
            },
        ]
    }

    /// Положение и цвет (красный, синий 0…255) точек градиента.
    fn described(stops: &[Stop]) -> Vec<(f32, u8, u8)> {
        let channel = |value: f32| (value * 255.0).round() as u8;
        stops
            .iter()
            .map(|stop| {
                let [red, _, blue, _] = stop.color.0;
                (stop.offset, channel(red), channel(blue))
            })
            .collect()
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
    fn glyphs_clips_and_transforms() {
        let half = Matrix {
            xx: 0.5,
            yx: 0.0,
            xy: 0.0,
            yy: 0.5,
            dx: 50.0,
            dy: 0.0,
        };
        let pixmap = painted(|painter| {
            // красный квадрат 0…40 с непрозрачностью 0.5
            painter.fill_glyph(GlyphId::new(40), None, solid_brush(0, 0.5));
            // чёрный (цвет текста) в квадрате 0…40, сжатом вдвое и сдвинутом
            // на 50: 50…70 по x, 0…20 по y
            painter.push_transform(half);
            painter.push_clip_glyph(GlyphId::new(40));
            painter.fill(solid_brush(FOREGROUND, 1.0));
            painter.pop_clip();
            painter.pop_transform();
        });
        let [red, green, blue, alpha] = at(&pixmap, 20, 20);
        let translucent = (126..=129).contains(&alpha);
        assert!(translucent && red == alpha, "{red} {alpha}");
        assert_eq!((green, blue), (0, 0));
        // ось y вверх: над квадратом пусто
        assert_eq!(at(&pixmap, 20, 60)[3], 0);
        assert_eq!(at(&pixmap, 60, 10), [0, 0, 0, 255]);
        assert_eq!(at(&pixmap, 60, 30)[3], 0);
        assert_eq!(at(&pixmap, 80, 10)[3], 0);
    }

    #[test]
    fn layers_are_composited() {
        let pixmap = painted(|painter| {
            painter.push_layer(CompositeMode::SrcOver);
            painter.fill_glyph(GlyphId::new(80), None, solid_brush(0, 1.0));
            // вырезать квадрат 0…40 из того, что под слоем
            painter.push_layer(CompositeMode::DestOut);
            painter.fill_glyph(GlyphId::new(40), None, solid_brush(0, 1.0));
            painter.pop_layer_with_mode(CompositeMode::DestOut);
            painter.pop_layer_with_mode(CompositeMode::SrcOver);
        });
        assert_eq!(at(&pixmap, 20, 20)[3], 0);
        assert_eq!(at(&pixmap, 60, 60), [255, 0, 0, 255]);
        assert_eq!(at(&pixmap, 90, 90)[3], 0);

        let multiplied = painted(|painter| {
            painter.push_layer(CompositeMode::SrcOver);
            painter.fill(solid_brush(0, 1.0));
            painter.push_layer(CompositeMode::Multiply);
            painter.fill(solid_brush(FOREGROUND, 1.0));
            painter.pop_layer_with_mode(CompositeMode::Multiply);
            painter.pop_layer_with_mode(CompositeMode::SrcOver);
        });
        assert_eq!(at(&multiplied, 50, 50), [0, 0, 0, 255]);
    }

    #[test]
    fn unbalanced_operations_draw_nothing() {
        let view = BoundingBox {
            x_min: 0.0,
            y_min: 0.0,
            x_max: 10.0,
            y_max: 10.0,
        };
        let mut painter = Painter::new(view, 10, &[], &square).unwrap();
        painter.push_layer(CompositeMode::SrcOver);
        assert!(painter.finish().is_none());
    }

    #[test]
    fn sweep_goes_clockwise_from_the_right() {
        let stops = [
            ColorStop {
                offset: 0.0,
                palette_index: 0,
                alpha: 1.0,
            },
            ColorStop {
                offset: 1.0,
                palette_index: FOREGROUND,
                alpha: 1.0,
            },
        ];
        let pixmap = painted(|painter| {
            painter.fill(Brush::SweepGradient {
                c0: Point { x: 50.0, y: 50.0 },
                start_angle: 0.0,
                end_angle: 360.0,
                color_stops: &stops,
                extend: Extend::Pad,
            });
        });
        // угол кисти a — точка (cos a, −sin a): 20° — справа ниже центра,
        // почти начало линии (красный); 340° — справа выше, почти чёрный
        let early = at(&pixmap, 88, 36);
        let late = at(&pixmap, 88, 64);
        assert!(early[0] > 200 && late[0] < 55, "{early:?} {late:?}");
        // 180° — слева, середина
        let middle = at(&pixmap, 10, 50)[0];
        assert!((100..156).contains(&middle), "{middle}");
    }

    #[test]
    fn sweep_extends_over_the_circle() {
        let line = red_to_blue();
        // Pad: после конца градиента — последний цвет
        let pad = sweep_stops(0.0, 180.0, &line, Extend::Pad).unwrap();
        let expected = [(0.0, 255, 0), (0.5, 0, 255), (1.0, 0, 255)];
        assert_eq!(described(&pad), expected);
        // обратный ход: 180 → 0
        let back = sweep_stops(180.0, 0.0, &line, Extend::Pad).unwrap();
        let expected = [(0.0, 0, 255), (0.5, 255, 0), (1.0, 255, 0)];
        assert_eq!(described(&back), expected);
        // Repeat: четыре периода с резкими границами
        let repeat = sweep_stops(0.0, 90.0, &line, Extend::Repeat).unwrap();
        let expected = [
            (0.0, 255, 0),
            (0.25, 0, 255),
            (0.25, 255, 0),
            (0.5, 0, 255),
            (0.5, 255, 0),
            (0.75, 0, 255),
            (0.75, 255, 0),
            (1.0, 0, 255),
        ];
        assert_eq!(described(&repeat), expected);
        // Reflect: туда и обратно без резких границ
        let reflect = sweep_stops(0.0, 180.0, &line, Extend::Reflect).unwrap();
        let expected = [(0.0, 255, 0), (0.5, 0, 255), (1.0, 255, 0)];
        assert_eq!(described(&reflect), expected);
        // начало не с нуля: −90…90, 300° — последний цвет
        let shifted = sweep_stops(-90.0, 90.0, &line, Extend::Pad).unwrap();
        let shifted = described(&shifted);
        assert_eq!(shifted[0].0, 0.0);
        assert!(shifted[0].1 > 120 && shifted[0].1 < 135, "{shifted:?}");
        assert_eq!(*shifted.last().unwrap(), (1.0, 0, 255));
        assert!(sweep_stops(0.0, 90.0, &[], Extend::Pad).is_none());
    }

    #[test]
    fn negative_radius_is_cut() {
        let [red, blue] = [Rgba([1.0, 0.0, 0.0, 1.0]), Rgba([0.0, 0.0, 1.0, 1.0])];
        let radial = |r0: f32, r1: f32| Radial {
            c0: Point { x: 0.0, y: 0.0 },
            r0,
            c1: Point { x: 10.0, y: 0.0 },
            r1,
            stops: red_to_blue(),
        };
        let cut = radial(-10.0, 10.0).truncated().unwrap();
        assert_eq!((cut.c0.x, cut.r0, cut.r1), (5.0, 0.0, 10.0));
        assert_eq!(cut.stops[0].color, red.mix(blue, 0.5));
        assert_eq!(cut.stops.last().unwrap().offset, 1.0);
        assert!(radial(-1.0, -2.0).truncated().is_none());
    }

    /// Эмодзи набора из системного шрифта; картинка 64×64.
    fn drawn(system: &SystemEmoji, pack: &str, stem: &str) -> Option<Pixmap> {
        system.pixmap(pack, stem, 64)
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
            assert_eq!((grin.width(), grin.height()), (64, 64));
            // лицо жёлтое: лоб (треть высоты сверху) — жёлтый и непрозрачный
            let forehead = grin.pixel(32, 14).unwrap();
            let yellow = forehead.red() > 180 && forehead.green() > 120 && forehead.blue() < 110;
            assert!(yellow && forehead.alpha() == 255, "{pack}: {forehead:?}");
            // углы картинки вне круга лица — прозрачные
            assert_eq!(grin.pixel(0, 0).unwrap().alpha(), 0, "{pack}");

            let png = system.png(pack, "1f600", 64).unwrap();
            assert!(png.starts_with(b"\x89PNG"));
            // ZWJ: 👩‍💻, оттенок кожи: 👋🏽, keycap: #️⃣, с fe0f и без
            let coder = drawn(&system, pack, "1f469-200d-1f4bb").unwrap();
            let woman = drawn(&system, pack, "1f469").unwrap();
            assert_ne!(coder.data(), woman.data());
            assert!(drawn(&system, pack, "1f44b-1f3fd").is_some());
            assert!(drawn(&system, pack, "23-fe0f-20e3").is_some());
            assert!(drawn(&system, pack, "2764-fe0f").is_some());
            assert!(drawn(&system, pack, "2764").is_some());
            // флагов стран в шрифте нет: два буквенных глифа — не картинка
            assert!(drawn(&system, pack, "1f1f7-1f1fa").is_none());
        }
        assert!(!system.provides("fluent-3d"));
    }
}
