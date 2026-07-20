import { timingSafeEqual } from "node:crypto";
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

export function createPanelApp(services: Services = createServices()): express.Express {
  const { config, sessions, llm } = services;
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
    response.json({
      ok: health.ok,
      engine: health.engine,
      browserConnected: health.browserConnected,
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
        llm === undefined
          ? { configured: false }
          : { configured: true, ...llm.metadata },
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
    response.json(await sessions.statusAll());
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
        : message.startsWith("Unknown account:")
          ? 404
          : message.startsWith("Account already exists:") ||
              message.startsWith("Camofox profile already exists:")
            ? 409
            : message.startsWith("Account id must") ||
                message.startsWith("Account label must") ||
                message.startsWith("Session URL must")
              ? 400
              : 500;
    response.status(status).json({ error: message });
  };
  app.use(errorHandler);
  return app;
}

export async function startPanel(services: Services = createServices()): Promise<void> {
  const app = createPanelApp(services);
  await new Promise<void>((resolve, reject) => {
    const server = app.listen(services.config.panelPort, services.config.panelHost, () => {
      console.log(
        `Agent panel listening on http://${services.config.panelHost}:${services.config.panelPort}`,
      );
      resolve();
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
