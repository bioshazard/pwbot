import { expect, test } from "bun:test";

import { modelFailureDiagnostics } from "../../lib/model-diagnostics";

test("model failure diagnostics preserve only fixed labels and numeric status", () => {
  expect(
    modelFailureDiagnostics(
      "400: context_length_exceeded private request content"
    )
  ).toEqual({ httpStatus: 400, kind: "context_limit" });
  expect(
    modelFailureDiagnostics("504 Request timed out; private data")
  ).toEqual({ httpStatus: 504, kind: "upstream_timeout" });
  expect(
    modelFailureDiagnostics("Stream ended without finish_reason: private data")
  ).toEqual({ httpStatus: undefined, kind: "incomplete_stream" });
  expect(
    modelFailureDiagnostics("private upstream payload and credentials")
  ).toEqual({ httpStatus: undefined, kind: "upstream_error" });
});
