/**
 * OpenWhispr MCP Server
 *
 * A standalone Model Context Protocol server that exposes OpenWhispr
 * functionality as MCP tools.  It communicates with the running Electron
 * app through a local HTTP bridge (MCPBridge) and uses stdio transport
 * for the MCP client (e.g. Claude Code).
 *
 * Usage with Claude Code:
 *   {
 *     "mcpServers": {
 *       "openwhispr": {
 *         "command": "node",
 *         "args": ["/path/to/openwhispr/src/mcp/server.js"]
 *       }
 *     }
 *   }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import http from "node:http";

// ---------------------------------------------------------------------------
// Bridge port discovery
// ---------------------------------------------------------------------------

/**
 * Return the list of candidate userData directories for the running platform.
 * Checks both production and development paths.
 */
function getUserDataDirs() {
  const home = homedir();
  const platform = process.platform;

  const baseDirs = [];

  if (platform === "darwin") {
    baseDirs.push(join(home, "Library", "Application Support"));
  } else if (platform === "win32") {
    baseDirs.push(process.env.APPDATA || join(home, "AppData", "Roaming"));
  } else {
    baseDirs.push(process.env.XDG_CONFIG_HOME || join(home, ".config"));
  }

  const appDirNames = [
    "OpenWhispr",
    "open-whispr",
    "OpenWhispr-development",
    "OpenWhispr-staging",
  ];

  const dirs = [];
  for (const baseDir of baseDirs) {
    for (const dirName of appDirNames) {
      dirs.push(join(baseDir, dirName));
    }
  }
  return dirs;
}

/**
 * Attempt to locate the port file written by MCPBridge in the Electron app.
 * The userData path varies by platform:
 *   macOS:   ~/Library/Application Support/OpenWhispr
 *   Linux:   ~/.config/OpenWhispr
 *   Windows: %APPDATA%/OpenWhispr
 *
 * We also check channel-suffixed directories for development builds.
 */
function discoverBridgePort() {
  for (const dir of getUserDataDirs()) {
    try {
      const portFilePath = join(dir, "mcp-bridge-port");
      const content = readFileSync(portFilePath, "utf-8").trim();
      const port = parseInt(content, 10);
      if (port > 0 && port <= 65535) {
        return port;
      }
    } catch {
      // File doesn't exist or can't be read — try next candidate
    }
  }

  return null;
}

/**
 * Read the auth token written by MCPBridge alongside the port file.
 * Returns the token string or null if not found.
 */
