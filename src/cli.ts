#!/usr/bin/env node
import { Command } from "commander";
import type { CamofoxTab } from "./camofox/types.js";
import type { AccountSessionStatus } from "./session/facebook-session-manager.js";
import { createServices } from "./services.js";

interface AddAccountOptions {
  readonly label: string;
}

interface RenameAccountOptions {
  readonly label: string;
}

interface OpenSessionOptions {
  readonly url?: string;
}

interface AddGroupOptions {
  readonly name: string;
  readonly url: string;
  readonly interval: string;
  readonly maxPosts: string;
  readonly context?: string;
}

interface ResponseTemplateOptions {
  readonly name: string;
  readonly category: string;
  readonly body: string;
  readonly instruction?: string;
}

interface UpdateResponseTemplateOptions {
  readonly name?: string;
  readonly category?: string;
  readonly body?: string;
  readonly instruction?: string;
}

interface ListOptions {
  readonly limit: string;
  readonly status?: string;
  readonly group?: string;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function presentTab(tab: CamofoxTab): object {
  return {
    id: tab.id,
    ...(tab.url === undefined ? {} : { url: tab.url }),
    ...(tab.title === undefined ? {} : { title: tab.title }),
  };
}

function presentStatus(status: AccountSessionStatus): object {
  return {
    account: status.account,
    running: status.running,
    tabs: status.tabs.map(presentTab),
    ...(status.error === undefined ? {} : { error: status.error }),
  };
}

function integerOption(name: string, value: string, minimum: number, maximum: number): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export async function runCli(argv: readonly string[] = process.argv): Promise<void> {
  const services = createServices();
  const { sessions, llm, store, worker, facebook } = services;
  const program = new Command();

  program
    .name("stolarz-agent")
    .description("Manage the Camofox Facebook monitoring agent")
    .version("0.2.0");

  program.command("health").description("Check Camofox and monitoring health").action(async () => {
    const health = await sessions.health();
    print({
      ok: health.ok,
      engine: health.engine,
      browserConnected: health.browserConnected,
      worker: worker.status(),
      monitoring: store.summary(),
    });
  });

  const account = program.command("account").description("Manage authorized Facebook accounts");
  account
    .command("add")
    .argument("<accountId>", "Local account id, for example workshop-owner")
    .requiredOption("-l, --label <label>", "Human-readable account name")
    .description("Register an authorized account without storing its password")
    .action(async (accountId: string, options: AddAccountOptions) => {
      print(await sessions.registerAccount(accountId, options.label));
    });
  account.command("list").description("List registered accounts").action(async () => {
    print(await sessions.listAccounts());
  });
  account
    .command("rename")
    .argument("<accountId>")
    .requiredOption("-l, --label <label>", "New human-readable account name")
    .action(async (accountId: string, options: RenameAccountOptions) => {
      print(await store.updateAccountLabel(accountId, options.label));
    });
  account.command("enable").argument("<accountId>").action(async (accountId: string) => {
    print(await store.setAccountEnabled(accountId, true));
  });
  account.command("disable").argument("<accountId>").action(async (accountId: string) => {
    const disabled = await store.setAccountEnabled(accountId, false);
    let sessionStopped = true;
    try {
      await sessions.stopSession(accountId);
    } catch {
      sessionStopped = false;
    }
    print({ account: disabled, sessionStopped });
  });
  account
    .command("inspect")
    .argument("<accountId>")
    .description("Inspect Facebook authentication state")
    .action(async (accountId: string) => {
      print(await facebook.inspectSession(accountId));
    });
  account
    .command("recover")
    .argument("<accountId>")
    .description("Verify Facebook login and explicitly recover a suspended account")
    .action(async (accountId: string) => {
      const inspection = await facebook.inspectSession(accountId);
      if (inspection.state !== "authenticated") {
        throw new Error(`Account recovery requires authenticated inspection: ${accountId}`);
      }
      print({ account: await store.recoverAccount(accountId), inspection });
    });
  account
    .command("remove")
    .argument("<accountId>")
    .description("Stop the session and remove the registry entry; browser profile remains")
    .action(async (accountId: string) => {
      const removed = await sessions.removeAccount(accountId);
      print({ removed: removed.id, persistentProfileDeleted: false });
    });

  const session = program.command("session").description("Manage isolated browser sessions");
  session
    .command("open")
    .argument("<accountId>")
    .option("--url <url>", "Facebook URL to open")
    .description("Open or reuse an isolated Facebook tab")
    .action(async (accountId: string, options: OpenSessionOptions) => {
      const tab = await sessions.openSession(accountId, options.url);
      print({ accountId, tab: presentTab(tab) });
    });
  session
    .command("login")
    .argument("<accountId>")
    .description("Start manual Facebook login in virtual/noVNC display mode")
    .action(async (accountId: string) => {
      const result = await sessions.startManualLogin(accountId);
      print({
        accountId: result.account.id,
        viewerUrl: result.display.vncUrl,
        tab: presentTab(result.tab),
        next: `Complete login manually, then run: stolarz-agent session finish-login ${result.account.id}`,
      });
    });
  session
    .command("finish-login")
    .argument("<accountId>")
    .description("Return the account to headless mode after manual login")
    .action(async (accountId: string) => {
      const result = await sessions.finishManualLogin(accountId);
      print({
        accountId: result.account.id,
        headless: true,
        tab: presentTab(result.tab),
        profilePersistent: true,
      });
    });
  session
    .command("status")
    .argument("[accountId]")
    .description("Show one account status or all account statuses")
    .action(async (accountId?: string) => {
      print(
        accountId === undefined
          ? (await sessions.statusAll()).map(presentStatus)
          : presentStatus(await sessions.status(accountId)),
      );
    });
  session
    .command("stop")
    .argument("<accountId>")
    .description("Close live browser context while preserving the persistent profile")
    .action(async (accountId: string) => {
      await sessions.stopSession(accountId);
      print({ accountId, stopped: true, profilePersistent: true });
    });

  const group = program.command("group").description("Configure monitored Facebook groups");
  group
    .command("add")
    .argument("<accountId>")
    .requiredOption("--name <name>", "Display name")
    .requiredOption("--url <url>", "Facebook group URL")
    .option("--interval <seconds>", "Scan interval in seconds", "600")
    .option("--max-posts <number>", "Maximum posts extracted per scan", "20")
    .option("--context <text>", "Additional classification context")
    .action(async (accountId: string, options: AddGroupOptions) => {
      await sessions.getAccount(accountId);
      print(store.createGroup({
        accountId,
        name: options.name,
        url: options.url,
        scanIntervalSeconds: integerOption("interval", options.interval, 60, 86_400),
        maxPostsPerScan: integerOption("max-posts", options.maxPosts, 1, 100),
        ...(options.context === undefined ? {} : { promptContext: options.context }),
      }));
    });
  group.command("list").action(() => print(store.listGroups()));
  group.command("enable").argument("<groupId>").action((groupId: string) => {
    print(store.setGroupEnabled(groupId, true));
  });
  group.command("disable").argument("<groupId>").action((groupId: string) => {
    print(store.setGroupEnabled(groupId, false));
  });
  group.command("move").argument("<groupId>").argument("<accountId>").action(
    (groupId: string, accountId: string) => {
      print(store.moveGroup(groupId, accountId));
    },
  );
  group.command("remove").argument("<groupId>").action((groupId: string) => {
    store.deleteGroup(groupId);
    print({ removed: groupId });
  });
  group.command("scan").argument("<groupId>").action((groupId: string) => {
    print(store.enqueueScanNow(groupId));
  });

  const monitor = program.command("monitor").description("Inspect monitoring state");
  monitor.command("summary").action(() => print(store.summary()));
  monitor
    .command("posts")
    .option("--limit <number>", "Result limit", "100")
    .option("--group <groupId>", "Filter by group")
    .action((options: ListOptions) => {
      print(store.listPosts(integerOption("limit", options.limit, 1, 500), options.group));
    });
  monitor
    .command("decisions")
    .option("--limit <number>", "Result limit", "100")
    .option("--status <status>", "review or ignored")
    .action((options: ListOptions) => {
      if (options.status !== undefined && options.status !== "review" && options.status !== "ignored") {
        throw new Error("status must be review or ignored");
      }
      print(store.listDecisions(
        integerOption("limit", options.limit, 1, 500),
        options.status as "review" | "ignored" | undefined,
      ));
    });
  monitor.command("scans").option("--limit <number>", "Result limit", "100")
    .action((options: ListOptions) => print(store.listScanRuns(integerOption("limit", options.limit, 1, 500))));
  monitor.command("jobs").option("--limit <number>", "Result limit", "100")
    .action((options: ListOptions) => print(store.listJobs(integerOption("limit", options.limit, 1, 500))));
  monitor.command("audit").option("--limit <number>", "Result limit", "100")
    .action((options: ListOptions) => print(
      store.listAuditEvents(integerOption("limit", options.limit, 1, 500)),
    ));

  const template = program.command("template").description("Manage Spintax/LLM response templates");
  template
    .command("add")
    .requiredOption("--name <name>", "Unique template name")
    .requiredOption("--category <category>", "Lead category or default")
    .requiredOption("--body <spintax>", "Response template with optional Spintax")
    .option("--instruction <text>", "Additional LLM drafting instruction")
    .action((options: ResponseTemplateOptions) => {
      print(store.createResponseTemplate({
        name: options.name,
        category: options.category,
        body: options.body,
        ...(options.instruction === undefined ? {} : { llmInstruction: options.instruction }),
      }));
    });
  template.command("list").action(() => print(store.listResponseTemplates()));
  template.command("show").argument("<templateId>").action((templateId: string) => {
    print(store.getResponseTemplate(templateId));
  });
  template
    .command("update")
    .argument("<templateId>")
    .option("--name <name>")
    .option("--category <category>")
    .option("--body <spintax>")
    .option("--instruction <text>")
    .action((templateId: string, options: UpdateResponseTemplateOptions) => {
      if (Object.values(options).every((value) => value === undefined)) {
        throw new Error("Provide at least one template field to update");
      }
      print(store.updateResponseTemplate(templateId, {
        ...(options.name === undefined ? {} : { name: options.name }),
        ...(options.category === undefined ? {} : { category: options.category }),
        ...(options.body === undefined ? {} : { body: options.body }),
        ...(options.instruction === undefined ? {} : { llmInstruction: options.instruction }),
      }));
    });
  template.command("enable").argument("<templateId>").action((templateId: string) => {
    print(store.updateResponseTemplate(templateId, { enabled: true }));
  });
  template.command("disable").argument("<templateId>").action((templateId: string) => {
    print(store.updateResponseTemplate(templateId, { enabled: false }));
  });
  template.command("remove").argument("<templateId>").action((templateId: string) => {
    store.deleteResponseTemplate(templateId);
    print({ removed: templateId });
  });

  program.command("drafts").description("List LLM response drafts awaiting manual review")
    .option("--limit <number>", "Result limit", "100")
    .action((options: ListOptions) => {
      print(store.listResponseDrafts(integerOption("limit", options.limit, 1, 500)));
    });

  const workerCommand = program.command("worker").description("Control the job worker");
  workerCommand.command("status").action(() => print(worker.status()));
  workerCommand.command("once").description("Schedule due groups and process at most one job").action(async () => {
    print({ processed: await worker.runOnce(true), monitoring: store.summary() });
  });

  const llmCommand = program.command("llm").description("Manage the Claude Custom API integration");
  llmCommand.command("status").description("Show non-secret LLM configuration").action(() => {
    print(llm === undefined ? { configured: false } : { configured: true, ...llm.metadata });
  });
  llmCommand.command("test").description("Send one minimal connectivity request").action(async () => {
    if (llm === undefined) throw new Error("Custom LLM API is not configured");
    print({ ok: true, ...(await llm.testConnection()) });
  });

  try {
    await program.parseAsync([...argv]);
  } finally {
    await worker.stop();
    store.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
