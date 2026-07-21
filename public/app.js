const elements = {
  health: document.querySelector("#health"),
  accountCount: document.querySelector("#account-count"),
  runningCount: document.querySelector("#running-count"),
  groupCount: document.querySelector("#group-count"),
  queuedCount: document.querySelector("#queued-count"),
  reviewCount: document.querySelector("#review-count"),
  llmQueuedCount: document.querySelector("#llm-queued-count"),
  llmTokenCount: document.querySelector("#llm-token-count"),
  llmBudgetStatus: document.querySelector("#llm-budget-status"),
  llmRuns: document.querySelector("#llm-runs"),
  llmRunsEmpty: document.querySelector("#llm-runs-empty"),
  agentStatus: document.querySelector("#agent-status"),
  testLlm: document.querySelector("#test-llm"),
  accounts: document.querySelector("#accounts"),
  accountsEmpty: document.querySelector("#accounts-empty"),
  groups: document.querySelector("#groups"),
  groupsEmpty: document.querySelector("#groups-empty"),
  templates: document.querySelector("#templates"),
  templatesEmpty: document.querySelector("#templates-empty"),
  decisions: document.querySelector("#decisions"),
  decisionsEmpty: document.querySelector("#decisions-empty"),
  scans: document.querySelector("#scans"),
  scansEmpty: document.querySelector("#scans-empty"),
  audit: document.querySelector("#audit"),
  auditEmpty: document.querySelector("#audit-empty"),
  notice: document.querySelector("#notice"),
  accountForm: document.querySelector("#account-form"),
  groupForm: document.querySelector("#group-form"),
  templateForm: document.querySelector("#template-form"),
  groupAccount: document.querySelector("#group-account"),
  refresh: document.querySelector("#refresh"),
  accountTemplate: document.querySelector("#account-template"),
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

function showNotice(message, isError = false) {
  elements.notice.textContent = message;
  elements.notice.classList.toggle("error", isError);
  elements.notice.classList.remove("hidden");
  window.setTimeout(() => elements.notice.classList.add("hidden"), 7000);
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
  elements.accountsEmpty.classList.toggle("hidden", accounts.length > 0);
  elements.accountCount.textContent = String(accounts.length);
  elements.runningCount.textContent = String(accounts.filter((entry) => entry.running).length);
  elements.groupAccount.replaceChildren();

  for (const entry of accounts) {
    const option = document.createElement("option");
    option.value = entry.account.id;
    option.textContent = entry.account.label;
    elements.groupAccount.append(option);

    const fragment = elements.accountTemplate.content.cloneNode(true);
    const card = fragment.querySelector(".account-card");
    card.dataset.accountId = entry.account.id;
    fragment.querySelector(".account-label").textContent = entry.account.label;
    fragment.querySelector(".account-meta").textContent = `${entry.account.id} · ${entry.account.camofoxUserId}`;
    const state = fragment.querySelector(".session-state");
    const authFailure = ["login_required", "checkpoint", "blocked"].includes(entry.account.authState);
    state.classList.add(entry.running && !authFailure ? "online" : entry.error || authFailure ? "offline" : "");
    fragment.querySelector(".state-label").textContent = !entry.account.enabled
      ? `Konto wyłączone · ${entry.account.authState}`
      : entry.error
        ? "Błąd połączenia"
        : entry.running
          ? `Aktywna · ${entry.tabs.length} kart · ${entry.account.authState}`
          : `Zatrzymana · ${entry.account.authState}`;
    const diagnostics = fragment.querySelector(".account-diagnostics");
    diagnostics.append(
      node("p", "muted", `Ostatnia kontrola: ${formatDate(entry.account.lastInspectedAt)}`),
    );
    if (entry.account.recoveryRequired) {
      diagnostics.append(node("p", "error-text", "Wymagane jawne odzyskanie po poprawnym logowaniu."));
    }
    if (entry.account.disabledReason) {
      diagnostics.append(node("p", "error-text", `Powód wyłączenia: ${entry.account.disabledReason}`));
    }
    if (entry.account.lastAuthError && entry.account.lastAuthError !== entry.account.disabledReason) {
      diagnostics.append(node("p", "error-text", `Ostatni błąd logowania: ${entry.account.lastAuthError}`));
    }
    if (entry.account.recoveredAt) {
      diagnostics.append(node("p", "muted", `Odzyskano: ${formatDate(entry.account.recoveredAt)}`));
    }
    fragment.querySelector('[data-action="toggle"]').textContent = entry.account.enabled
      ? "Wyłącz konto"
      : "Włącz konto";
    fragment.querySelector(".tab-list").textContent = entry.error
      ? entry.error
      : entry.tabs.map((tab) => tab.url ?? tab.id).join("\n");
    elements.accounts.append(fragment);
  }
  elements.groupForm.querySelector("button").disabled = accounts.length === 0;
}

function renderGroups(groups, accounts) {
  elements.groups.replaceChildren();
  elements.groupsEmpty.classList.toggle("hidden", groups.length > 0);
  elements.groupCount.textContent = String(groups.filter((group) => group.enabled).length);
  for (const group of groups) {
    const card = node("article", "group-card card");
    card.dataset.groupId = group.id;
    const heading = node("div", "group-heading");
    const title = node("div");
    title.append(node("h3", "", group.name), node("p", "account-meta", `${group.accountId} · co ${Math.round(group.scanIntervalSeconds / 60)} min`));
    const state = node("span", `badge ${statusClass(group.lastStatus)}`, group.lastStatus);
    const extraction = node(
      "span",
      `badge ${extractionStatusClass(group.extractionHealth)}`,
      `ekstrakcja: ${group.extractionHealth}`,
    );
    const badges = node("div", "group-badges");
    badges.append(state, extraction);
    heading.append(title, badges);
    const url = node("a", "group-url", group.url);
    url.href = group.url;
    url.target = "_blank";
    url.rel = "noopener noreferrer";
    const details = node(
      "p",
      "muted",
      `Następny skan: ${formatDate(group.nextScanAt)} · limit ${group.maxPostsPerScan} postów · ` +
        `ekstraktor ${group.extractorVersion ?? "—"} · puste skany ${group.emptyScanStreak}`,
    );
    const error = group.lastError ? node("p", "error-text", group.lastError) : null;
    const extractionWarning = group.extractionHealth === "suspected_drift"
      ? node("p", "error-text", "Możliwy drift DOM Facebooka lub dłuższy brak nowych postów: co najmniej 3 zakończone, zalogowane skany były puste po wcześniejszej udanej ekstrakcji.")
      : group.extractionHealth === "error"
        ? node("p", "error-text", "Ostatnia próba ekstrakcji zakończyła się błędem. Sprawdź diagnostykę skanu.")
        : null;
    const actions = node("div", "account-actions");
    actions.append(
      actionButton("scan", "Skanuj teraz"),
      actionButton("toggle", group.enabled ? "Wyłącz" : "Włącz", "secondary"),
      actionButton("remove", "Usuń", "danger ghost"),
    );
    const transfer = node("div", "group-transfer");
    const target = document.createElement("select");
    target.dataset.role = "account-target";
    target.setAttribute("aria-label", "Konto docelowe dla grupy");
    for (const entry of accounts) {
      const option = document.createElement("option");
      option.value = entry.account.id;
      option.textContent = `${entry.account.label}${entry.account.enabled ? "" : " (wyłączone)"}`;
      option.selected = entry.account.id === group.accountId;
      target.append(option);
    }
    transfer.append(target, actionButton("move", "Przenieś grupę", "secondary"));
    card.append(heading, url, details);
    if (error) card.append(error);
    if (extractionWarning) card.append(extractionWarning);
    card.append(transfer, actions);
    elements.groups.append(card);
  }
}

function renderTemplates(templates) {
  elements.templates.replaceChildren();
  elements.templatesEmpty.classList.toggle("hidden", templates.length > 0);
  for (const template of templates) {
    const card = node("article", "group-card card");
    card.dataset.templateId = template.id;
    const heading = node("div", "group-heading");
    heading.append(
      node("div", "", template.name),
      node("span", `badge ${template.enabled ? "success" : "neutral"}`, template.category),
    );
    card.append(
      heading,
      node("p", "post-content", template.body),
      node("p", "muted", template.llmInstruction || "Bez dodatkowej instrukcji LLM"),
    );
    const actions = node("div", "account-actions");
    actions.append(
      actionButton("toggle", template.enabled ? "Wyłącz" : "Włącz", "secondary"),
      actionButton("remove", "Usuń", "danger ghost"),
    );
    card.append(actions);
    elements.templates.append(card);
  }
}

function renderDecisions(decisions, posts, groups, drafts) {
  const postMap = new Map(posts.map((post) => [post.id, post]));
  const groupMap = new Map(groups.map((group) => [group.id, group]));
  const draftMap = new Map(drafts.map((draft) => [draft.decisionId, draft]));
  const review = decisions.filter((decision) => decision.status === "review");
  elements.decisions.replaceChildren();
  elements.decisionsEmpty.classList.toggle("hidden", review.length > 0);
  elements.reviewCount.textContent = String(review.length);
  for (const decision of review) {
    const post = postMap.get(decision.postId);
    const card = node("article", "feed-card card");
    const label = groupMap.get(post?.groupId)?.name ?? "Nieznana grupa";
    card.append(
      node("p", "eyebrow", `${label} · ${Math.round(decision.confidence * 100)}%`),
      node("h3", "", decision.category),
      node("p", "post-content", post?.content ?? "Treść posta niedostępna"),
      node("p", "muted", decision.reason),
    );
    const draft = draftMap.get(decision.id);
    if (draft) {
      card.append(
        node("p", "eyebrow", "ROBOCZA ODPOWIEDŹ — NIEOPUBLIKOWANA"),
        node("p", "post-content", draft.text),
        node("p", "muted", `${draft.model} · ${draft.latencyMs} ms`),
      );
    } else {
      card.append(node("p", "muted", "Brak wersji roboczej — dodaj aktywny szablon kategorii."));
    }
    if (post?.url) {
      const link = node("a", "group-url", "Przejdź do posta");
      link.href = post.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      card.append(link);
    }
    elements.decisions.append(card);
  }
}

function renderScans(scans, groups) {
  const groupMap = new Map(groups.map((group) => [group.id, group]));
  elements.scans.replaceChildren();
  elements.scansEmpty.classList.toggle("hidden", scans.length > 0);
  for (const scan of scans.slice(0, 20)) {
    const card = node("article", "feed-card compact card");
    card.append(
      node("div", "scan-line", `${groupMap.get(scan.groupId)?.name ?? scan.groupId} · ${scan.status}`),
      node("p", "muted", `${formatDate(scan.startedAt)} · widziane ${scan.postsSeen}, nowe ${scan.postsNew}, decyzje ${scan.decisionsCreated}`),
    );
    if (scan.extractorVersion) {
      card.append(node(
        "p",
        "muted",
        `${scan.extractorVersion} · auth ${scan.extractionAuthState ?? "—"} · ` +
          `snapshoty ${scan.snapshotChecks} · przewinięcia ${scan.scrollRounds} · błędy strony ${scan.pageErrorCount}`,
      ));
    }
    if (scan.extractionErrorCategory) {
      card.append(node("p", "error-text", `Błąd ekstraktora: ${scan.extractionErrorCategory}`));
    }
    if (scan.error) card.append(node("p", "error-text", scan.error));
    elements.scans.append(card);
  }
}

function renderLlmRuns(runs, queue, configured, replayEnabled) {
  elements.llmRuns.replaceChildren();
  elements.llmRunsEmpty.classList.toggle("hidden", runs.length > 0);
  elements.llmQueuedCount.textContent = String(queue.queued + queue.running);
  elements.llmTokenCount.textContent = Number(queue.tokensToday).toLocaleString("pl-PL");
  elements.llmBudgetStatus.textContent = configured
    ? `aktywne ${queue.running} · błędy ${queue.failed} · pominięte przez budżet ${queue.skippedBudget}`
    : "LLM nie jest skonfigurowany";
  for (const run of runs.slice(0, 30)) {
    const card = node("article", "feed-card compact card");
    card.dataset.llmRunId = run.id;
    const heading = node("div", "group-heading");
    heading.append(
      node("div", "scan-line", `${run.operation} · ${run.promptVersion}`),
      node("span", `badge ${statusClass(run.status)}`, run.status),
    );
    card.append(
      heading,
      node("p", "muted", `${run.model} · próba ${run.attempts}/${run.maxAttempts} · rezerwa ${run.reservedTokens} tokenów`),
      node("p", "muted", `wejście ${run.inputTokens ?? "—"} · wyjście ${run.outputTokens ?? "—"} · ${run.latencyMs ?? "—"} ms`),
    );
    if (run.errorCategory || run.error) {
      card.append(node("p", "error-text", `${run.errorCategory ?? "błąd"}: ${run.error ?? "brak szczegółów"}`));
    }
    if (replayEnabled && (run.status === "failed" || run.status === "skipped_budget")) {
      const actions = node("div", "account-actions");
      actions.append(actionButton("replay", "Ponów operację", "secondary"));
      card.append(actions);
    }
    elements.llmRuns.append(card);
  }
}

function renderAudit(events) {
  elements.audit.replaceChildren();
  elements.auditEmpty.classList.toggle("hidden", events.length > 0);
  for (const event of events.slice(0, 50)) {
    const card = node("article", "feed-card compact card");
    card.append(
      node("div", "scan-line", `${event.type} · ${event.entityType} · ${event.entityId}`),
      node("p", "muted", formatDate(event.createdAt)),
    );
    if (event.detail) card.append(node("p", "muted", event.detail));
    elements.audit.append(card);
  }
}

function node(tag, className = "", text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function actionButton(action, label, className = "") {
  const button = node("button", className, label);
  button.type = "button";
  button.dataset.action = action;
  return button;
}

function statusClass(status) {
  return status === "succeeded"
    ? "success"
    : status === "failed" || status === "auth_required" || status === "skipped_budget"
      ? "failure"
      : "neutral";
}

function extractionStatusClass(status) {
  if (status === "healthy") return "success";
  if (status === "suspected_drift" || status === "error") return "failure";
  return "neutral";
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString("pl-PL") : "—";
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  elements.refresh.disabled = true;
  try {
    const overview = await api("/api/overview");
    setHealth(overview.health);
    renderAccounts(overview.accounts);
    renderGroups(overview.groups, overview.accounts);
    renderTemplates(overview.responseTemplates);
    renderDecisions(
      overview.recentDecisions,
      overview.recentPosts,
      overview.groups,
      overview.responseDrafts,
    );
    renderScans(overview.recentScans, overview.groups);
    renderLlmRuns(
      overview.recentLlmRuns,
      overview.llmQueue,
      overview.llm.configured,
      overview.llmReplayEnabled,
    );
    renderAudit(overview.recentAudit);
    elements.queuedCount.textContent = String(overview.monitoring.queuedJobs);
    elements.agentStatus.textContent = `${overview.worker.running ? "worker on" : "worker off"} · ${overview.llm.configured ? overview.llm.model : "LLM off"}`;
    elements.testLlm.disabled = !overview.llm.configured;
  } catch (error) {
    if (String(error.message).includes("token")) elements.authCard.classList.remove("hidden");
    setHealth({ ok: false, error: error.message });
  } finally {
    refreshing = false;
    elements.refresh.disabled = false;
  }
}

async function runAccountAction(accountId, action) {
  if (action === "remove") {
    if (!window.confirm(`Usunąć wpis ${accountId}? Trwały profil Camofox pozostanie na dysku.`)) return;
    await api(`/api/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE" });
    showNotice(`Usunięto wpis ${accountId}.`);
    return;
  }
  if (action === "rename") {
    const label = window.prompt("Nowa nazwa konta:");
    if (label === null) return;
    await api(`/api/accounts/${encodeURIComponent(accountId)}`, {
      method: "PATCH",
      body: JSON.stringify({ label }),
    });
    showNotice("Nazwa konta została zmieniona.");
    return;
  }
  if (action === "recover") {
    const result = await api(`/api/accounts/${encodeURIComponent(accountId)}/recover`, {
      method: "POST",
      body: "{}",
    });
    showNotice(`Konto odzyskane. Stan Facebook: ${result.inspection.state}.`);
    return;
  }
  if (action === "inspect") {
    const result = await api(`/api/accounts/${encodeURIComponent(accountId)}/facebook-status`, {
      method: "POST",
      body: "{}",
    });
    showNotice(`Stan Facebook: ${result.state}. ${result.reason}`, result.state !== "authenticated");
    return;
  }
  if (action === "enable" || action === "disable") {
    await api(`/api/accounts/${encodeURIComponent(accountId)}/enabled`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: action === "enable" }),
    });
    showNotice(action === "enable" ? "Konto włączone." : "Konto wyłączone.");
    return;
  }
  const routes = {
    open: `/api/accounts/${encodeURIComponent(accountId)}/session/open`,
    login: `/api/accounts/${encodeURIComponent(accountId)}/login/start`,
    finish: `/api/accounts/${encodeURIComponent(accountId)}/login/finish`,
    stop: `/api/accounts/${encodeURIComponent(accountId)}/session/stop`,
  };
  const viewer = action === "login" ? window.open("about:blank", "_blank") : null;
  try {
    const result = await api(routes[action], { method: "POST", body: "{}" });
    if (action === "login") {
      if (result.viewerUrl && viewer) {
        viewer.location.href = result.viewerUrl;
        showNotice("Otwarto noVNC. Zaloguj konto, a następnie zakończ logowanie.");
      } else {
        viewer?.close();
        showNotice("Camofox nie zwrócił adresu noVNC.", true);
      }
    } else showNotice(`Operacja „${action}” zakończona.`);
  } catch (error) {
    viewer?.close();
    throw error;
  }
}

elements.accounts.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  button.disabled = true;
  try {
    const action = button.dataset.action === "toggle"
      ? (button.textContent === "Wyłącz konto" ? "disable" : "enable")
      : button.dataset.action;
    await runAccountAction(button.closest(".account-card").dataset.accountId, action);
    await refresh();
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    button.disabled = false;
  }
});

elements.groups.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const card = button.closest(".group-card");
  const groupId = card.dataset.groupId;
  button.disabled = true;
  try {
    if (button.dataset.action === "scan") {
      await api(`/api/groups/${encodeURIComponent(groupId)}/scan`, { method: "POST", body: "{}" });
      showNotice("Skan dodano do kolejki.");
    } else if (button.dataset.action === "toggle") {
      const isEnabled = button.textContent === "Wyłącz";
      await api(`/api/groups/${encodeURIComponent(groupId)}/enabled`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !isEnabled }),
      });
    } else if (button.dataset.action === "move") {
      const accountId = card.querySelector('[data-role="account-target"]').value;
      await api(`/api/groups/${encodeURIComponent(groupId)}/account`, {
        method: "PATCH",
        body: JSON.stringify({ accountId }),
      });
      showNotice("Grupa została przypisana do wybranego konta; aktywne joby zostały bezpiecznie zakończone.");
    } else if (button.dataset.action === "remove") {
      if (!window.confirm("Usunąć grupę wraz z historią postów i skanów?")) return;
      await api(`/api/groups/${encodeURIComponent(groupId)}`, { method: "DELETE" });
    }
    await refresh();
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    button.disabled = false;
  }
});

elements.templates.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const templateId = button.closest(".group-card").dataset.templateId;
  button.disabled = true;
  try {
    if (button.dataset.action === "toggle") {
      await api(`/api/response-templates/${encodeURIComponent(templateId)}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: button.textContent === "Włącz" }),
      });
    } else if (button.dataset.action === "remove") {
      if (!window.confirm("Usunąć szablon? Istniejące wersje robocze zachowają treść.")) return;
      await api(`/api/response-templates/${encodeURIComponent(templateId)}`, { method: "DELETE" });
    }
    await refresh();
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    button.disabled = false;
  }
});