function discoverBridgeToken() {
  for (const dir of getUserDataDirs()) {
    try {
      const tokenFilePath = join(dir, "mcp-bridge-token");
      const token = readFileSync(tokenFilePath, "utf-8").trim();
      if (token) {
        return token;
      }
    } catch {
      // File doesn't exist or can't be read — try next candidate
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// HTTP helper to call the bridge
// ---------------------------------------------------------------------------

/**
 * Make an HTTP request to the MCPBridge running inside the Electron app.
 *
 * @param {"GET"|"POST"} method
 * @param {string} urlPath - e.g. "/status"
 * @param {object} [body] - JSON body for POST requests
 * @returns {Promise<object>} Parsed JSON response
 */
function callBridge(method, urlPath, body = null) {
  const port = discoverBridgePort();
  if (!port) {
    return Promise.reject(
      new Error(
        "OpenWhispr is not running or the MCP bridge is not active. " +
          "Please start the OpenWhispr app first."
      )
    );
  }

  const token = discoverBridgeToken();

  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;

    const options = {
      hostname: "127.0.0.1",
      port,
      path: urlPath,
      method,
      timeout: 60000,
      headers: {
        Accept: "application/json",
      },
    };

    if (token) {
      options.headers["Authorization"] = `Bearer ${token}`;
    }

    if (payload) {
      options.headers["Content-Type"] = "application/json";
      options.headers["Content-Length"] = Buffer.byteLength(payload);
    }

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          try {
            const parsed = JSON.parse(data);
            reject(new Error(parsed.error || `Bridge returned status ${res.statusCode}`));
          } catch {
            reject(new Error(`Bridge returned status ${res.statusCode}: ${data}`));
          }
          return;
        }

        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Failed to parse bridge response: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on("error", (err) => {
      if (err.code === "ECONNREFUSED") {
        reject(
          new Error(
            "Cannot connect to OpenWhispr. The app may not be running or " +
              "the MCP bridge port has changed. Please restart OpenWhispr."
          )
        );
      } else {
        reject(new Error(`Bridge request failed: ${err.message}`));
      }
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Bridge request timed out"));
    });

    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

/**
 * Wrap a bridge call into the MCP tool response format.
 * On success, returns the JSON-stringified data as text content.
 * On failure, returns the error message with isError: true.
 */
async function toolResponse(bridgePromise) {
  try {
    const data = await bridgePromise;
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// MCP Server definition
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "openwhispr",
  version: "1.0.0",
});

// -- get_status ---------------------------------------------------------------

server.tool(
  "get_status",
  "Get the current status of the OpenWhispr desktop app, including version, " +
    "active transcription model, provider, and activation mode",
  {},
  async () => {
    return toolResponse(callBridge("GET", "/status"));
  }
);

// -- transcribe_audio ---------------------------------------------------------

server.tool(
  "transcribe_audio",
  "Transcribe an audio file using OpenWhispr's current transcription engine " +
    "(local whisper.cpp or NVIDIA Parakeet). Accepts common audio formats " +
    "(WAV, MP3, WebM, etc.).",
  {
    filePath: z
      .string()
      .describe("Absolute path to the audio file to transcribe"),
  },
  async ({ filePath }) => {
    return toolResponse(callBridge("POST", "/transcribe", { filePath }));
  }
);

// -- start_dictation ----------------------------------------------------------

server.tool(
  "start_dictation",
  "Start live dictation recording in OpenWhispr. The app will begin " +
    "capturing audio from the default microphone.",
  {},
  async () => {
    return toolResponse(callBridge("POST", "/start-dictation"));
  }
);

// -- stop_dictation -----------------------------------------------------------

server.tool(
  "stop_dictation",
  "Stop the current live dictation recording in OpenWhispr. The captured " +
    "audio will be transcribed using the active engine.",
  {},
  async () => {
    return toolResponse(callBridge("POST", "/stop-dictation"));
  }
);

// -- get_transcriptions -------------------------------------------------------

server.tool(
  "get_transcriptions",
  "Retrieve recent transcription history from OpenWhispr's local database. " +
    "Returns transcriptions ordered by most recent first.",
  {
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .default(20)
      .describe("Maximum number of transcriptions to return (default 20, max 500)"),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .default(0)
      .describe("Number of transcriptions to skip for pagination"),
  },
  async ({ limit, offset }) => {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set("limit", String(limit));
    if (offset !== undefined) params.set("offset", String(offset));
    const qs = params.toString();
    const urlPath = qs ? `/transcriptions?${qs}` : "/transcriptions";
    return toolResponse(callBridge("GET", urlPath));
  }
);

// -- get_command_history ------------------------------------------------------

server.tool(
  "get_command_history",
  "Retrieve the command/reasoning history from OpenWhispr. Commands are " +
    "voice instructions processed by the AI reasoning engine.",
  {
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .default(20)
      .describe("Maximum number of commands to return (default 20, max 500)"),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .default(0)
      .describe("Number of commands to skip for pagination"),
    status: z
      .string()
      .optional()
      .describe("Filter by command status (e.g. 'success', 'error')"),
    provider: z
      .string()
      .optional()
      .describe("Filter by AI provider (e.g. 'openai', 'anthropic', 'local')"),
    source: z
      .string()
      .optional()
      .describe("Filter by command source"),
  },
  async ({ limit, offset, status, provider, source }) => {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set("limit", String(limit));
    if (offset !== undefined) params.set("offset", String(offset));
    if (status) params.set("status", status);
    if (provider) params.set("provider", provider);
    if (source) params.set("source", source);
    const qs = params.toString();
    const urlPath = qs ? `/command-history?${qs}` : "/command-history";
    return toolResponse(callBridge("GET", urlPath));
  }
);

// -- search_commands ----------------------------------------------------------

server.tool(
  "search_commands",
  "Search through OpenWhispr's command history by keyword. Matches against " +
    "both the command text and the original transcript.",
  {
    query: z
      .string()
      .describe("Search query to match against command text and transcripts"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .default(20)
      .describe("Maximum number of results to return (default 20, max 500)"),
  },
  async ({ query, limit }) => {
    const params = new URLSearchParams();
    params.set("q", query);
    if (limit !== undefined) params.set("limit", String(limit));
    return toolResponse(callBridge("GET", `/search-commands?${params.toString()}`));
  }
);

// -- get_command_stats --------------------------------------------------------

server.tool(
  "get_command_stats",
  "Get aggregate statistics about OpenWhispr command usage, including total " +
    "count, average duration, and breakdowns by provider, status, and source.",
  {},
  async () => {
    return toolResponse(callBridge("GET", "/command-stats"));
  }
);

// ---------------------------------------------------------------------------
// Start the server
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
