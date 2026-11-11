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
