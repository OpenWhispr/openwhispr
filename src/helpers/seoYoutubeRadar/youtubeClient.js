const API_BASE = "https://www.googleapis.com/youtube/v3";

function parseDurationSeconds(value) {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value || "");
  if (!match) return 0;
  return (Number(match[1]) || 0) * 3600 + (Number(match[2]) || 0) * 60 + (Number(match[3]) || 0);
}

async function fetchJson(fetchImpl, url) {
  const response = await fetchImpl(url.toString());
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || `YouTube API request failed: ${response.status}`);
  }
  return data;
}

function createYouTubeClient({ apiKey, fetchImpl = fetch }) {
  const key = String(apiKey || "").trim();
  if (!key) throw new Error("YouTube API key is required");
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");

  return {
    async searchVideos({ query, publishedAfter, maxResults, regionCode, language }) {
      const url = new URL(`${API_BASE}/search`);
      url.searchParams.set("key", key);
      url.searchParams.set("part", "snippet");
      url.searchParams.set("type", "video");
      url.searchParams.set("order", "viewCount");
      url.searchParams.set("q", String(query || ""));
      url.searchParams.set("publishedAfter", publishedAfter);
      url.searchParams.set("maxResults", String(Math.min(Math.max(Number(maxResults) || 1, 1), 25)));
      url.searchParams.set("regionCode", String(regionCode || "US"));
      url.searchParams.set("relevanceLanguage", String(language || "en"));
      const data = await fetchJson(fetchImpl, url);
      return (data.items || [])
        .map((item) => ({ id: item?.id?.videoId, snippet: item?.snippet || {} }))
        .filter((item) => item.id);
    },

    async getVideoDetails(videoIds) {
      const ids = [...new Set((videoIds || []).filter(Boolean))];
      if (ids.length === 0) return [];
      const url = new URL(`${API_BASE}/videos`);
      url.searchParams.set("key", key);
      url.searchParams.set("part", "snippet,statistics,contentDetails");
      url.searchParams.set("id", ids.join(","));
      const data = await fetchJson(fetchImpl, url);
      return (data.items || []).map((item) => ({
        id: item.id,
        title: item.snippet?.title || "",
        channelTitle: item.snippet?.channelTitle || "",
        publishedAt: item.snippet?.publishedAt || "",
        description: item.snippet?.description || "",
        viewCount: Number(item.statistics?.viewCount || 0),
        likeCount: Number(item.statistics?.likeCount || 0),
        commentCount: Number(item.statistics?.commentCount || 0),
        durationSeconds: parseDurationSeconds(item.contentDetails?.duration),
        url: `https://www.youtube.com/watch?v=${item.id}`,
      }));
    },
  };
}

module.exports = { createYouTubeClient, parseDurationSeconds };
