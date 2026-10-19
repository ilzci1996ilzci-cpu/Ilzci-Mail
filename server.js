
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;
const API_BASE = (
  process.env.MAIL_API_BASE ||
  "https://mail-server.1timetech.com/api"
).replace(/\/+$/, "");

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));

const DEC_SW = {
  "*": "4",
  "=": "x",
  B: "z",
  z: "B",
  "5": "b",
  b: "5",
  a: "o",
  o: "a",
  q: "s",
  s: "q",
};

const ENC_SW = Object.fromEntries(
  Object.entries(DEC_SW).map(([key, value]) => [value, key]),
);

class ApiError extends Error {
  constructor(message, status = 502, source = "backend", details = {}) {
    super(message);
    this.status = status;
    this.source = source;
    this.details = details;
  }
}

function encodeCustom(value) {
  const source =
    typeof value === "string" ? value : JSON.stringify(value);

  const base64 = Buffer.from(source, "utf8").toString("base64");

  const substituted = [...base64]
    .map((char) => ENC_SW[char] ?? char)
    .join("");

  const reversed = [...substituted].reverse().join("");
  const padding = (reversed.match(/^=+/) || [""])[0].length;

  return "x".repeat(padding) + reversed.slice(padding);
}

function decodeCustom(value) {
  if (typeof value !== "string" || !value.length) {
    throw new Error("Empty encoded response");
  }

  const leadingX = (value.match(/^x+/) || [""])[0].length;
  const restored = "=".repeat(leadingX) + value.slice(leadingX);
  const reversed = [...restored].reverse().join("");

  const trailingPadding = (reversed.match(/=+$/) || [""])[0].length;
  const body = trailingPadding
    ? reversed.slice(0, -trailingPadding)
    : reversed;

  const standard = [...body]
    .map((char) => DEC_SW[char] ?? char)
    .join("") + "=".repeat(trailingPadding);

  const cleaned = standard.replace(/[^A-Za-z0-9+/=]/g, "");
  const buffer = Buffer.from(cleaned, "base64");
  const text = buffer.toString("utf8");

  try {
    const parsed = JSON.parse(text);

    if (typeof parsed === "string") {
      try {
        return JSON.parse(parsed);
      } catch {
        return parsed;
      }
    }

    return parsed;
  } catch {
    return text;
  }
}

function parseUpstreamBody(raw) {
  if (raw == null || raw === "") return {};

  if (typeof raw !== "string") return raw;

  try {
    const json = JSON.parse(raw);

    if (typeof json === "string") {
      try {
        return decodeCustom(json);
      } catch {
        return json;
      }
    }

    return json;
  } catch {
    try {
      return decodeCustom(raw);
    } catch {
      return raw;
    }
  }
}

async function upstreamRequest(path, { method = "GET", params, body } = {}) {
  const appKey = process.env.MAIL_APP_KEY;

  if (!appKey) {
    throw new ApiError(
      "MAIL_APP_KEY is not configured in Railway Variables.",
      503,
      "configuration",
    );
  }

  const url = new URL(`${API_BASE}${path}`);

  if (params !== undefined) {
    url.searchParams.set("params", params);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 18000);

  try {
    const response = await fetch(url.toString(), {
      method,
      headers: {
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "User-Agent": "okhttp/4.12.0",
        "x-app-key": appKey,
      },
      ...(body !== undefined
        ? { body: JSON.stringify(body) }
        : {}),
      signal: controller.signal,
    });

    const raw = await response.text();

    if (!response.ok) {
      throw new ApiError(
        `Mail provider returned HTTP ${response.status}.`,
        502,
        "mail_provider",
        {
          upstreamStatus: response.status,
          upstreamBody: raw.slice(0, 1200),
          upstreamPath: path,
        },
      );
    }

    return parseUpstreamBody(raw);
  } catch (error) {
    if (error instanceof ApiError) throw error;

    if (error.name === "AbortError") {
      throw new ApiError(
        "Mail provider timed out.",
        504,
        "mail_provider",
        { upstreamPath: path },
      );
    }

    throw new ApiError(
      "Could not connect to the mail provider.",
      502,
      "mail_provider",
      {
        reason: String(error.message || error),
        upstreamPath: path,
      },
    );
  } finally {
    clearTimeout(timeout);
  }
}

function unwrap(value) {
  let result = value;

  for (let i = 0; i < 4; i++) {
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      break;
    }

    if (result.data && typeof result.data === "object") {
      result = result.data;
      continue;
    }

    if (result.result && typeof result.result === "object") {
      result = result.result;
      continue;
    }

    break;
  }

  return result;
}

