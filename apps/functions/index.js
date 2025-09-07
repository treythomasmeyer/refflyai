import * as logger from "firebase-functions/logger";
import { onRequest } from "firebase-functions/v2/https";

// Simple HTTP endpoint for first deploy
export const rulebook = onRequest(
  { region: "us-central1", invoker: "public" }, // public lets curl/browser call it
  (req, res) => {
    const q = (req.query.q || req.body?.q || "").toString().trim();
    logger.info("rulebook hit", { q });

    if (!q) {
      return res.status(200).json({
        ok: true,
        message: "Hello from RefflyAI rulebook! Pass ?q=your+question",
        example: "curl \"<FUNCTION_URL>?q=What%20is%20interference?\""
      });
    }

    // TODO: hook into mlbrules.json later
    return res.status(200).json({
      ok: true,
      query: q,
      answer: "Stub answer for first deploy. Pipeline is working."
    });
  }
);