elements.llmRuns.addEventListener("click", async (event) => {
  const button = event.target.closest('button[data-action="replay"]');
  if (!button) return;
  const runId = button.closest("[data-llm-run-id]").dataset.llmRunId;
  if (!window.confirm("Ponowić tę operację LLM? Zostanie ponownie sprawdzona pod kątem budżetu i aktualności danych.")) return;
  button.disabled = true;
  try {
    await api(`/api/llm-runs/${encodeURIComponent(runId)}/replay`, {
      method: "POST",
      body: "{}",
    });
    showNotice("Operacja LLM wróciła do trwałej kolejki.");
    await refresh();
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    button.disabled = false;
  }
});

elements.accountForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(elements.accountForm);
  try {
    await api("/api/accounts", { method: "POST", body: JSON.stringify({ id: data.get("id"), label: data.get("label") }) });
    elements.accountForm.reset();
    showNotice("Konto dodane. Rozpocznij logowanie noVNC.");
    await refresh();
  } catch (error) { showNotice(error.message, true); }
});

elements.groupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(elements.groupForm);
  try {
    await api("/api/groups", {
      method: "POST",
      body: JSON.stringify({
        accountId: data.get("accountId"),
        name: data.get("name"),
        url: data.get("url"),
        scanIntervalSeconds: Number(data.get("intervalMinutes")) * 60,
        maxPostsPerScan: Number(data.get("maxPosts")),
        promptContext: data.get("promptContext"),
      }),
    });
    elements.groupForm.reset();
    showNotice("Grupa dodana i zaplanowana do skanowania.");
    await refresh();
  } catch (error) { showNotice(error.message, true); }
});

elements.templateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(elements.templateForm);
  try {
    await api("/api/response-templates", {
      method: "POST",
      body: JSON.stringify({
        name: data.get("name"),
        category: data.get("category"),
        body: data.get("body"),
        llmInstruction: data.get("llmInstruction"),
      }),
    });
    elements.templateForm.reset();
    showNotice("Szablon odpowiedzi dodany.");
    await refresh();
  } catch (error) { showNotice(error.message, true); }
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
    showNotice(`LLM odpowiada: ${result.text} · ${result.model} · ${result.latencyMs} ms`);
  } catch (error) { showNotice(error.message, true); }
  finally { elements.testLlm.disabled = false; }
});

const publicConfig = await api("/api/public-config");
elements.authCard.classList.toggle("hidden", !publicConfig.tokenRequired || Boolean(token));
await refresh();
window.setInterval(refresh, 15_000);
