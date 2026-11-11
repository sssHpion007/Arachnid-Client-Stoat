//! Markdown списка изменений («Узнай, что нового») в виде дерева узлов.
//!
//! Браузерный клиент рисует список изменений полным Markdown (заголовки,
//! списки, таблицы, картинки — `renderChangelogMarkdown`). Здесь текст
//! разбирает pulldown-cmark, а интерфейс получает дерево узлов и строит
//! DOM сам: никакого HTML из сети в webview не попадает.

use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use serde::Serialize;

/// Узел документа.
#[derive(Debug, Default, Serialize, PartialEq, Eq)]
pub struct MdNode {
    /// `p`, `h1`…`h6`, `ul`, `ol`, `li`, `blockquote`, `pre`, `code`, `em`,
    /// `strong`, `del`, `a`, `img`, `br`, `hr`, `table`, `thead`, `tr`,
    /// `th`, `td`, `text`, `span` (всё прочее — просто контейнер)
    pub tag: &'static str,
    /// Текст листа (`text`, `code`, `pre`)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Адрес ссылки (`a`) или картинки (`img`)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub href: Option<String>,
    /// Номер первого пункта нумерованного списка
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start: Option<u64>,
    /// Вложенные узлы
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<MdNode>,
}

impl MdNode {
    fn container(tag: &'static str) -> Self {
        Self {
            tag,
            ..Self::default()
        }
    }

    fn leaf(tag: &'static str, text: impl Into<String>) -> Self {
        Self {
            tag,
            text: Some(text.into()),
            ..Self::default()
        }
    }
}

fn heading(level: HeadingLevel) -> &'static str {
    match level {
        HeadingLevel::H1 => "h1",
        HeadingLevel::H2 => "h2",
        HeadingLevel::H3 => "h3",
        HeadingLevel::H4 => "h4",
        HeadingLevel::H5 => "h5",
        HeadingLevel::H6 => "h6",
    }
}

/// Только http(s): `javascript:` и прочие схемы из сети не пропускаем.
fn safe_url(url: &str) -> Option<String> {
    let url = url.trim();
    let lower = url.to_ascii_lowercase();
    (lower.starts_with("https://") || lower.starts_with("http://")).then(|| url.to_string())
}

/// Разобрать Markdown (GFM: таблицы, зачёркивание, списки задач).
pub fn tree(text: &str) -> Vec<MdNode> {
    let options =
        Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    // корень — всегда нижний элемент стека; каждому Start соответствует End
    let mut stack = vec![MdNode::container("root")];
    let mut code: Option<String> = None;

    for event in Parser::new_ext(text, options) {
        match event {
            Event::Start(tag) => {
                let node = match tag {
                    Tag::Paragraph => MdNode::container("p"),
                    Tag::Heading { level, .. } => MdNode::container(heading(level)),
                    Tag::BlockQuote(_) => MdNode::container("blockquote"),
                    // язык подсветки не нужен: блок показывается моноширинным
                    Tag::CodeBlock(_) => {
                        code = Some(String::new());
                        MdNode::container("pre")
                    }
                    Tag::List(start) => MdNode {
                        start,
                        ..MdNode::container(if start.is_some() { "ol" } else { "ul" })
                    },
                    Tag::Item => MdNode::container("li"),
                    Tag::Table(_) => MdNode::container("table"),
                    Tag::TableHead => MdNode::container("thead"),
                    Tag::TableRow => MdNode::container("tr"),
                    Tag::TableCell => {
                        let in_head = stack.last().is_some_and(|node| node.tag == "thead");
                        MdNode::container(if in_head { "th" } else { "td" })
                    }
                    Tag::Emphasis => MdNode::container("em"),
                    Tag::Strong => MdNode::container("strong"),
                    Tag::Strikethrough => MdNode::container("del"),
                    Tag::Link { dest_url, .. } => MdNode {
                        href: safe_url(&dest_url),
                        ..MdNode::container("a")
                    },
                    Tag::Image { dest_url, .. } => MdNode {
                        href: safe_url(&dest_url),
                        ..MdNode::container("img")
                    },
                    _ => MdNode::container("span"),
                };
                stack.push(node);
            }
            Event::End(end) => {
                if stack.len() < 2 {
                    continue;
                }
                let Some(mut node) = stack.pop() else {
                    continue;
                };
                if matches!(end, TagEnd::CodeBlock) {
                    node.text = code
                        .take()
                        .map(|text| text.trim_end_matches('\n').to_string());
                }
                if let Some(parent) = stack.last_mut() {
                    parent.children.push(node);
                }
            }
            Event::Text(text) => match code.as_mut() {
                Some(buffer) => buffer.push_str(&text),
                None => push(&mut stack, MdNode::leaf("text", text.to_string())),
            },
            Event::Code(text) => push(&mut stack, MdNode::leaf("code", text.to_string())),
            Event::InlineMath(text) | Event::DisplayMath(text) => {
                push(&mut stack, MdNode::leaf("code", text.to_string()));
            }
            // HTML из сети показываем как текст
            Event::Html(text) | Event::InlineHtml(text) => {
                push(&mut stack, MdNode::leaf("text", text.to_string()));
            }
            Event::SoftBreak => push(&mut stack, MdNode::leaf("text", " ")),
            Event::HardBreak => push(&mut stack, MdNode::container("br")),
            Event::Rule => push(&mut stack, MdNode::container("hr")),
            Event::TaskListMarker(done) => {
                push(
                    &mut stack,
                    MdNode::leaf("text", if done { "☑ " } else { "☐ " }),
                );
            }
            Event::FootnoteReference(name) => {
                push(&mut stack, MdNode::leaf("text", format!("[{name}]")));
            }
        }
    }

    // незакрытых узлов не бывает, но на всякий случай сворачиваем стек
    while stack.len() > 1 {
        if let Some(node) = stack.pop()
            && let Some(parent) = stack.last_mut()
        {
            parent.children.push(node);
        }
    }
    stack.pop().map(|root| root.children).unwrap_or_default()
}

