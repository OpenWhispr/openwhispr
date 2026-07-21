const { net } = require("electron");
const { parseInlineMarkdown } = require("./notionBlockConverter");

const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_API_VERSION = "2026-03-11";
const DEFAULT_MAX_ATTEMPTS = 4;

class NotionApiError extends Error {
  constructor(
    message,
    { status = 0, code = "NOTION_API_ERROR", retryable = false, outcomeUnknown = false } = {}
  ) {
    super(message);
    this.name = "NotionApiError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.outcomeUnknown = outcomeUnknown;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeUuid(value) {
  const compact = String(value || "")
    .trim()
    .replace(/^https?:\/\/[^/]+\//, "")
    .split(/[?#]/)[0]
    .split("/")
    .pop()
    ?.replace(/-/g, "")
    .match(/[0-9a-f]{32}/i)?.[0];
  if (!compact) return null;
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

function dataSourceTitle(source) {
  if (Array.isArray(source.title))
    return source.title.map((part) => part.plain_text || part.text?.content || "").join("");
  return source.name || "Untitled data source";
}

function findTitleProperty(schema) {
  const entry = Object.entries(schema?.properties || {}).find(
    ([, property]) => property?.type === "title"
  );
  if (!entry)
    throw new NotionApiError("This Notion data source has no title property", {
      code: "TITLE_PROPERTY_MISSING",
    });
  return { name: entry[0], id: entry[1].id };
}

class NotionClient {
  constructor(oauth, options = {}) {
    this.oauth = oauth;
    this.fetch = options.fetch || net.fetch;
    this.sleep = options.sleep || delay;
    this.apiBase = options.apiBase || NOTION_API_BASE;
    this.maxAttempts = options.maxAttempts || DEFAULT_MAX_ATTEMPTS;
  }

  async request(connectionId, path, options = {}) {
    let token = await this.oauth.refresh(connectionId);
    let refreshedAfterUnauthorized = false;
    const mutation = options.mutation === true;

    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      let response;
      try {
        response = await this.fetch(`${this.apiBase}${path}`, {
          method: options.method || "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            "Content-Type": "application/json",
            "Notion-Version": NOTION_API_VERSION,
          },
          ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
          signal: AbortSignal.timeout(options.timeoutMs || 30000),
          useSessionCookies: false,
        });
      } catch {
        if (mutation) {
          throw new NotionApiError(
            "Notion may have completed this change, but OpenWhispr could not confirm it. Check Notion before trying again.",
            {
              code: "OUTCOME_UNKNOWN",
              outcomeUnknown: true,
            }
          );
        }
        if (attempt + 1 < this.maxAttempts) {
          await this.sleep(Math.min(8000, 500 * 2 ** attempt));
          continue;
        }
        throw new NotionApiError("Could not reach Notion. Check your connection and retry.", {
          code: "NETWORK_ERROR",
          retryable: true,
        });
      }

      if (response.status === 401 && !refreshedAfterUnauthorized) {
        token = await this.oauth.refresh(connectionId, { force: true });
        refreshedAfterUnauthorized = true;
        continue;
      }

      const data = await response.json().catch(() => ({}));
      if (response.ok) return data;

      const retryable =
        response.status === 429 || response.status === 409 || response.status >= 500;
      if (mutation && response.status >= 500) {
        throw new NotionApiError(
          "Notion may have completed this change, but OpenWhispr could not confirm it. Check Notion before trying again.",
          {
            status: response.status,
            code: "OUTCOME_UNKNOWN",
            outcomeUnknown: true,
          }
        );
      }
      if (retryable && attempt + 1 < this.maxAttempts) {
        const retryAfterHeader = response.headers.get("retry-after");
        const retryAfter = retryAfterHeader === null ? NaN : Number(retryAfterHeader);
        const waitMs = Number.isFinite(retryAfter)
          ? retryAfter * 1000
          : Math.min(8000, 500 * 2 ** attempt);
        await this.sleep(waitMs);
        continue;
      }

      throw new NotionApiError(data?.message || `Notion request failed (${response.status})`, {
        status: response.status,
        code: data?.code || "NOTION_API_ERROR",
        retryable,
      });
    }

    throw new NotionApiError("Notion request failed after multiple attempts", { retryable: true });
  }

  async searchDataSources(connectionId, query = "") {
    const results = [];
    let cursor;
    do {
      const response = await this.request(connectionId, "/search", {
        method: "POST",
        body: {
          query,
          page_size: 100,
          filter: { property: "object", value: "data_source" },
          sort: { direction: "descending", timestamp: "last_edited_time" },
          ...(cursor ? { start_cursor: cursor } : {}),
        },
      });
      results.push(
        ...(response.results || []).map((source) => ({
          id: source.id,
          name: dataSourceTitle(source),
          icon: source.icon || null,
          parent: source.parent || null,
          url: source.url || null,
        }))
      );
      cursor = response.has_more ? response.next_cursor : null;
    } while (cursor);
    return results;
  }

  retrieveDataSource(connectionId, dataSourceId) {
    return this.request(connectionId, `/data_sources/${encodeURIComponent(dataSourceId)}`);
  }

  retrieveDatabase(connectionId, databaseId) {
    return this.request(connectionId, `/databases/${encodeURIComponent(databaseId)}`);
  }

  async resolveDataSource(connectionId, input) {
    const id = normalizeUuid(input);
    if (!id)
      throw new NotionApiError("Enter a valid Notion database URL or ID", {
        code: "INVALID_DESTINATION",
      });
    try {
      return await this.retrieveDataSource(connectionId, id);
    } catch (error) {
      if (error.status !== 404 && error.status !== 400) throw error;
    }
    const database = await this.retrieveDatabase(connectionId, id);
    const firstSource = database.data_sources?.[0];
    if (!firstSource?.id)
      throw new NotionApiError("That database has no accessible data sources", {
        code: "DATA_SOURCE_MISSING",
      });
    return this.retrieveDataSource(connectionId, firstSource.id);
  }

  createPage(connectionId, { dataSourceId, titleProperty, title }) {
    return this.request(connectionId, "/pages", {
      method: "POST",
      mutation: true,
      body: {
        parent: { data_source_id: dataSourceId },
        properties: {
          [titleProperty]: { title: parseInlineMarkdown(title) },
        },
      },
    });
  }

  appendBlocks(connectionId, pageId, children) {
    if (!Array.isArray(children) || children.length > 100) {
      throw new RangeError("Notion block batches must contain at most 100 blocks");
    }
    return this.request(connectionId, `/blocks/${encodeURIComponent(pageId)}/children`, {
      method: "PATCH",
      mutation: true,
      body: { children },
    });
  }
}

module.exports = {
  NOTION_API_BASE,
  NOTION_API_VERSION,
  NotionApiError,
  NotionClient,
  dataSourceTitle,
  findTitleProperty,
  normalizeUuid,
};