function extractInbox(value) {
  const root = unwrap(value);
  const candidates = [
    root,
    root?.email,
    root?.inbox,
    root?.mailbox,
    root?.data,
    value?.data,
    value?.result,
  ].filter((item) => item && typeof item === "object");

  let email;
  let id;

  for (const item of candidates) {
    if (!email) {
      if (typeof item.email === "string" && item.email.includes("@")) {
        email = item.email;
      } else if (
        typeof item.address === "string" &&
        item.address.includes("@")
      ) {
        email = item.address;
      } else if (
        typeof item.mail === "string" &&
        item.mail.includes("@")
      ) {
        email = item.mail;
      }
    }

    if (id == null) {
      id =
        item.id ??
        item._id ??
        item.emailId ??
        item.email_id ??
        item.inboxId ??
        item.inbox_id;
    }
  }

  return {
    email: typeof email === "string" ? email : null,
    id: id == null ? null : String(id),
  };
}

function extractMessageArray(value) {
  let result = value;

  for (let i = 0; i < 4; i++) {
    if (Array.isArray(result)) return result;

    if (typeof result === "string") {
      try {
        result = JSON.parse(result);
        continue;
      } catch {
        return [];
      }
    }

    if (!result || typeof result !== "object") return [];

    const next =
      result.messages ??
      result.items ??
      result.emails ??
      result.results ??
      result.data;

    if (next === undefined) return [];
    result = next;
  }

  return Array.isArray(result) ? result : [];
}

function requireEmail(req) {
  const email = String(req.query.email || "").trim();

  if (!email || !email.includes("@")) {
    throw new ApiError(
      "A valid email query parameter is required.",
      400,
      "validation",
    );
  }

  return email;
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "Ilzci Mail Backend",
    message: "Backend is online",
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "Ilzci Mail Backend",
    configured: Boolean(process.env.MAIL_APP_KEY),
    upstream: API_BASE,
  });
});

app.get("/api/diagnostics", (_req, res) => {
  res.json({
    ok: true,
    backend: "online",
    apiKeyConfigured: Boolean(process.env.MAIL_APP_KEY),
    upstreamConfigured: Boolean(API_BASE),
    nodeVersion: process.version,
    routes: [
      "POST /api/inboxes",
      "GET /api/inboxes/:id/messages?email=...",
      "GET /api/inboxes/:id/messages/:messageId?email=...",
    ],
  });
});

// Create an inbox through the upstream /g-mail endpoint.
app.post("/api/inboxes", async (_req, res, next) => {
  try {
    const encoded = encodeCustom({});
    const result = await upstreamRequest("/g-mail", {
      method: "POST",
      params: encoded,
      body: { data: encoded },
    });

    const inbox = extractInbox(result);

    if (!inbox.email || !inbox.id) {
      throw new ApiError(
        "The provider responded, but its inbox response format was not recognized.",
        502,
        "mail_provider_response",
        {
          responseType: typeof result,
          responseKeys:
            result && typeof result === "object" && !Array.isArray(result)
              ? Object.keys(result).slice(0, 30)
              : [],
          responsePreview:
            typeof result === "string"
              ? result.slice(0, 500)
              : undefined,
        },
      );
    }

    res.json({
      ok: true,
      email: inbox.email,
      id: inbox.id,
    });
  } catch (error) {
    next(error);
  }
});

// Get the inbox message list.
app.get("/api/inboxes/:id/messages", async (req, res, next) => {
  try {
    const id = String(req.params.id || "").trim();
    const email = requireEmail(req);

    if (!id) {
      throw new ApiError("Inbox ID is required.", 400, "validation");
    }

    const encoded = encodeCustom({ email });

    const result = await upstreamRequest(
      `/email/${encodeURIComponent(id)}/messages`,
      { params: encoded },
    );

    res.json({
      ok: true,
      messages: extractMessageArray(result),
    });
  } catch (error) {
    next(error);
  }
});

// Get one message's full details.
app.get(
  "/api/inboxes/:id/messages/:messageId",
  async (req, res, next) => {
    try {
      const id = String(req.params.id || "").trim();
      const messageId = String(req.params.messageId || "").trim();
      const email = requireEmail(req);

      const encoded = encodeCustom({ email });

      const result = await upstreamRequest(
        `/email/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}`,
        { params: encoded },
      );

      res.json({
        ok: true,
        message: unwrap(result),
      });
    } catch (error) {
      next(error);
    }
  },
);

// Make missing local routes distinguishable from upstream errors.
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    source: "railway_backend",
    error: "Local API route not found.",
    method: req.method,
    path: req.path,
  });
});

app.use((error, _req, res, _next) => {
  const status = Number(error.status) || 500;

  // Do not log the API key or request headers.
  console.error("[Ilzci Mail]", {
    source: error.source || "backend",
    status,
    message: error.message,
    details: error.details || {},
  });

  res.status(status).json({
    ok: false,
    source: error.source || "backend",
    error: error.message || "Internal server error",
    ...(error.details || {}),
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Ilzci Mail Backend listening on port ${PORT}`);
});
