import { CamofoxClient } from "./camofox/client.js";
import { loadConfig, type AppConfig } from "./config.js";
import { AccountRegistry } from "./infra/account-registry.js";
import { CustomLlmClient } from "./llm/custom-llm-client.js";
import { FacebookSessionManager } from "./session/facebook-session-manager.js";

export interface Services {
  readonly config: AppConfig;
  readonly sessions: FacebookSessionManager;
  readonly llm?: CustomLlmClient;
}

export function createServices(config = loadConfig()): Services {
  const registry = new AccountRegistry(config.dataDir);
  const camofox = new CamofoxClient(config);
  const sessions = new FacebookSessionManager(config, registry, camofox);
  const llm = config.llm === undefined ? undefined : new CustomLlmClient(config.llm);
  return { config, sessions, ...(llm === undefined ? {} : { llm }) };
}
