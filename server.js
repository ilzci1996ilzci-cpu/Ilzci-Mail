const express = require("express");
const cors = require("cors");

const app = express();

const PORT = process.env.PORT || 3000;

const API_BASE = (
  process.env.MAIL_API_BASE ||
  "https://mail-server.1timetech.com/api"
).replace(/\/+$/, "");

const APP_KEY = process.env.MAIL_APP_KEY;

app.disable("x-powered-by");

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Accept",
      "Authorization",
      "X-Requested-With",
    ],
  })
);

app.use(express.json({ limit: "64kb" }));

// ======================================================
// CUSTOM ENCODING
// ======================================================

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
  Object.entries(DEC_SW).map(([key, value]) => [value, key])
);

function encodeCustom(value) {
  const source =
    typeof value === "string"
      ? value
      : JSON.stringify(value);

  const base64 = Buffer.from(source, "utf8").toString("base64");

  const custom = [...base64]
    .map((char) => ENC_SW[char] ?? char)
    .join("");

  const reversed = [...custom].reverse().join("");

  const paddingMatch = reversed.match(/^=+/);
  const padding = paddingMatch ? paddingMatch[0].length : 0;

  return "x".repeat(padding) + reversed.slice(padding);
}

function decodeCustom(value) {
  if (typeof value !== "string" || !value.length) {
    throw new Error("Empty encoded response");
  }

  const leadingXMatch = value.match(/^x+/);
  const leadingX = leadingXMatch
    ? leadingXMatch[0].length
    : 0;

  const restored =
    "=".repeat(leadingX) +
    value.slice(leadingX);

  const reversed = [...restored]
    .reverse()
    .join("");

  const trailingMatch = reversed.match(/=+$/);

  const trailingPadding = trailingMatch
    ? trailingMatch[0].length
    : 0;

  const body = trailingPadding
    ? reversed.slice(0, -trailingPadding)
    : reversed;

  const standard =
    [...body]
      .map((char) => DEC_SW[char] ?? char)
      .join("") +
    "=".repeat(trailingPadding);

  const cleaned = standard.replace(
    /[^A-Za-z0-9+/=]/g,
    ""
  );

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

// ======================================================
// HELPERS
// ======================================================

function parseProviderResponse(raw) {
  if (raw == null || raw === "") {
    return {};
  }

  if (typeof raw !== "string") {
    return raw;
  }

  try {
    const json = JSON.parse(raw);

    if (
      json &&
      typeof json === "object" &&
      typeof json.data === "string"
    ) {
      return decodeCustom(json.data);
    }

    if (typeof json === "string") {
      return decodeCustom(json);
    }

    return json;
  } catch {
    return decodeCustom(raw);
  }
}

function extractInbox(value) {
  let root = value;

  for (let i = 0; i < 5; i++) {
    if (
      root &&
      typeof root === "object" &&
      !Array.isArray(root) &&
      root.data &&
      typeof root.data === "object"
    ) {
      root = root.data;
    } else {
      break;
    }
  }

  const candidates = [
    root,
    value,
    root?.inbox,
    root?.mailbox,
    root?.result,
    root?.data,
  ].filter(Boolean);

  let email = null;
  let id = null;

  for (const item of candidates) {
    if (!item || typeof item !== "object") {
      continue;
    }

    if (!email) {
      const possibleEmail =
        item.email ||
        item.address ||
        item.mail ||
        item.emailAddress;

      if (
        typeof possibleEmail === "string" &&
        possibleEmail.includes("@")
      ) {
        email = possibleEmail;
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
    email: email ? String(email) : null,
    id: id != null ? String(id) : null,
  };
}

function extractMessages(value) {
  let result = value;

  for (let i = 0; i < 6; i++) {
    if (Array.isArray(result)) {
      return result;
    }

    if (typeof result === "string") {
      try {
        result = JSON.parse(result);
        continue;
      } catch {
        return [];
      }
    }

    if (!result || typeof result !== "object") {
      return [];
    }

    const next =
      result.messages ??
      result.items ??
      result.emails ??
      result.results ??
      result.data ??
      result.result;

    if (next === undefined) {
      return [];
    }

    result = next;
  }

  return Array.isArray(result)
    ? result
    : [];
}

function unwrap(value) {
  let result = value;

  for (let i = 0; i < 5; i++) {
    if (
      result &&
      typeof result === "object" &&
      !Array.isArray(result)
    ) {
      if (result.data !== undefined) {
        result = result.data;
        continue;
      }

      if (result.result !== undefined) {
        result = result.result;
        continue;
      }
    }

    break;
  }

  return result;
}

// ======================================================
// PROVIDER REQUEST
// ======================================================

async function providerRequest(
  path,
  {
    method = "GET",
    params,
    body,
  } = {}
) {
  if (!APP_KEY) {
    throw new Error(
      "MAIL_APP_KEY is missing in Railway Variables."
    );
  }

  const url = new URL(
    `${API_BASE}${path}`
  );

  if (params !== undefined) {
    url.searchParams.set(
      "params",
      params
    );
  }

  const controller =
    new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    20000
  );

  try {
    const response = await fetch(
      url.toString(),
      {
        method,
        headers: {
          accept: "application/json",
          "Content-Type":
            "application/json",
          "x-app-key": APP_KEY,
          "User-Agent":
            "okhttp/4.12.0",
        },
        ...(body !== undefined
          ? {
              body: JSON.stringify(body),
            }
          : {}),
        signal: controller.signal,
      }
    );

    const raw =
      await response.text();

    if (!response.ok) {
      throw new Error(
        `Mail provider HTTP ${response.status}: ${raw.slice(
          0,
          500
        )}`
      );
    }

    return parseProviderResponse(
      raw
    );
  } finally {
    clearTimeout(timer);
  }
}

// ======================================================
// ROUTES
// ======================================================

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "Ilzci Mail",
    status: "online",
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "Ilzci Mail",
  });
});

