      // Мост к ядру. В обычном браузере (без Tauri) интерфейс остаётся
      // работоспособным как макет: вызовы логируются, но не падают.
      const bridge = window.__TAURI__;
      const invoke = bridge && bridge.core && bridge.core.invoke;
      const listen = bridge && bridge.event && bridge.event.listen;

      // Переход на другую встроенную страницу: сначала через Tauri,
      // иначе политика безопасности может запретить обычный переход.
      async function goto(page) {
        if (bridge && bridge.webviewWindow && bridge.webviewWindow.getCurrentWebviewWindow) {
          try {
            await bridge.webviewWindow.getCurrentWebviewWindow().navigate(page);
            return;
          } catch (error) {
            console.warn("навигация через Tauri не удалась:", error);
          }
        }
        location.replace(page);
      }
      const logEl = document.getElementById("log");

      function log(text, kind = "info") {
        const time = new Date().toLocaleTimeString();
        const prefix = { info: "·", ok: "✓", err: "✗", warn: "!" }[kind] || "·";
        logEl.textContent += `${time} ${prefix} ${text}\n`;
        logEl.scrollTop = logEl.scrollHeight;
      }

      function setConn(state, text) {
        document.getElementById("conn-dot").className = "dot " + state;
        document.getElementById("conn-text").textContent = text;
      }

      async function call(cmd, args = {}) {
        if (!invoke) {
          log(`${cmd}(${JSON.stringify(args)}) — вне Tauri, вызов пропущен`, "warn");
          return null;
        }
        try {
          return await invoke(cmd, args);
        } catch (error) {
          const message = error?.message || String(error);
          log(`${cmd}: ${message}`, "err");
          throw error;
        }
      }

      async function refreshInstance() {
        const info = await call("instance_info");
        if (!info) {
          document.getElementById("api").textContent = "— (не в Tauri)";
          return;
        }
        document.getElementById("api").textContent = info.api_url;
        document.getElementById("ws").textContent = info.ws_url;
        document.getElementById("voice").textContent = info.voice ? "включён" : "выключен";
        document.getElementById("version").textContent = "API " + (info.version || "?");
        if (info.version) setConn("ok", "инстанс отвечает");
      }

      async function refreshSession() {
        const session = await call("session_state");
        if (!session) return;
        const box = document.getElementById("account");
        if (session.me) {
          box.textContent = `${session.me.display_name || session.me.username}#${session.me.discriminator} · серверов: ${session.servers}, каналов: ${session.channels}`;
          document.getElementById("login-status").textContent = "вход выполнен";
        } else {
          box.textContent = "Вход не выполнен.";
        }
      }

      document.getElementById("login").onclick = async () => {
        const token = document.getElementById("token").value.trim();
        if (!token) return log("нужен токен", "warn");
        document.getElementById("login-status").textContent = "проверяю…";
        const user = await call("login_with_token", { token });
        if (user) {
          log(`вошли как ${user.username}#${user.discriminator}`, "ok");
          document.getElementById("token").value = "";
          document.getElementById("login-status").textContent = "вход выполнен";
          await refreshSession();
        }
      };

      document.getElementById("logout").onclick = async () => {
        await call("logout");
        try { localStorage.removeItem("stoat.session.token"); } catch {}
        setConn("", "не подключено");
        log("вышли из аккаунта", "ok");
        goto("login.html");
      };

      document.getElementById("back-to-login").onclick = () => {
        goto("login.html");
      };

      document.getElementById("connect").onclick = async () => {
        setConn("warn", "подключаюсь…");
        await call("connect_gateway");
      };

      document.getElementById("load").onclick = async () => {
        const channel = document.getElementById("channel").value.trim();
        if (!channel) return log("укажите id канала", "warn");
        const messages = await call("fetch_messages", { channelId: channel, limit: 50 });
        if (messages) log(`история: ${messages.length} сообщений`, "ok");
      };

      document.getElementById("send").onclick = async () => {
        const channel = document.getElementById("channel").value.trim();
        const content = document.getElementById("message").value.trim();
        if (!channel || !content) return log("нужны канал и текст", "warn");
        const sent = await call("send_message", { channelId: channel, content });
        if (sent) {
          log(`отправлено в ${channel}: ${sent.content}`, "ok");
          document.getElementById("message").value = "";
        }
      };

      (async function init() {
        log(invoke ? "ядро подключено" : "нет моста Tauri: интерфейс в режиме макета", invoke ? "ok" : "err");

        // без активной сессии показываем форму входа
        if (invoke) {
          try {
            const session = await call("session_state");
            if (session && !session.logged_in) {
              await goto("login.html");
              return;
            }
          } catch { /* продолжаем, покажем макет */ }
        }

        await refreshInstance();
        await refreshSession();
        const dir = await call("data_dir");
        if (dir) document.getElementById("datadir").textContent = dir;

        if (listen) {
          await listen("stoat:gateway", (event) => {
            let parsed;
            try {
              parsed = JSON.parse(event.payload);
            } catch {
              return log(`событие: ${event.payload}`);
            }
            if (parsed.type === "Ready") {
              setConn("ok", "подключено");
              return log("gateway: Ready — состояние получено", "ok");
            }
            if (parsed.type === "Error") {
              setConn("err", "ошибка авторизации");
              return log(`gateway: ${parsed.kind || JSON.stringify(parsed)}`, "err");
            }
            if (parsed.type === "Message") {
              return log(`сообщение в ${parsed.channel}: ${parsed.content || ""}`);
            }
            log(`gateway: ${parsed.type}`);
          });
        }
      })();
