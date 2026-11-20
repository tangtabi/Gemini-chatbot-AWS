import express from "express";
import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
import serverless from "serverless-http";

import {
  SecretsManagerClient,
  GetSecretValueCommand
} from "@aws-sdk/client-secrets-manager";

import {
  DynamoDBClient
} from "@aws-sdk/client-dynamodb";

import {
  DynamoDBDocumentClient,
  UpdateCommand
} from "@aws-sdk/lib-dynamodb";

// --------------------------------------------------
// AWS CLIENTS
// --------------------------------------------------

const awsRegion = process.env.AWS_REGION || "eu-north-1";

const dynamoClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    region: awsRegion
  })
);

const secretsClient = new SecretsManagerClient({
  region: awsRegion
});

// --------------------------------------------------
// RATE LIMITER
// 100 requests per IP per 60-second window
// --------------------------------------------------

async function checkRateLimit(ip) {
  const tableName = process.env.RATE_LIMIT_TABLE;

  if (!tableName) {
    throw new Error("RATE_LIMIT_TABLE environment variable is missing.");
  }

  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / 60) * 60;

  const key = `${ip}#${windowStart}`;
  const expiresAt = windowStart + 120;

  const result = await dynamoClient.send(
    new UpdateCommand({
      TableName: tableName,
      Key: {
        ip_window: key
      },
      UpdateExpression:
        "SET expires_at = :expires ADD request_count :one",
      ExpressionAttributeValues: {
        ":expires": expiresAt,
        ":one": 1
      },
      ReturnValues: "UPDATED_NEW"
    })
  );

  const requestCount = result.Attributes?.request_count;

  if (typeof requestCount !== "number") {
    throw new Error("Could not retrieve rate-limit counter.");
  }

  return requestCount <= 100;
}

// --------------------------------------------------
// EXPRESS APP
// --------------------------------------------------

const app = express();

app.use(express.json({ limit: "10kb" }));
app.use(express.static("public"));

const model =
  process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

// --------------------------------------------------
// PII DETECTION AND REDACTION
// --------------------------------------------------

function redactPII(text) {
  let sanitized = text;

  // Redact email addresses
  sanitized = sanitized.replace(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    "[EMAIL REDACTED]"
  );

  // Redact credit card-like numbers
  sanitized = sanitized.replace(
    /\b(?:\d[ -]?){13,19}\b/g,
    "[CARD REDACTED]"
  );

  // Redact US Social Security Numbers
  sanitized = sanitized.replace(
    /\b\d{3}-\d{2}-\d{4}\b/g,
    "[SSN REDACTED]"
  );

  // Redact phone numbers
  sanitized = sanitized.replace(
    /(?<!\w)(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3,4}[\s.-]?\d{3,4}(?!\w)/g,
    "[PHONE REDACTED]"
  );

  return sanitized;
}

// --------------------------------------------------
// GEMINI AUTHENTICATION
// --------------------------------------------------

let ai;

async function getAI() {
  if (ai) return ai;

  let apiKey;

  if (process.env.NODE_ENV === "production") {
    const secretId = process.env.GEMINI_SECRET_ID;

    if (!secretId) {
      throw new Error("GEMINI_SECRET_ID is not configured.");
    }

    const result = await secretsClient.send(
      new GetSecretValueCommand({
        SecretId: secretId
      })
    );

    apiKey = result.SecretString;
  } else {
    apiKey = process.env.GEMINI_API_KEY;
  }

  if (!apiKey) {
    throw new Error("Gemini API key is missing.");
  }

  ai = new GoogleGenAI({ apiKey });

  return ai;
}

// --------------------------------------------------
// HEALTH CHECK
// --------------------------------------------------

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// --------------------------------------------------
// CHAT ENDPOINT
// --------------------------------------------------

app.post("/chat", async (req, res) => {
  const message = req.body?.message;

  // Validate message
  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({
      error: "Message is required."
    });
  }

  // Enforce message length
  if (message.length > 4000) {
    return res.status(400).json({
      error: "Message is too long."
    });
  }

  // ----------------------------------------------
  // RATE LIMITING
  // ----------------------------------------------

  if (process.env.NODE_ENV === "production") {
    try {
      const forwardedFor =
        req.headers["x-forwarded-for"];

      const ip =
        (typeof forwardedFor === "string"
          ? forwardedFor.split(",")[0].trim()
          : null) ||
        req.socket.remoteAddress ||
        "unknown";

      const allowed = await checkRateLimit(ip);

      if (!allowed) {
        return res.status(429).json({
          error: "Too many requests. Please try again after the rate limit resets."
        });
      }
    } catch (error) {
      console.error("Rate limiter error:", error.message);

      return res.status(503).json({
        error: "Service temporarily unavailable. Please try again later."
      });
    }
  }

  // ----------------------------------------------
  // PII REDACTION
  // ----------------------------------------------

  const sanitizedMessage = redactPII(message.trim());

  console.log("PII redaction applied to incoming message.");

  // ----------------------------------------------
  // GEMINI REQUEST
  // ----------------------------------------------

  try {
    const gemini = await getAI();

    const response = await gemini.models.generateContent({
      model,
      contents: sanitizedMessage
    });

    return res.json({
      reply: response.text
    });
  } catch (error) {
    console.error("Gemini error:", error.message);

    return res.status(502).json({
      error: "Gemini request failed."
    });
  }
});

// --------------------------------------------------
// AWS LAMBDA HANDLER
// --------------------------------------------------

export const handler = serverless(app);

// --------------------------------------------------
// LOCAL DEVELOPMENT SERVER
// --------------------------------------------------

if (process.env.NODE_ENV !== "production") {
  app.listen(Number(process.env.PORT) || 3000, () => {
    console.log("Gemini chatbot running at http://localhost:3000");
  });
}