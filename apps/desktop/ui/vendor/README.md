# Сторонние библиотеки интерфейса

## material-color.js

[`@material/material-color-utilities`](https://github.com/material-foundation/material-color-utilities)
0.3.0 (Apache-2.0) — та же версия, что в браузерном клиенте Stoat. По ней
строится палитра Material You из акцента, контраста и варианта темы
(раздел «Внешний вид»).

Собрано так:

```sh
npm i @material/material-color-utilities@0.3.0 esbuild
cat > entry.js <<'JS'
export { Hct, argbFromHex, hexFromArgb, SchemeContent, SchemeExpressive, SchemeFidelity, SchemeFruitSalad, SchemeMonochrome, SchemeNeutral, SchemeRainbow, SchemeTonalSpot, SchemeVibrant } from "@material/material-color-utilities";
JS
npx esbuild entry.js --bundle --minify --format=iife --global-name=MaterialColor --outfile=material-color.js
```

## markdown.js

Разбор Markdown сообщений — тот же конвейер [unified](https://unifiedjs.com),
что в браузерном клиенте Stoat (`packages/client/components/markdown`):
remark-parse, remark-breaks, remark-gfm, remark-math, плагины Stoat
(упоминания, метки времени, каналы, эмодзи, спойлеры, автоссылки),
remark-rehype, rehype-katex и rehype-highlight (lowlight). Версии
зависимостей совпадают с `pnpm-lock.yaml` браузерного клиента.

Исходник — [`scripts/markdown/entry.js`](../../../../scripts/markdown/entry.js),
библиотека отдаёт дерево hast (`StoatMarkdown.parse`), DOM из него строит
`ui/markdown.js` по белому списку тегов и атрибутов.

Собрано так:

```sh
cd scripts/markdown
npm i
npx esbuild entry.js --bundle --minify --format=iife --global-name=StoatMarkdown \
  --legal-comments=eof --target=es2022 --outfile=../../apps/desktop/ui/vendor/markdown.js
```

Лицензии: пакеты unified/remark/rehype/micromark/mdast/hast, KaTeX,
linkify-it, emoji-regex, lowlight и остальные зависимости — MIT (KaTeX —
`LICENSE-katex.txt`); `@ungap/structured-clone` и `hast-util-from-dom` — ISC;
`entities` — BSD-2-Clause; highlight.js — BSD-3-Clause
(`LICENSE-highlight.js.txt`).

## katex/

Стили и шрифты [KaTeX](https://katex.org) 0.16.22 (MIT) для формул
`$$…$$`. Из `katex/dist` взяты `katex.min.css` и шрифты `fonts/*.woff2`;
в CSS оставлены только ссылки на woff2 — WebView2 их поддерживает,
а woff/ttf лишь увеличили бы установщик:

```sh
sed -E 's/,url\(fonts\/[A-Za-z0-9_-]+\.woff\) format\("woff"\),url\(fonts\/[A-Za-z0-9_-]+\.ttf\) format\("truetype"\)//g' \
  node_modules/katex/dist/katex.min.css > katex/katex.min.css
cp node_modules/katex/dist/fonts/*.woff2 katex/fonts/
```
