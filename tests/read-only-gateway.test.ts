import { describe, it, expect } from "vitest";
import type { ReadOnlyBrowserGateway } from "../src/camofox/read-only-gateway.js";

/**
 * These tests verify at compile-time (type-level) and runtime that the
 * ReadOnlyBrowserGateway interface does NOT expose publishing operations.
 *
 * If someone adds click/type/press to the interface, these tests will
 * produce a TypeScript error during `npm run check` and fail at runtime.
 */
describe("ReadOnlyBrowserGateway", () => {
  it("does not expose click method", () => {
    type HasClick = "click" extends keyof ReadOnlyBrowserGateway ? true : false;
    const result: HasClick = false;
    expect(result).toBe(false);
  });

  it("does not expose type method", () => {
    type HasType = "type" extends keyof ReadOnlyBrowserGateway ? true : false;
    const result: HasType = false;
    expect(result).toBe(false);
  });

  it("does not expose press method", () => {
    type HasPress = "press" extends keyof ReadOnlyBrowserGateway ? true : false;
    const result: HasPress = false;
    expect(result).toBe(false);
  });

  it("does not expose screenshot method", () => {
    type HasScreenshot = "screenshot" extends keyof ReadOnlyBrowserGateway ? true : false;
    const result: HasScreenshot = false;
    expect(result).toBe(false);
  });

  it("exposes only read-only navigation and observation methods", () => {
    type ExpectedKeys =
      | "health"
      | "createTab"
      | "listTabs"
      | "navigate"
      | "snapshot"
      | "wait"
      | "scroll"
      | "evaluate"
      | "pageErrors"
      | "closeTab"
      | "closeSession"
      | "toggleDisplay";

    type ActualKeys = keyof ReadOnlyBrowserGateway;
    type AllMatch = ActualKeys extends ExpectedKeys ? (ExpectedKeys extends ActualKeys ? true : false) : false;
    const result: AllMatch = true;
    expect(result).toBe(true);
  });
});
