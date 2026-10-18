import { expect, test } from "bun:test";

import {
  acceptsSlackMcpTool,
  isReadOnlyPublicGrant,
  slackMcpScopes,
} from "../../lib/slack-mcp-policy";
import { buildSlackAuthorizeUrl } from "../../lib/slack-oauth";
import { createSlackOAuthCallback } from "../../lib/slack-oauth-callback";

const redirect = new URL("http://localhost:43931/slack/oauth/callback");

test("live Slack policy rejects write tools, write scopes and private scopes", () => {
  expect(
    acceptsSlackMcpTool({
      annotations: { readOnlyHint: true },
      name: "slack_read_thread",
    })
  ).toBe(true);
  expect(
    acceptsSlackMcpTool({
      annotations: { readOnlyHint: false },
      name: "slack_read_thread",
    })
  ).toBe(false);
  expect(
    acceptsSlackMcpTool({
      annotations: { readOnlyHint: true },
      name: "slack_send_message",
    })
  ).toBe(false);
  expect(isReadOnlyPublicGrant([...slackMcpScopes, "identify"])).toBe(true);
  expect(isReadOnlyPublicGrant([...slackMcpScopes, "chat:write"])).toBe(false);
  expect(isReadOnlyPublicGrant([...slackMcpScopes, "groups:history"])).toBe(
    false
  );
  expect(isReadOnlyPublicGrant(["channels:read"])).toBe(false);
});

test("OAuth URL uses the supplied client and public read scopes", () => {
  const url = buildSlackAuthorizeUrl(
    "another-client",
    "TANOTHER",
    redirect,
    "test-state"
  );
  expect(url.pathname).toBe("/oauth/v2_user/authorize");
  expect(url.searchParams.get("client_id")).toBe("another-client");
  expect(url.searchParams.get("team")).toBe("TANOTHER");
  expect(url.searchParams.get("scope")).toBe(slackMcpScopes.join(","));
  expect(url.searchParams.get("redirect_uri")).toBe(redirect.href);
});

test("OAuth callback rejects altered state, duplicate codes and mismatched origins", () => {
  let settled = false;
  const handleRequest = createSlackOAuthCallback(redirect, "expected", () => {
    settled = true;
  });
  expect(
    handleRequest(new Request(`${redirect.href}?state=wrong&code=code`)).status
  ).toBe(400);
  expect(
    handleRequest(
      new Request(`${redirect.href}?state=expected&code=one&code=two`)
    ).status
  ).toBe(400);
  expect(
    handleRequest(
      new Request(
        "http://example.test/slack/oauth/callback?state=expected&code=code"
      )
    ).status
  ).toBe(404);
  expect(settled).toBe(false);
  const accepted = handleRequest(
    new Request(`${redirect.href}?state=expected&code=code`)
  );
  expect(accepted.status).toBe(200);
  expect(accepted.headers.get("cache-control")).toBe("no-store");
  expect(settled).toBe(true);
  expect(
    handleRequest(new Request(`${redirect.href}?state=expected&code=code`))
      .status
  ).toBe(409);
});
