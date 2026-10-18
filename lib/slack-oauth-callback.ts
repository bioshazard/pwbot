import { timingSafeEqual } from "node:crypto";

import { SlackMcpError } from "./errors";

type OAuthResult =
  | { ok: true; code: string }
  | { ok: false; error: SlackMcpError };

const respond = (text: string, status: number) =>
  new Response(text, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'",
      "Referrer-Policy": "no-referrer",
    },
    status,
  });

export const createSlackOAuthCallback = (
  redirect: URL,
  state: string,
  settle: (result: OAuthResult) => void
) => {
  let used = false;
  return (request: Request): Response => {
    const url = new URL(request.url);
    if (
      request.method !== "GET" ||
      url.origin !== redirect.origin ||
      url.pathname !== redirect.pathname
    ) {
      return respond("Not found", 404);
    }
    if (used) {
      return respond("Authorization callback already used", 409);
    }
    const actual = url.searchParams.get("state") ?? "";
    if (
      url.searchParams.getAll("state").length !== 1 ||
      Buffer.byteLength(actual) !== Buffer.byteLength(state) ||
      !timingSafeEqual(Buffer.from(actual), Buffer.from(state))
    ) {
      return respond("Invalid authorization state", 400);
    }
    if (url.searchParams.has("error")) {
      used = true;
      settle({
        error: new SlackMcpError({ operation: "authorization denied" }),
        ok: false,
      });
      return respond(
        "Slack authorization was declined. Nothing was connected.",
        400
      );
    }
    const code = url.searchParams.get("code");
    if (
      code === null ||
      code.length === 0 ||
      code.length > 2048 ||
      url.searchParams.getAll("code").length !== 1
    ) {
      return respond("Missing or invalid authorization code", 400);
    }
    used = true;
    settle({ code, ok: true });
    return respond(
      "Authorization received. Check the terminal for the connection result. You may close this tab.",
      200
    );
  };
};
