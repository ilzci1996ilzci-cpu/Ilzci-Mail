const express = require("express");
const cors = require("cors");

const app = express();

const PORT = Number(process.env.PORT) || 3000;

const API_BASE = (
  process.env.MAIL_API_BASE ||
  "https://mail-server.1timetech.com/api"
).replace(/\/+$/, "");

const MAIL_APP_KEY = process.env.MAIL_APP_KEY || "";

/*
|--------------------------------------------------------------------------
| Middleware
|--------------------------------------------------------------------------
*/

app.disable("x-powered-by");

app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: [
      "Accept",
      "Content-Type",
      "Authorization",
    ],
  })
);

app.options("*", cors());

app.use(
  express.json({
    limit: "64kb",
  })
);

/*
|--------------------------------------------------------------------------
| Custom provider encoding
|--------------------------------------------------------------------------
*/

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
  Object.entries(DEC_SW).map(([key, value]) => [
    value,
    key,
  ])
);

/*
|--------------------------------------------------------------------------
| Error
|--------------------------------------------------------------------------
*/

class ApiError extends Error {
  constructor(
    message,
    status = 500,
    source = "backend",
    details = {}
  ) {
    super(message);

    this.name = "ApiError";
    this.status = status;
    this.source = source;
    this.details = details;
  }
}

/*
|--------------------------------------------------------------------------
| Encode
|--------------------------------------------------------------------------
*/

function encodeCustom(value) {
  const source =
    typeof value === "string"
      ? value
      : JSON.stringify(value);

  const base64 = Buffer
    .from(source, "utf8")
    .toString("base64");

  const substituted = [...base64]
    .map((char) => ENC_SW[char] ?? char)
    .join("");

  const reversed = [...substituted]
    .reverse()
    .join("");

  const padding =
    (reversed.match(/^=+/) || [""])[0].length;

  return (
    "x".repeat(padding) +
    reversed.slice(padding)
  );
}

/*
|--------------------------------------------------------------------------
| Decode
|--------------------------------------------------------------------------
*/

