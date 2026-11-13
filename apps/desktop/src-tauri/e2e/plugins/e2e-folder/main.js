// Плагин-папка для проверки e2e: всё, что он увидел, — в
// window.__e2eFolderPlugin, test.js сверяет это с ожидаемым.
const report = {
  id: plugin.id,
  apiVersion: plugin.apiVersion,
  name: plugin.manifest.name,
  settings: plugin.settings,
  network: plugin.network,
  asset: plugin.asset("img/dot.png"),
  native: plugin.native.available,
  changes: [],
};
window.__e2eFolderPlugin = report;
plugin.onSettingsChange((values) => report.changes.push(values));

try {
  await plugin.storage.set("greeting", { text: "привет" });
  report.stored = await plugin.storage.get("greeting");
  report.echo = await plugin.native.call("echo", { list: [1, 2], text: "ok" });
  // модуль читает то же хранилище, что и код страницы
  report.greeting = await plugin.native.call("greeting");
  report.denied = await plugin.fetch("https://evil.example.org/").then(
    () => null,
    (error) => ({ kind: error.kind, message: error.message }),
  );
} catch (error) {
  report.error = String(error?.stack || error);
}
report.ready = true;
