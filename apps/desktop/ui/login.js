      // Мост Tauri. Он есть только если у окна включён withGlobalTauri —
      // без него любой вызов молча падал бы и форма выглядела «мёртвой».
      const bridge = window.__TAURI__;
      const invoke = bridge && bridge.core && bridge.core.invoke;

      const msg = document.getElementById("msg");
      const formPassword = document.getElementById("form-password");
      const formMfa = document.getElementById("form-mfa");
      const btnPassword = document.getElementById("submit-password");
      const btnMfa = document.getElementById("submit-mfa");
      const mfaLabel = document.getElementById("mfa-label");
      const mfaHint = document.getElementById("mfa-hint");
      const mfaValue = document.getElementById("mfa-value");
      const remember = document.getElementById("remember");

      let ticket = null;
      let methods = [];

      const METHOD_TITLES = {
        Totp: /* i18n */ "Code from your authenticator app",
        Password: /* i18n */ "Account password",
        Recovery: /* i18n */ "Recovery Code",
      };
      const METHOD_PLACEHOLDERS = {
        Totp: "000000",
        Password: /* i18n */ "account password",
        Recovery: "xxxx-xxxx-xxxx",
      };
      // как поле называется в ядре
      const METHOD_NAMES = { Totp: "totp", Password: "password", Recovery: "recovery" };

      function setMsg(text, kind = "") {
        msg.className = "msg " + kind;
        msg.textContent = text || "";
      }

      function busy(button, on, text) {
        button.disabled = on;
        button.textContent = "";
        if (on) {
          const spin = document.createElement("span");
          spin.className = "spinner";
          button.appendChild(spin);
        }
        button.appendChild(document.createTextNode(text));
      }

      // Достаём из ошибки команды её вид: ядро кладёт его в message
      // («API вернул ошибку InvalidCredentials: …») или в само поле kind.
      const KNOWN_CODES = [
        "InvalidCredentials", "AccountDisabled", "EmailNotVerified", "Banned",
        "RateLimited", "Unauthorized", "MissingPermission", "NotFound",
      ];

      function errorKind(error) {
        const text = String(
          (error && (error.message || error.kind || error)) || ""
        );
        // сначала ищем точный код API в тексте: поле kind может содержать
        // лишь общий вид ошибки («api»), и тогда причина потерялась бы
        for (const code of KNOWN_CODES) {
          if (text.includes(code)) return code;
        }
        const direct = error && error.kind;
        if (typeof direct === "string" && direct && !direct.includes(" ")) return direct;
        return "";
      }

      function describe(error) {
        const kind = errorKind(error).toLowerCase();
        const text = String((error && (error.message || error)) || "");
        if (kind === "invalidcredentials") return t("Wrong email or password. Check your keyboard layout and Caps Lock.");
        if (kind === "accountdisabled") return t("The account is disabled. Contact Stoat support.");
        if (kind === "emailnotverified") return t("Your email is not verified — check the message from Stoat.");
        if (kind === "banned") return t("The account is banned.");
        if (kind === "ratelimited") return t("Too many attempts. Wait a minute and try again.");
        if (kind === "network") return t("Cannot reach the Stoat server. Check your internet connection or VPN.");
        if (text.includes("network") || text.includes("сетевая")) return t("Cannot reach the Stoat server. Check your internet connection or VPN.");
        if (text.includes("MFA") || text.includes("mfa")) return t("The code did not match. Check it and try again.");
        return text || t("Unknown error.");
      }

      // Основной способ сменить экран: через Tauri. Если по какой-то причине
      // не вышло — обычный переход, он может быть запрещён политикой CSP.
      async function openClient() {
        const setLocation = bridge && bridge.webviewWindow && bridge.webviewWindow.getCurrentWebviewWindow;
        if (setLocation) {
          try {
            const current = bridge.webviewWindow.getCurrentWebviewWindow();
            await current.navigate("app.html");
            return;
          } catch (error) {
            console.warn("навигация через Tauri не удалась:", error);
          }
        }
        location.replace("app.html");
      }

      async function init() {
        if (!invoke) {
          setMsg(t("No connection to the application core (the Tauri bridge is unavailable). This is a build error, not a problem with your data — please report it."), "err");
          document.getElementById("instance-info").textContent = t("core unavailable");
          btnPassword.disabled = true;
          return;
        }

        try {
          const info = await invoke("instance_info");
          document.getElementById("instance-name").textContent = info.name || "stoat.chat";
          document.getElementById("instance-info").textContent =
            t("instance: {0}", [info.api_url + (info.version ? " · API " + info.version : "")]);
        } catch (error) {
          document.getElementById("instance-info").textContent =
            t("instance unavailable — check your internet connection");
        }

        // сессия уже есть — сразу в клиент
        try {
          const session = await invoke("session_state");
          if (session && session.logged_in) return openClient();
        } catch { /* первый запуск */ }

        // запомненная сессия: входим без формы (кроме «Сменить аккаунт»)
        const saved = readSession();
        if (saved && !new URLSearchParams(location.search).has("switch")) {
          setMsg(t("Restoring session…"));
          btnPassword.disabled = true;
          try {
            await invoke("login_with_token", { token: saved.token, sessionId: saved.id || null });
            setMsg(t("Logged in. Opening the client…"), "ok");
            setTimeout(openClient, 300);
          } catch (error) {
            const kind = errorKind(error).toLowerCase();
            // сессию завершили — забываем её; сеть или сервер — просто показываем
            if (kind === "unauthorized" || kind === "invalidsession") forgetSession();
            setMsg(t("Could not restore the session: {0}", [describe(error)]), "warn");
          } finally {
            btnPassword.disabled = false;
          }
        }
      }

      function readSession() {
        try {
          const token = localStorage.getItem("stoat.session.token");
          return token ? { token, id: localStorage.getItem("stoat.session.id") } : null;
        } catch {
          return null;
        }
      }

      function rememberSession(token, id) {
        try {
          localStorage.setItem("stoat.session.token", token);
          if (id) localStorage.setItem("stoat.session.id", id);
          else localStorage.removeItem("stoat.session.id");
        } catch { /* хранилище недоступно */ }
      }

      function forgetSession() {
        try {
          localStorage.removeItem("stoat.session.token");
          localStorage.removeItem("stoat.session.id");
        } catch { /* хранилище недоступно */ }
      }

      function showMfa(step) {
        ticket = step.ticket;
        methods = step.methods || [];
        const method = methods[0] || "Totp";
        mfaLabel.textContent = t(METHOD_TITLES[method] || /* i18n */ "Verification code");
        mfaValue.placeholder = t(METHOD_PLACEHOLDERS[method] || /* i18n */ "code");
        mfaValue.type = method === "Password" ? "password" : "text";
        mfaValue.inputMode = method === "Totp" ? "numeric" : "text";
        mfaValue.value = "";
        mfaHint.textContent =
          methods.length > 1
            ? t("Available: {0}", [methods.map((m) => (METHOD_TITLES[m] ? t(METHOD_TITLES[m]) : m)).join(", ")])
            : t("Enter: {0}.", [t(METHOD_TITLES[method] || /* i18n */ "code").toLowerCase()]);
        formPassword.classList.add("hidden");
        formMfa.classList.remove("hidden");
        setMsg(t("The account is protected by a second factor."), "warn");
        mfaValue.focus();
      }

      function onSuccess(result) {
        setMsg(t("Logged in. Opening the client…"), "ok");
        if (result && result.token && remember.checked) rememberSession(result.token, result.session_id);
        else forgetSession();
        // Окно переключает сам Rust сразу после ответа; это лишь запасной путь.
        setTimeout(openClient, 600);
      }

      formPassword.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!invoke) return;

        const email = document.getElementById("email").value.trim();
        const password = document.getElementById("password").value;

        busy(btnPassword, true, t("Logging in…"));
        setMsg("");
        try {
          const step = await invoke("login_password", { email, password });
          if (step.status === "Success") onSuccess(step);
          else if (step.status === "Mfa") showMfa(step);
          else if (step.status === "Disabled") setMsg(t("The account is disabled. Contact Stoat support."), "err");
        } catch (error) {
          console.error("вход не удался:", error);
          setMsg(describe(error), "err");
        } finally {
          busy(btnPassword, false, t("Log in"));
        }
      });

      formMfa.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!invoke || !ticket) return;

        const value = mfaValue.value.trim();
        if (!value) return setMsg(t("Enter the verification code."), "warn");

        const method = METHOD_NAMES[methods[0] || "Totp"] || "totp";

        busy(btnMfa, true, t("Checking…"));
        try {
          const step = await invoke("login_mfa", { ticket, method, value });
          if (step.status === "Success") onSuccess(step);
          else if (step.status === "Mfa") showMfa(step);
          else if (step.status === "Disabled") setMsg(t("The account is disabled."), "err");
        } catch (error) {
          console.error("второй фактор не принят:", error);
          setMsg(describe(error), "err");
        } finally {
          busy(btnMfa, false, t("Confirm"));
        }
      });

      document.getElementById("mfa-back").addEventListener("click", () => {
        ticket = null;
        formMfa.classList.add("hidden");
        formPassword.classList.remove("hidden");
        mfaValue.value = "";
        setMsg("");
        document.getElementById("password").focus();
      });

      document.getElementById("submit-token").addEventListener("click", async () => {
        if (!invoke) return;
        const token = document.getElementById("token").value.trim();
        if (!token) return setMsg(t("A token is required."), "warn");

        const button = document.getElementById("submit-token");
        busy(button, true, t("Checking…"));
        try {
          const user = await invoke("login_with_token", { token, sessionId: null });
          setMsg(t("Logged in as {0}", [user.username + "#" + user.discriminator]), "ok");
          if (remember.checked) rememberSession(token, null);
          else forgetSession();
          setTimeout(openClient, 600);
        } catch (error) {
          console.error("вход по токену не удался:", error);
          setMsg(describe(error), "err");
        } finally {
          busy(button, false, t("Log in with token"));
        }
      });

      // переводы нужны до первых сообщений формы
      window.I18N.ready.then(init);
