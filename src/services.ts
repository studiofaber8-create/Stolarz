import { LeadClassifier } from "./agent/lead-classifier.js";
import { LeadPolicyGate } from "./agent/policy-gate.js";
import { ResponseDraftGenerator } from "./agent/response-draft-generator.js";
import { AgentWorker } from "./agent/worker.js";
import { CamofoxClient } from "./camofox/client.js";
import { loadConfig, type AppConfig } from "./config.js";
import { FacebookAdapter } from "./facebook/facebook-adapter.js";
import { MonitoringStore } from "./infra/monitoring-store.js";
import { CustomLlmClient } from "./llm/custom-llm-client.js";
import { JsonLogger, type Logger } from "./observability/logger.js";
import { FacebookSessionManager } from "./session/facebook-session-manager.js";

export interface Services {
  readonly config: AppConfig;
  readonly sessions: FacebookSessionManager;
  readonly store: MonitoringStore;
  readonly facebook: FacebookAdapter;
  readonly worker: AgentWorker;
  readonly logger: Logger;
  readonly llm?: CustomLlmClient;
  readonly classifier?: LeadClassifier;
  readonly draftGenerator?: ResponseDraftGenerator;
}

export function createServices(config = loadConfig()): Services {
  const logger = new JsonLogger();
  const store = new MonitoringStore(config.dataDir);
  const camofox = new CamofoxClient(config);
  const sessions = new FacebookSessionManager(config, store, camofox);
  const facebook = new FacebookAdapter(sessions, camofox);
  const llm = config.llm === undefined ? undefined : new CustomLlmClient(config.llm);
  const classifier =
    llm === undefined
      ? undefined
      : new LeadClassifier(
          llm,
          new LeadPolicyGate(config.agent.reviewThreshold),
          config.agent.businessDescription,
        );
  const draftGenerator =
    llm === undefined
      ? undefined
      : new ResponseDraftGenerator(llm, config.agent.businessDescription);
  const worker = new AgentWorker(
    config.agent,
    store,
    facebook,
    classifier,
    logger,
    draftGenerator,
  );
  return {
    config,
    sessions,
    store,
    facebook,
    worker,
    logger,
    ...(llm === undefined ? {} : { llm }),
    ...(classifier === undefined ? {} : { classifier }),
    ...(draftGenerator === undefined ? {} : { draftGenerator }),
  };
}
