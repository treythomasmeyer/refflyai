import { onRequest } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2/options";

setGlobalOptions({ region: "us-central1" });

export const rulebook = onRequest((req, res) => {
  const q = (req.query.q as string) || "What is the infield fly?";
  res.json({
    ok: true,
    received: q,
    ruling_short: "Stub: infield fly = batter out with R1+R2 (<2 outs) on a fair fly an infielder can catch with ordinary effort.",
    rule_ids: ["infield_fly_definition"]
  });
});
