
import express from "express";
import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
import serverless from "serverless-http";
import {
  SecretsManagerClient,
  GetSecretValueCommand
} from "@aws-sdk/client-secrets-manager";

const app = express();

app.use(express.json({ limit: "10kb" }));
app.use(express.static("public"));

const model =
  process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

const secretsClient = new SecretsManagerClient({
  region: process.env.AWS_REGION
});

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

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Chat endpoint
app.post("/chat", async (req, res) => {
  try {
    const message = req.body?.message;

    if (typeof message !== "string" || !message.trim()) {
      return res.status(400).json({
        error: "Message is required."
      });
    }

    if (message.length > 4000) {
      return res.status(400).json({
        error: "Message is too long."
      });
    }

    const gemini = await getAI();

    const response = await gemini.models.generateContent({
      model,
      contents: message.trim()
    });

    res.json({
      reply: response.text
    });

  } catch (error) {
    console.error("Gemini error:", error.message);

    res.status(502).json({
      error: "Gemini request failed."
    });
  }
});

// AWS Lambda handler
export const handler = serverless(app);

// Local development server
if (process.env.NODE_ENV !== "production") {
  app.listen(Number(process.env.PORT) || 3000, () => {
    console.log(
      "Gemini chatbot running at http://localhost:3000"
    );
  });
}