app.get(
  "/api/diagnostics",
  (_req, res) => {
    res.json({
      ok: true,
      backend: "online",
      apiKeyConfigured:
        Boolean(APP_KEY),
      provider:
        API_BASE,
      routes: {
        create:
          "POST /api/inboxes",
        messages:
          "GET /api/inboxes/:id/messages?email=...",
        message:
          "GET /api/inboxes/:id/messages/:messageId?email=...",
      },
    });
  }
);

// ======================================================
// CREATE INBOX
// ======================================================

app.post(
  "/api/inboxes",
  async (_req, res) => {
    try {
      const encoded =
        encodeCustom({});

      const provider =
        await providerRequest(
          "/g-mail",
          {
            method: "POST",
            params: encoded,
            body: {
              data: encoded,
            },
          }
        );

      const inbox =
        extractInbox(provider);

      if (
        !inbox.email ||
        !inbox.id
      ) {
        console.error(
          "Invalid provider inbox response:",
          provider
        );

        return res.status(502).json({
          ok: false,
          error:
            "The mail provider returned an invalid inbox response.",
          providerResponse:
            provider,
        });
      }

      return res.json({
        ok: true,
        email: inbox.email,
        id: inbox.id,
      });
    } catch (error) {
      console.error(
        "CREATE INBOX ERROR:",
        error
      );

      return res.status(502).json({
        ok: false,
        error:
          error.message ||
          "Failed to create inbox.",
      });
    }
  }
);

// ======================================================
// MESSAGE LIST
// ======================================================

app.get(
  "/api/inboxes/:id/messages",
  async (req, res) => {
    try {
      const id =
        String(req.params.id || "").trim();

      const email =
        String(
          req.query.email || ""
        ).trim();

      if (!id) {
        return res.status(400).json({
          ok: false,
          error:
            "Inbox ID is required.",
        });
      }

      if (
        !email ||
        !email.includes("@")
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Valid email is required.",
        });
      }

      const token =
        encodeCustom({
          email,
        });

      const provider =
        await providerRequest(
          `/email/${encodeURIComponent(
            id
          )}/messages`,
          {
            method: "GET",
            params: token,
          }
        );

      return res.json({
        ok: true,
        messages:
          extractMessages(provider),
      });
    } catch (error) {
      console.error(
        "MESSAGE LIST ERROR:",
        error
      );

      return res.status(502).json({
        ok: false,
        error:
          error.message ||
          "Failed to retrieve messages.",
      });
    }
  }
);

// ======================================================
// MESSAGE DETAILS
// ======================================================

app.get(
  "/api/inboxes/:id/messages/:messageId",
  async (req, res) => {
    try {
      const id =
        String(req.params.id || "").trim();

      const messageId =
        String(
          req.params.messageId || ""
        ).trim();

      const email =
        String(
          req.query.email || ""
        ).trim();

      if (!id || !messageId) {
        return res.status(400).json({
          ok: false,
          error:
            "Inbox ID and message ID are required.",
        });
      }

      if (
        !email ||
        !email.includes("@")
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Valid email is required.",
        });
      }

      const token =
        encodeCustom({
          email,
        });

      const provider =
        await providerRequest(
          `/email/${encodeURIComponent(
            id
          )}/messages/${encodeURIComponent(
            messageId
          )}`,
          {
            method: "GET",
            params: token,
          }
        );

      return res.json({
        ok: true,
        message:
          unwrap(provider),
      });
    } catch (error) {
      console.error(
        "MESSAGE DETAIL ERROR:",
        error
      );

      return res.status(502).json({
        ok: false,
        error:
          error.message ||
          "Failed to retrieve message.",
      });
    }
  }
);

// ======================================================
// 404
// ======================================================

app.use(
  (req, res) => {
    res.status(404).json({
      ok: false,
      error: "Route not found.",
      method: req.method,
      path: req.path,
    });
  }
);

// ======================================================
// ERROR HANDLER
// ======================================================

app.use(
  (
    error,
    _req,
    res,
    _next
  ) => {
    console.error(
      "SERVER ERROR:",
      error
    );

    res.status(500).json({
      ok: false,
      error:
        error.message ||
        "Internal server error.",
    });
  }
);

// ======================================================
// START
// ======================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Ilzci Mail listening on ${PORT}`
    );

    console.log(
      `Provider: ${API_BASE}`
    );

    console.log(
      `MAIL_APP_KEY configured: ${Boolean(
        APP_KEY
      )}`
    );
  }
);