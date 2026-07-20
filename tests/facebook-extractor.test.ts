import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  FACEBOOK_EXTRACTOR_VERSION,
  inspectFacebookState,
  normalizeExtractedPosts,
  postExtractionExpression,
} from "../src/facebook/facebook-extractor.js";

const fixtureDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/facebook",
);

describe("Facebook session detector fixtures", () => {
  const fixtures = JSON.parse(
    readFileSync(path.join(fixtureDirectory, "session-states.json"), "utf8"),
  ) as Array<{ name: string; url: string; snapshot: string; expected: string }>;

  for (const fixture of fixtures) {
    it(fixture.name, () => {
      expect(inspectFacebookState(fixture.url, fixture.snapshot).state).toBe(fixture.expected);
    });
  }
});

describe("versioned Facebook DOM extractor", () => {
  it("has an explicit version", () => {
    expect(FACEBOOK_EXTRACTOR_VERSION).toMatch(/^facebook-dom-v\d+$/);
  });

  it("extracts and deduplicates modern group post markup", () => {
    const raw = evaluateFixture("posts-modern.html", 10);
    const posts = normalizeExtractedPosts(raw, 10);

    expect(posts).toHaveLength(2);
    expect(posts[0]).toMatchObject({
      externalId: "111",
      author: "Anna Kowalska",
      publishedAt: "2026-07-19T10:30:00.000Z",
    });
    expect(posts[0]?.content).toContain("kuchni na wymiar");
    expect(posts[0]?.url).not.toContain("__cft__");
    expect(posts[1]).toMatchObject({ externalId: "222", author: "Jan Nowak" });
  });

  it("supports story_fbid and multi_permalinks variants", () => {
    const raw = evaluateFixture("posts-query-links.html", 10);
    const posts = normalizeExtractedPosts(raw, 10);

    expect(posts.map((post) => post.externalId)).toEqual(["333", "444"]);
    expect(posts[0]?.url).toContain("multi_permalinks=333");
    expect(posts[0]?.url).not.toContain("tracking=");
    expect(posts[1]?.url).toContain("story_fbid=444");
    expect(posts[1]?.url).toContain("id=999");
  });

  it("enforces the requested result limit", () => {
    const raw = evaluateFixture("posts-modern.html", 1);
    expect(normalizeExtractedPosts(raw, 1)).toHaveLength(1);
  });

  it("rejects malformed, short and non-Facebook candidates", () => {
    const posts = normalizeExtractedPosts([
      null,
      { externalId: "missing-url", content: "Long enough content" },
      { externalId: "short", url: "https://www.facebook.com/groups/x/posts/1", content: "tiny" },
      { externalId: "external", url: "https://evil.example/post/1", content: "This content is long enough" },
      { externalId: "valid", url: "/groups/x/posts/9", content: "This is a valid Facebook post body" },
    ], 10);

    expect(posts).toHaveLength(1);
    expect(posts[0]?.externalId).toBe("valid");
  });
});

function evaluateFixture(filename: string, limit: number): unknown {
  const html = readFileSync(path.join(fixtureDirectory, filename), "utf8");
  const dom = new JSDOM(html, {
    url: "https://www.facebook.com/groups/stolarze/",
    runScripts: "outside-only",
  });
  return dom.window.eval(postExtractionExpression(limit)) as unknown;
}
