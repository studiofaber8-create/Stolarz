import { timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { CamofoxRequestError } from "./camofox/client.js";
import type { CamofoxTab } from "./camofox/types.js";
import { LlmRequestError } from "./llm/custom-llm-client.js";
import { createServices, type Services } from "./services.js";

interface AccountBody {
  readonly id?: unknown;
  readonly label?: unknown;
}

interface OpenBody {
  readonly url?: unknown;
}

interface GroupBody {
  readonly accountId?: unknown;
  readonly name?: unknown;
  readonly url?: unknown;
  readonly scanIntervalSeconds?: unknown;
  readonly maxPostsPerScan?: unknown;
  readonly promptContext?: unknown;
}

interface EnabledBody {
  readonly enabled?: unknown;
}

interface ResponseTemplateBody {
  readonly name?: unknown;
  readonly category?: unknown;
  readonly body?: unknown;
  readonly llmInstruction?: unknown;
  readonly enabled?: unknown;
}

function tabView(tab: CamofoxTab): object {
  return {
    id: tab.id,
    ...(tab.url === undefined ? {} : { url: tab.url }),
    ...(tab.title === undefined ? {} : { title: tab.title }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasValidToken(request: Request, expectedToken: string): boolean {
  const authorization = request.header("authorization");
  if (!authorization?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(authorization.slice("Bearer ".length));
  const expected = Buffer.from(expectedToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function queryLimit(request: Request, fallback = 100): number {
  const raw = request.query.limit;
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 500) {
    throw new Error("limit must be an integer between 1 and 500");
  }
  return parsed;
}

export function createPanelApp(services: Services = createServices()): express.Express {
  const { config, sessions, llm, store, worker, facebook, logger } = services;
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));

  app.get("/api/public-config", (_request, response) => {
    response.json({ tokenRequired: config.panelApiToken !== undefined });
  });

  app.use("/api", (request: Request, response: Response, next: NextFunction) => {
    if (config.panelApiToken === undefined || hasValidToken(request, config.panelApiToken)) {
      next();
      return;
    }
    response.status(401).json({ error: "Invalid or missing panel API token" });
  });

  app.use("/api", (request: Request, response: Response, next: NextFunction) => {
    const readOnly = request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS";
    if (readOnly || request.header("x-agent-request") === "panel") {
      next();
      return;
    }
    response.status(403).json({ error: "Missing same-origin request marker" });
  });

  app.get("/api/config", (_request, response) => {
    response.json({
      camofoxUrl: config.camofoxUrl,
      dataDir: config.dataDir,
      profilePrefix: config.profilePrefix,
      facebookHomeUrl: config.facebookHomeUrl,
      requestTimeoutMs: config.requestTimeoutMs,
      panelHost: config.panelHost,
      panelPort: config.panelPort,
      camofoxApiKeyConfigured: config.camofoxApiKey !== undefined,
      agent: {
        workerEnabled: config.agent.workerEnabled,
        schedulerIntervalMs: config.agent.schedulerIntervalMs,
        pollIntervalMs: config.agent.pollIntervalMs,
        leaseMs: config.agent.leaseMs,
        reviewThreshold: config.agent.reviewThreshold,
        businessDescription: config.agent.businessDescription,
      },
      llm:
        config.llm === undefined
          ? { configured: false }
          : {
              configured: true,
              apiUrl: config.llm.apiUrl,
              model: config.llm.model,
              format: config.llm.format,
            },
    });
  });

  app.get("/api/health", async (_request, response) => {
    const health = await sessions.health();
    response.status(health.ok ? 200 : 503).json({
      ok: health.ok,
      engine: health.engine,
      browserConnected: health.browserConnected,
      worker: worker.status(),
      monitoring: store.summary(),
    });
  });

  app.get("/api/overview", async (_request, response) => {
    const [healthResult, accountResult] = await Promise.allSettled([
      sessions.health(),
      sessions.statusAll(),
    ]);
    response.json({
      health:
        healthResult.status === "fulfilled"
          ? {
              ok: healthResult.value.ok,
              engine: healthResult.value.engine,
              browserConnected: healthResult.value.browserConnected,
            }
          : { ok: false, error: errorMessage(healthResult.reason) },
      accounts:
        accountResult.status === "fulfilled"
          ? accountResult.value.map((status) => ({
              account: status.account,
              running: status.running,
              tabs: status.tabs.map(tabView),
              ...(status.error === undefined ? {} : { error: status.error }),
            }))
          : [],
      accountsError:
        accountResult.status === "rejected" ? errorMessage(accountResult.reason) : undefined,
      llm:
        llm === undefined ? { configured: false } : { configured: true, ...llm.metadata },
      worker: worker.status(),
      monitoring: store.summary(),
      groups: store.listGroups(),
      recentScans: store.listScanRuns(20),
      recentPosts: store.listPosts(50),
      recentDecisions: store.listDecisions(50),
      responseTemplates: store.listResponseTemplates(),
      responseDrafts: store.listResponseDrafts(50),
      refreshedAt: new Date().toISOString(),
    });
  });

  app.post("/api/llm/test", async (_request, response) => {
    if (llm === undefined) {
      response.status(409).json({ error: "Custom LLM API is not configured" });
      return;
    }
    const result = await llm.testConnection();
    response.json({
      ok: true,
      text: result.text,
      model: result.model,
      latencyMs: result.latencyMs,
      usage: result.usage,
    });
  });

  app.get("/api/accounts", async (_request, response) => {
    const statuses = await sessions.statusAll();
    response.json(statuses.map((status) => ({
      account: status.account,
      running: status.running,
      tabs: status.tabs.map(tabView),
      ...(status.error === undefined ? {} : { error: status.error }),
    })));
  });

  app.post("/api/accounts", async (request, response) => {
    const body = request.body as AccountBody;
    if (typeof body.id !== "string" || typeof body.label !== "string") {
      response.status(400).json({ error: "id and label must be strings" });
      return;
    }
    response.status(201).json(await sessions.registerAccount(body.id, body.label));
  });

  app.delete("/api/accounts/:accountId", async (request, response) => {
    const removed = await sessions.removeAccount(request.params.accountId ?? "");
    response.json({ removed: removed.id, persistentProfileDeleted: false });
  });

  app.get("/api/accounts/:accountId/status", async (request, response) => {
    const status = await sessions.status(request.params.accountId ?? "");
    response.json({ ...status, tabs: status.tabs.map(tabView) });
  });

  app.patch("/api/accounts/:accountId/enabled", async (request, response) => {
    const body = request.body as EnabledBody;
    if (typeof body.enabled !== "boolean") {
      response.status(400).json({ error: "enabled must be boolean" });
      return;
    }
    const account = await store.setAccountEnabled(
      request.params.accountId ?? "",
      body.enabled,
    );
    if (!body.enabled) {
      await sessions.stopSession(account.id).catch((error: unknown) => {
        logger.warn("account.session_stop_failed", {
          accountId: account.id,
          error: errorMessage(error).slice(0, 1_000),
        });
      });
    }
    response.json(account);
  });

  app.post("/api/accounts/:accountId/facebook-status", async (request, response) => {
    response.json(await facebook.inspectSession(request.params.accountId ?? ""));
  });

  app.post("/api/accounts/:accountId/session/open", async (request, response) => {
    const body = request.body as OpenBody;
    if (body.url !== undefined && typeof body.url !== "string") {
      response.status(400).json({ error: "url must be a string" });
      return;
    }
    const tab = await sessions.openSession(
      request.params.accountId ?? "",
      typeof body.url === "string" ? body.url : undefined,
    );
    response.json({ tab: tabView(tab) });
  });

  app.post("/api/accounts/:accountId/login/start", async (request, response) => {
    const result = await sessions.startManualLogin(request.params.accountId ?? "");
    response.json({
      accountId: result.account.id,
      viewerUrl: result.display.vncUrl,
      tab: tabView(result.tab),
    });
  });

  app.post("/api/accounts/:accountId/login/finish", async (request, response) => {
    const result = await sessions.finishManualLogin(request.params.accountId ?? "");
    response.json({
      accountId: result.account.id,
      headless: true,
      profilePersistent: true,
      tab: tabView(result.tab),
    });
  });

  app.post("/api/accounts/:accountId/session/stop", async (request, response) => {
    const accountId = request.params.accountId ?? "";
    await sessions.stopSession(accountId);
    response.json({ accountId, stopped: true, profilePersistent: true });
  });

  app.get("/api/groups", (_request, response) => {
    response.json(store.listGroups());
  });

  app.post("/api/groups", async (request, response) => {
    const body = request.body as GroupBody;
    if (
      typeof body.accountId !== "string" ||
      typeof body.name !== "string" ||
      typeof body.url !== "string" ||
      typeof body.scanIntervalSeconds !== "number" ||
      typeof body.maxPostsPerScan !== "number" ||
      (body.promptContext !== undefined && typeof body.promptContext !== "string")
    ) {
      response.status(400).json({ error: "Invalid group configuration" });
      return;
    }
    await sessions.getAccount(body.accountId);
    response.status(201).json(store.createGroup({
      accountId: body.accountId,
      name: body.name,
      url: body.url,
      scanIntervalSeconds: body.scanIntervalSeconds,
      maxPostsPerScan: body.maxPostsPerScan,
      ...(body.promptContext === undefined ? {} : { promptContext: body.promptContext }),
    }));
  });

  app.patch("/api/groups/:groupId/enabled", (request, response) => {
    const body = request.body as EnabledBody;
    if (typeof body.enabled !== "boolean") {
      response.status(400).json({ error: "enabled must be boolean" });
      return;
    }
    response.json(store.setGroupEnabled(request.params.groupId ?? "", body.enabled));
  });

  app.delete("/api/groups/:groupId", (request, response) => {
    const groupId = request.params.groupId ?? "";
    store.deleteGroup(groupId);
    response.json({ removed: groupId });
  });

  app.post("/api/groups/:groupId/scan", (request, response) => {
    response.status(202).json(store.enqueueScanNow(request.params.groupId ?? ""));
  });

  app.get("/api/response-templates", (_request, response) => {
    response.json(store.listResponseTemplates());
  });

  app.get("/api/response-templates/:templateId", (request, response) => {
    response.json(store.getResponseTemplate(request.params.templateId ?? ""));
  });

  app.post("/api/response-templates", (request, response) => {
    const body = request.body as ResponseTemplateBody;
    if (
      typeof body.name !== "string" ||
      typeof body.category !== "string" ||
      typeof body.body !== "string" ||
      (body.llmInstruction !== undefined && typeof body.llmInstruction !== "string")
    ) {
      response.status(400).json({ error: "Invalid response template" });
      return;
    }
    response.status(201).json(store.createResponseTemplate({
      name: body.name,
      category: body.category,
      body: body.body,
      ...(body.llmInstruction === undefined ? {} : { llmInstruction: body.llmInstruction }),
    }));
  });

  app.patch("/api/response-templates/:templateId", (request, response) => {
    const body = request.body as ResponseTemplateBody;
    const invalid =
      (body.name !== undefined && typeof body.name !== "string") ||
      (body.category !== undefined && typeof body.category !== "string") ||
      (body.body !== undefined && typeof body.body !== "string") ||
      (body.llmInstruction !== undefined && typeof body.llmInstruction !== "string") ||
      (body.enabled !== undefined && typeof body.enabled !== "boolean");
    if (invalid || Object.keys(body).length === 0) {
      response.status(400).json({ error: "Invalid response template update" });
      return;
    }
    response.json(store.updateResponseTemplate(request.params.templateId ?? "", {
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      ...(typeof body.category === "string" ? { category: body.category } : {}),
      ...(typeof body.body === "string" ? { body: body.body } : {}),
      ...(typeof body.llmInstruction === "string"
        ? { llmInstruction: body.llmInstruction }
        : {}),
      ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
    }));
  });

  app.delete("/api/response-templates/:templateId", (request, response) => {
    const templateId = request.params.templateId ?? "";
    store.deleteResponseTemplate(templateId);
    response.json({ removed: templateId });
  });

  app.get("/api/response-drafts", (request, response) => {
    response.json(store.listResponseDrafts(queryLimit(request)));
  });

  app.get("/api/posts", (request, response) => {
    const groupId = typeof request.query.groupId === "string" ? request.query.groupId : undefined;
    response.json(store.listPosts(queryLimit(request), groupId));
  });

  app.get("/api/decisions", (request, response) => {
    const rawStatus = request.query.status;
    const status = rawStatus === "review" || rawStatus === "ignored" ? rawStatus : undefined;
    response.json(store.listDecisions(queryLimit(request), status));
  });

  app.get("/api/scans", (request, response) => {
    response.json(store.listScanRuns(queryLimit(request)));
  });

  app.get("/api/jobs", (request, response) => {
    response.json(store.listJobs(queryLimit(request)));
  });

  app.get("/api/audit", (request, response) => {
    response.json(store.listAuditEvents(queryLimit(request)));
  });

  app.use(
    express.static(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public"), {
      extensions: ["html"],
      index: "index.html",
      maxAge: "1h",
    }),
  );

  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    const message = errorMessage(error);
    const status =
      error instanceof CamofoxRequestError || error instanceof LlmRequestError
        ? 502
        : message.startsWith("Unknown account:") ||
            message.startsWith("Unknown group:") ||
            message.startsWith("Unknown scan:") ||
            message.startsWith("Unknown job:") ||
            message.startsWith("Unknown decision:") ||
            message.startsWith("Unknown response template:")
          ? 404
          : message.startsWith("Account already exists:") ||
              message.startsWith("Camofox profile already exists:") ||
              message.startsWith("Group URL already exists:") ||
              message.startsWith("Account has monitored groups:") ||
              message.startsWith("Account is disabled:") ||
              message.startsWith("Group is disabled:") ||
              message.startsWith("Response template name already exists:")
            ? 409
            : message.includes("must") || message.startsWith("Invalid ")
              ? 400
              : 500;
    response.status(status).json({ error: message });
  };
  app.use(errorHandler);
  return app;
}

export async function startPanel(services: Services = createServices()): Promise<Server> {
  const app = createPanelApp(services);
  return new Promise<Server>((resolve, reject) => {
    const server = app.listen(services.config.panelPort, services.config.panelHost, () => {
      services.logger.info("panel.listening", {
        host: services.config.panelHost,
        port: services.config.panelPort,
      });
      resolve(server);
    });
    server.once("error", reject);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startPanel().catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
