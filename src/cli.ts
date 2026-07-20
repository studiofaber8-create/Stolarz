#!/usr/bin/env node
import { Command } from "commander";
import type { CamofoxTab } from "./camofox/types.js";
import type { AccountSessionStatus } from "./session/facebook-session-manager.js";
import { createServices } from "./services.js";

interface AddAccountOptions {
  readonly label: string;
}

interface OpenSessionOptions {
  readonly url?: string;
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

export async function runCli(argv: readonly string[] = process.argv): Promise<void> {
  const { sessions, llm } = createServices();
  const program = new Command();

  program
    .name("stolarz-agent")
    .description("Manage isolated Camofox sessions for authorized Facebook accounts")
    .version("0.1.0");

  program.command("health").description("Check Camofox health").action(async () => {
    const health = await sessions.health();
    print({
      ok: health.ok,
      engine: health.engine,
      browserConnected: health.browserConnected,
    });
  });

  const account = program.command("account").description("Manage Facebook accounts");

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
    .command("remove")
    .argument("<accountId>")
    .description("Stop the session and remove the local registry entry; browser profile remains")
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
      if (accountId === undefined) {
        print((await sessions.statusAll()).map(presentStatus));
      } else {
        print(presentStatus(await sessions.status(accountId)));
      }
    });

  session
    .command("stop")
    .argument("<accountId>")
    .description("Close live browser context while preserving the persistent profile")
    .action(async (accountId: string) => {
      await sessions.stopSession(accountId);
      print({ accountId, stopped: true, profilePersistent: true });
    });

  const llmCommand = program.command("llm").description("Manage the Claude Custom API integration");
  llmCommand.command("status").description("Show non-secret LLM configuration").action(() => {
    print(
      llm === undefined
        ? { configured: false }
        : { configured: true, ...llm.metadata },
    );
  });
  llmCommand.command("test").description("Send one minimal connectivity request").action(async () => {
    if (llm === undefined) throw new Error("Custom LLM API is not configured");
    print({ ok: true, ...(await llm.testConnection()) });
  });

  await program.parseAsync([...argv]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
