const elements = {
  health: document.querySelector("#health"),
  accountCount: document.querySelector("#account-count"),
  runningCount: document.querySelector("#running-count"),
  llmStatus: document.querySelector("#llm-status"),
  testLlm: document.querySelector("#test-llm"),
  refreshedAt: document.querySelector("#refreshed-at"),
  accounts: document.querySelector("#accounts"),
  empty: document.querySelector("#empty"),
  notice: document.querySelector("#notice"),
  accountForm: document.querySelector("#account-form"),
  refresh: document.querySelector("#refresh"),
  template: document.querySelector("#account-template"),
  authCard: document.querySelector("#auth-card"),
  tokenForm: document.querySelector("#token-form"),
  token: document.querySelector("#token"),
};

let token = sessionStorage.getItem("panelApiToken") ?? "";
let refreshing = false;

async function api(path, options = {}) {
  const headers = new Headers(options.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (options.method && options.method !== "GET") headers.set("x-agent-request", "panel");
  if (options.body) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

function notice(message, isError = false) {
  elements.notice.textContent = message;
  elements.notice.classList.toggle("error", isError);
  elements.notice.classList.remove("hidden");
  window.setTimeout(() => elements.notice.classList.add("hidden"), 6000);
}

function setHealth(health) {
  const online = health.ok === true;
  elements.health.className = `health ${online ? "online" : "offline"}`;
  elements.health.querySelector("span:last-child").textContent = online
    ? `Camofox ${health.engine ?? "online"}`
    : health.error ?? "Camofox offline";
}

function renderAccounts(accounts) {
  elements.accounts.replaceChildren();
  elements.empty.classList.toggle("hidden", accounts.length > 0);
  elements.accountCount.textContent = String(accounts.length);
  elements.runningCount.textContent = String(accounts.filter((entry) => entry.running).length);

  for (const entry of accounts) {
    const fragment = elements.template.content.cloneNode(true);
    const card = fragment.querySelector(".account-card");
    card.dataset.accountId = entry.account.id;
    fragment.querySelector(".account-label").textContent = entry.account.label;
    fragment.querySelector(".account-meta").textContent = `${entry.account.id} · ${entry.account.camofoxUserId}`;
    const state = fragment.querySelector(".session-state");
    state.classList.add(entry.running ? "online" : entry.error ? "offline" : "");
    fragment.querySelector(".state-label").textContent = entry.error
      ? "Błąd połączenia"
      : entry.running
        ? `Aktywna · ${entry.tabs.length} kart`
        : "Zatrzymana";
    const tabs = fragment.querySelector(".tab-list");
    tabs.textContent = entry.error
      ? entry.error
      : entry.tabs.map((tab) => tab.url ?? tab.id).join("\n");
    elements.accounts.append(fragment);
  }
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  elements.refresh.disabled = true;
  try {
    const overview = await api("/api/overview");
    setHealth(overview.health);
    renderAccounts(overview.accounts);
    elements.llmStatus.textContent = overview.llm.configured
      ? `${overview.llm.model} · ${overview.llm.format}`
      : "Nie skonfigurowano";
    elements.testLlm.disabled = !overview.llm.configured;
    elements.refreshedAt.textContent = new Date(overview.refreshedAt).toLocaleTimeString("pl-PL");
  } catch (error) {
    if (String(error.message).includes("token")) elements.authCard.classList.remove("hidden");
    setHealth({ ok: false, error: error.message });
  } finally {
    refreshing = false;
    elements.refresh.disabled = false;
  }
}

async function runAction(accountId, action) {
  const routes = {
    open: `/api/accounts/${encodeURIComponent(accountId)}/session/open`,
    login: `/api/accounts/${encodeURIComponent(accountId)}/login/start`,
    finish: `/api/accounts/${encodeURIComponent(accountId)}/login/finish`,
    stop: `/api/accounts/${encodeURIComponent(accountId)}/session/stop`,
  };

  if (action === "remove") {
    if (!window.confirm(`Usunąć wpis ${accountId}? Trwały profil Camofox pozostanie na dysku.`)) return;
    await api(`/api/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE" });
    notice(`Usunięto wpis ${accountId}.`);
  } else {
    const result = await api(routes[action], { method: "POST", body: "{}" });
    if (action === "login") {
      if (result.viewerUrl) {
        window.open(result.viewerUrl, "_blank", "noopener,noreferrer");
        notice("Otwarto noVNC. Zaloguj konto ręcznie, a następnie wybierz „Zakończ logowanie”.");
      } else {
        notice("Camofox nie zwrócił adresu noVNC.", true);
      }
    } else {
      notice(`Operacja „${action}” zakończona.`);
    }
  }
  await refresh();
}

elements.accounts.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const card = button.closest(".account-card");
  button.disabled = true;
  try {
    await runAction(card.dataset.accountId, button.dataset.action);
  } catch (error) {
    notice(error.message, true);
  } finally {
    button.disabled = false;
  }
});

elements.accountForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(elements.accountForm);
  try {
    await api("/api/accounts", {
      method: "POST",
      body: JSON.stringify({ id: data.get("id"), label: data.get("label") }),
    });
    elements.accountForm.reset();
    notice("Konto zostało dodane. Teraz rozpocznij logowanie noVNC.");
    await refresh();
  } catch (error) {
    notice(error.message, true);
  }
});

elements.tokenForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  token = elements.token.value;
  sessionStorage.setItem("panelApiToken", token);
  elements.authCard.classList.add("hidden");
  await refresh();
});

elements.refresh.addEventListener("click", refresh);
elements.testLlm.addEventListener("click", async () => {
  elements.testLlm.disabled = true;
  try {
    const result = await api("/api/llm/test", { method: "POST", body: "{}" });
    notice(`LLM odpowiada: ${result.text} · ${result.model} · ${result.latencyMs} ms`);
  } catch (error) {
    notice(error.message, true);
  } finally {
    elements.testLlm.disabled = false;
  }
});

const publicConfig = await api("/api/public-config");
elements.authCard.classList.toggle("hidden", !publicConfig.tokenRequired || Boolean(token));
await refresh();
window.setInterval(refresh, 15_000);
