import type { FacebookAccountAuthState } from "../domain/account.js";
import type { DiscoveredPostInput } from "../domain/monitoring.js";

export const FACEBOOK_EXTRACTOR_VERSION = "facebook-dom-v1";

export type FacebookAuthState = FacebookAccountAuthState | "access_denied";

export interface FacebookSessionInspection {
  readonly state: FacebookAuthState;
  readonly currentUrl: string;
  readonly reason: string;
}

interface ExtractedDomPost {
  readonly externalId?: unknown;
  readonly url?: unknown;
  readonly author?: unknown;
  readonly content?: unknown;
  readonly publishedAt?: unknown;
}

export function inspectFacebookState(
  urlValue: string,
  snapshot: string,
): FacebookSessionInspection {
  const lowerUrl = urlValue.toLowerCase();
  const lowerSnapshot = snapshot.toLocaleLowerCase("pl");
  if (
    lowerUrl.includes("/checkpoint") ||
    lowerUrl.includes("/two_step_verification") ||
    hasAny(lowerSnapshot, ["checkpoint", "potwierdź swoją tożsamość", "confirm your identity"])
  ) {
    return {
      state: "checkpoint",
      currentUrl: urlValue,
      reason: "Facebook wymaga potwierdzenia konta",
    };
  }
  if (
    lowerUrl.includes("/login") ||
    lowerUrl.includes("/recover") ||
    hasAny(lowerSnapshot, [
      "zaloguj się do facebooka",
      "log in to facebook",
      "adres e-mail lub numer telefonu",
      "email address or phone number",
    ])
  ) {
    return {
      state: "login_required",
      currentUrl: urlValue,
      reason: "Sesja Facebook wymaga logowania",
    };
  }
  if (
    lowerUrl.includes("captcha") ||
    hasAny(lowerSnapshot, [
      "captcha",
      "nietypowa aktywność",
      "unusual activity",
      "temporarily blocked",
    ])
  ) {
    return {
      state: "blocked",
      currentUrl: urlValue,
      reason: "Facebook zatrzymał sesję lub wymaga CAPTCHA",
    };
  }
  if (
    hasAny(lowerSnapshot, [
      "ta zawartość jest obecnie niedostępna",
      "this content isn't available",
      "nie możesz zobaczyć tej zawartości",
      "you can't see this content",
    ])
  ) {
    return {
      state: "access_denied",
      currentUrl: urlValue,
      reason: "Konto nie ma dostępu do tej grupy lub treści",
    };
  }
  if (
    hasAny(lowerSnapshot, [
      "utwórz post",
      "create a post",
      "co słychać",
      "what's on your mind",
      "menu konta",
      "account menu",
      "aktualności",
      "news feed",
    ])
  ) {
    return {
      state: "authenticated",
      currentUrl: urlValue,
      reason: "Wykryto aktywną sesję Facebook",
    };
  }
  return {
    state: "unknown",
    currentUrl: urlValue,
    reason: "Stan sesji Facebook jest niejednoznaczny",
  };
}

export function normalizeExtractedPosts(
  value: unknown,
  limit: number,
): DiscoveredPostInput[] {
  if (!Array.isArray(value)) return [];
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const seen = new Set<string>();
  const posts: DiscoveredPostInput[] = [];
  for (const candidate of value) {
    if (posts.length >= safeLimit) break;
    if (candidate === null || typeof candidate !== "object") continue;
    const raw = candidate as ExtractedDomPost;
    if (
      typeof raw.externalId !== "string" ||
      typeof raw.url !== "string" ||
      typeof raw.content !== "string"
    ) {
      continue;
    }
    const externalId = raw.externalId.trim();
    const url = normalizePostUrl(raw.url);
    const content = raw.content.replace(/\s+/g, " ").trim();
    if (externalId === "" || url === undefined || content.length < 10 || seen.has(externalId)) {
      continue;
    }
    seen.add(externalId);
    const author = typeof raw.author === "string"
      ? raw.author.replace(/\s+/g, " ").trim()
      : "";
    const publishedAt = normalizeDate(raw.publishedAt);
    posts.push({
      externalId: externalId.slice(0, 500),
      url,
      content: content.slice(0, 20_000),
      ...(author === "" ? {} : { author: author.slice(0, 200) }),
      ...(publishedAt === undefined ? {} : { publishedAt }),
    });
  }
  return posts;
}

export function postExtractionExpression(limit: number): string {
  return `(() => {
    const limit = ${Math.max(1, Math.min(100, Math.trunc(limit)))};
    const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const articles = Array.from(document.querySelectorAll('[role="article"]'));
    const results = [];
    const seen = new Set();
    for (const article of articles) {
      if (results.length >= limit) break;
      const links = Array.from(article.querySelectorAll('a[href]'));
      const permalink = links.find((link) => {
        const href = link.href || '';
        return /\\/groups\\/[^/]+\\/(posts|permalink)\\//i.test(href) ||
          /[?&]story_fbid=/i.test(href) || /[?&]multi_permalinks=/i.test(href);
      });
      if (!permalink) continue;
      const url = new URL(permalink.href, location.origin);
      url.hash = '';
      const match = url.pathname.match(/\\/(?:posts|permalink)\\/([^/?]+)/i);
      const externalId = match?.[1] || url.searchParams.get('story_fbid') ||
        url.searchParams.get('multi_permalinks') || url.toString();
      if (!externalId || seen.has(externalId)) continue;
      const content = clean(article.innerText || article.textContent);
      if (content.length < 10) continue;
      const authorNode = article.querySelector('h2 a, h3 a, h4 a, strong a, a[role="link"]');
      const timeNode = article.querySelector('time, abbr');
      const publishedAt = timeNode?.getAttribute('datetime') ||
        timeNode?.getAttribute('title') || undefined;
      seen.add(externalId);
      results.push({
        externalId,
        url: url.toString(),
        author: clean(authorNode?.textContent),
        content,
        publishedAt,
      });
    }
    return results;
  })()`;
}

function hasAny(value: string, needles: readonly string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function normalizePostUrl(value: string): string | undefined {
  try {
    const url = new URL(value, "https://www.facebook.com/");
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || (host !== "facebook.com" && !host.endsWith(".facebook.com"))) {
      return undefined;
    }
    url.hash = "";
    const allowedParameters = new Set(["story_fbid", "id", "multi_permalinks"]);
    for (const key of [...url.searchParams.keys()]) {
      if (!allowedParameters.has(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function normalizeDate(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}