function decodeCustom(value) {
  if (
    typeof value !== "string" ||
    value.length === 0
  ) {
    throw new Error(
      "Empty encoded response."
    );
  }

  const leadingX =
    (value.match(/^x+/) || [""])[0].length;

  const restored =
    "=".repeat(leadingX) +
    value.slice(leadingX);

  const reversed =
    [...restored]
      .reverse()
      .join("");

  const trailingPadding =
    (reversed.match(/=+$/) || [""])[0].length;

  const body = trailingPadding
    ? reversed.slice(0, -trailingPadding)
    : reversed;

  const standard =
    [...body]
      .map((char) => DEC_SW[char] ?? char)
      .join("") +
    "=".repeat(trailingPadding);

  const cleaned =
    standard.replace(
      /[^A-Za-z0-9+/=]/g,
      ""
    );

  const buffer =
    Buffer.from(cleaned, "base64");

  const text =
    buffer.toString("utf8");

  try {
    const parsed =
      JSON.parse(text);

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

/*
|--------------------------------------------------------------------------
| Parse provider response
|--------------------------------------------------------------------------
*/

function parseProviderResponse(raw) {
  if (
    raw === undefined ||
    raw === null ||
    raw === ""
  ) {
    return {};
  }

  if (
    typeof raw !== "string"
  ) {
    return raw;
  }

  try {
    const json =
      JSON.parse(raw);

    if (
      typeof json === "string"
    ) {
      try {
        return decodeCustom(json);
      } catch {
        return json;
      }
    }

    /*
     * Provider normally returns:
     *
     * {
     *   data: "ENCODED_DATA"
     * }
     */

    if (
      typeof json.data === "string"
    ) {
      return decodeCustom(json.data);
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

/*
|--------------------------------------------------------------------------
| Provider request
|--------------------------------------------------------------------------
*/

async function providerRequest(
  path,
  {
    method = "GET",
    params,
    body,
  } = {}
) {
  if (!MAIL_APP_KEY) {
    throw new ApiError(
      "MAIL_APP_KEY is not configured in Railway Variables.",
      503,
      "configuration"
    );
  }

  const url =
    new URL(
      `${API_BASE}${path}`
    );

  if (
    params !== undefined
  ) {
    url.searchParams.set(
      "params",
      params
    );
  }

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      18000
    );

  try {
    const headers = {
      Accept:
        "application/json",
      "Content-Type":
        "application/json",
      "User-Agent":
        "okhttp/4.12.0",
      "x-app-key":
        MAIL_APP_KEY,
    };

    const response =
      await fetch(
        url.toString(),
        {
          method,
          headers,
          ...(body !== undefined
            ? {
                body:
                  JSON.stringify(body),
              }
            : {}),
          signal:
            controller.signal,
        }
      );

    const raw =
      await response.text();

    if (!response.ok) {
      throw new ApiError(
        `Mail provider returned HTTP ${response.status}.`,
        502,
        "mail_provider",
        {
          upstreamStatus:
            response.status,

          upstreamPath:
            path,

          upstreamBody:
            raw.slice(0, 1500),
        }
      );
    }

    return parseProviderResponse(
      raw
    );
  } catch (error) {
    if (
      error instanceof ApiError
    ) {
      throw error;
    }

    if (
      error?.name ===
      "AbortError"
    ) {
      throw new ApiError(
        "Mail provider request timed out.",
        504,
        "mail_provider",
        {
          upstreamPath:
            path,
        }
      );
    }

    throw new ApiError(
      "Could not connect to the mail provider.",
      502,
      "mail_provider",
      {
        upstreamPath:
          path,

        reason:
          String(
            error?.message ||
              error
          ),
      }
    );
  } finally {
    clearTimeout(timeout);
  }
}

/*
|--------------------------------------------------------------------------
| Object helpers
|--------------------------------------------------------------------------
*/

function unwrap(value) {
  let result = value;

  for (
    let i = 0;
    i < 5;
    i++
  ) {
    if (
      !result ||
      typeof result !==
        "object" ||
      Array.isArray(result)
    ) {
      break;
    }

    if (
      result.data &&
      typeof result.data ===
        "object"
    ) {
      result =
        result.data;

      continue;
    }

    if (
      result.result &&
      typeof result.result ===
        "object"
    ) {
      result =
        result.result;

      continue;
    }

    break;
  }

  return result;
}

/*
|--------------------------------------------------------------------------
| Extract inbox
|--------------------------------------------------------------------------
*/

function extractInbox(value) {
  const root =
    unwrap(value);

  const candidates = [
    root,
    root?.email,
    root?.inbox,
    root?.mailbox,
    root?.data,
    value?.data,
    value?.result,
  ].filter(
    (item) =>
      item &&
      typeof item ===
        "object"
  );

  let email = null;
  let id = null;

  for (
    const item of candidates
  ) {
    if (!email) {
      const possibleEmail =
        item.email ??
        item.address ??
        item.mail;

      if (
        typeof possibleEmail ===
          "string" &&
        possibleEmail.includes("@")
      ) {
        email =
          possibleEmail;
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
    email:
      typeof email ===
      "string"
        ? email
        : null,

    id:
      id == null
        ? null
        : String(id),
  };
}

/*
|--------------------------------------------------------------------------
| Extract messages
|--------------------------------------------------------------------------
*/

function extractMessages(
  value
) {
  let result = value;

  for (
    let i = 0;
    i < 6;
    i++
  ) {
    if (
      Array.isArray(result)
    ) {
      return result;
    }

    if (
      typeof result ===
      "string"
    ) {
      try {
        result =
          JSON.parse(
            result
          );

        continue;
      } catch {
        return [];
      }
    }

    if (
      !result ||
      typeof result !==
        "object"
    ) {
      return [];
    }

    const next =
      result.messages ??
      result.items ??
      result.emails ??
      result.results ??
      result.data;

    if (
      next === undefined
    ) {
      return [];
    }

    result = next;
  }

  return Array.isArray(result)
    ? result
    : [];
}

/*
|--------------------------------------------------------------------------
| Validate email
|--------------------------------------------------------------------------
*/

function getEmail(req) {
  const email =
    String(
      req.query.email ||
        ""
    ).trim();

  if (
    !email ||
    !email.includes("@")
  ) {
    throw new ApiError(
      "A valid email query parameter is required.",
      400,
      "validation"
    );
  }

  return email;
}

/*
|--------------------------------------------------------------------------
| Root
|--------------------------------------------------------------------------
*/

app.get(
  "/",
  (_req, res) => {
    res.json({
      ok: true,
      service:
        "Ilzci Mail Backend",
      message:
        "Backend is online",
    });
  }
);

/*
|--------------------------------------------------------------------------
| Health
|--------------------------------------------------------------------------
*/

app.get(
  "/health",
  (_req, res) => {
    res.json({
      ok: true,
      service:
        "Ilzci Mail Backend",
      configured:
        Boolean(MAIL_APP_KEY),
      upstream:
        API_BASE,
    });
  }
);

/*
|--------------------------------------------------------------------------
| Diagnostics
|--------------------------------------------------------------------------
*/

app.get(
  "/api/diagnostics",
  (_req, res) => {
    res.json({
      ok: true,

      backend:
        "online",

      apiKeyConfigured:
        Boolean(MAIL_APP_KEY),

      upstream:
        API_BASE,

      node:
        process.version,

      routes: [
        "POST /api/inboxes",
        "GET /api/inboxes/:id/messages?email=...",
        "GET /api/inboxes/:id/messages/:messageId?email=...",
      ],
    });
  }
);

/*
|--------------------------------------------------------------------------
| CREATE INBOX
|--------------------------------------------------------------------------
*/

app.post(
  "/api/inboxes",
  async (_req, res, next) => {
    try {
      const encoded =
        encodeCustom({});

      const result =
        await providerRequest(
          "/g-mail",
          {
            method: "POST",

            params:
              encoded,

            body: {
              data:
                encoded,
            },
          }
        );

      const inbox =
        extractInbox(
          result
        );

      if (
        !inbox.email ||
        !inbox.id
      ) {
        throw new ApiError(
          "The mail provider returned an unrecognized inbox response.",
          502,
          "mail_provider_response",
          {
            responseType:
              typeof result,

            responseKeys:
              result &&
              typeof result ===
                "object" &&
              !Array.isArray(
                result
              )
                ? Object.keys(
                    result
                  ).slice(
                    0,
                    30
                  )
                : [],

            responsePreview:
              typeof result ===
              "string"
                ? result.slice(
                    0,
                    800
                  )
                : undefined,
          }
        );
      }

      res.json({
        ok: true,
        email:
          inbox.email,
        id:
          inbox.id,
      });
    } catch (error) {
      next(error);
    }
  }
);

/*
|--------------------------------------------------------------------------
| LIST MESSAGES
|--------------------------------------------------------------------------
*/

app.get(
  "/api/inboxes/:id/messages",
  async (
    req,
    res,
    next
  ) => {
    try {
      const id =
        String(
          req.params.id ||
            ""
        ).trim();

      if (!id) {
        throw new ApiError(
          "Inbox ID is required.",
          400,
          "validation"
        );
      }

      const email =
        getEmail(req);

      const encoded =
        encodeCustom({
          email,
        });

      const result =
        await providerRequest(
          `/email/${encodeURIComponent(
            id
          )}/messages`,
          {
            method:
              "GET",

            params:
              encoded,
          }
        );

      res.json({
        ok: true,

        messages:
          extractMessages(
            result
          ),
      });
    } catch (error) {
      next(error);
    }
  }
);

/*
|--------------------------------------------------------------------------
| MESSAGE DETAILS
|--------------------------------------------------------------------------
*/

app.get(
  "/api/inboxes/:id/messages/:messageId",
  async (
    req,
    res,
    next
  ) => {
    try {
      const id =
        String(
          req.params.id ||
            ""
        ).trim();

      const messageId =
        String(
          req.params.messageId ||
            ""
        ).trim();

      if (!id) {
        throw new ApiError(
          "Inbox ID is required.",
          400,
          "validation"
        );
      }

      if (!messageId) {
        throw new ApiError(
          "Message ID is required.",
          400,
          "validation"
        );
      }

      const email =
        getEmail(req);

      const encoded =
        encodeCustom({
          email,
        });

      const result =
        await providerRequest(
          `/email/${encodeURIComponent(
            id
          )}/messages/${encodeURIComponent(
            messageId
          )}`,
          {
            method:
              "GET",

            params:
              encoded,
          }
        );

      res.json({
        ok: true,

        message:
          unwrap(result),
      });
    } catch (error) {
      next(error);
    }
  }
);

/*
|--------------------------------------------------------------------------
| 404
|--------------------------------------------------------------------------
*/

app.use(
  (req, res) => {
    res.status(404).json({
      ok: false,

      source:
        "ilzci_mail_backend",

      error:
        "Route not found.",

      method:
        req.method,

      path:
        req.originalUrl,
    });
  }
);

/*
|--------------------------------------------------------------------------
| Error handler
|--------------------------------------------------------------------------
*/

app.use(
  (
    error,
    _req,
    res,
    _next
  ) => {
    const status =
      Number(
        error?.status
      ) || 500;

    console.error(
      "[Ilzci Mail]",
      {
        source:
          error?.source ||
          "backend",

        status,

        message:
          error?.message ||
          "Unknown error",

        details:
          error?.details ||
          {},
      }
    );

    res.status(status).json({
      ok: false,

      source:
        error?.source ||
        "backend",

      error:
        error?.message ||
        "Internal server error",

      ...(error?.details ||
        {}),
    });
  }
);

/*
|--------------------------------------------------------------------------
| Start
|--------------------------------------------------------------------------
*/

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Ilzci Mail Backend listening on port ${PORT}`
    );

    console.log(
      `Provider: ${API_BASE}`
    );

    console.log(
      `MAIL_APP_KEY configured: ${Boolean(
        MAIL_APP_KEY
      )}`
    );
  }
);