fn push(stack: &mut [MdNode], node: MdNode) {
    if let Some(parent) = stack.last_mut() {
        parent.children.push(node);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headings_lists_and_links() {
        let nodes =
            tree("# Новое\n\n- **жирный** пункт\n- [ссылка](https://stoat.chat)\n\n1. раз\n2. два");
        assert_eq!(nodes[0].tag, "h1");
        assert_eq!(nodes[0].children[0].text.as_deref(), Some("Новое"));
        assert_eq!(nodes[1].tag, "ul");
        assert_eq!(nodes[1].children.len(), 2);
        assert_eq!(nodes[1].children[0].children[0].tag, "strong");
        let link = &nodes[1].children[1].children[0];
        assert_eq!(link.tag, "a");
        assert_eq!(link.href.as_deref(), Some("https://stoat.chat"));
        assert_eq!(nodes[2].tag, "ol");
        assert_eq!(nodes[2].start, Some(1));
    }

    #[test]
    fn unsafe_links_lose_address() {
        let nodes = tree("[x](javascript:alert(1)) ![i](data:image/png;base64,AAAA)");
        let paragraph = &nodes[0];
        assert_eq!(paragraph.children[0].tag, "a");
        assert_eq!(paragraph.children[0].href, None);
        let image = paragraph
            .children
            .iter()
            .find(|node| node.tag == "img")
            .unwrap();
        assert_eq!(image.href, None);
    }

    #[test]
    fn code_block_keeps_text() {
        let nodes = tree("```rust\nfn main() {}\n```");
        assert_eq!(nodes[0].tag, "pre");
        assert_eq!(nodes[0].text.as_deref(), Some("fn main() {}"));
        assert!(nodes[0].children.is_empty());
    }

    #[test]
    fn html_is_text() {
        let nodes = tree("<script>alert(1)</script>");
        let text: String = nodes
            .iter()
            .flat_map(|node| node.children.iter().chain(std::iter::once(node)))
            .filter_map(|node| node.text.clone())
            .collect();
        assert!(text.contains("<script>"));
    }

    #[test]
    fn table_head_cells_are_th() {
        let nodes = tree("| a | b |\n|---|---|\n| 1 | 2 |");
        assert_eq!(nodes[0].tag, "table");
        assert_eq!(nodes[0].children[0].tag, "thead");
        assert_eq!(nodes[0].children[0].children[0].tag, "th");
        assert_eq!(nodes[0].children[1].tag, "tr");
        assert_eq!(nodes[0].children[1].children[0].tag, "td");
    }
}
