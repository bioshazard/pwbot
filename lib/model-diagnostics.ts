// Upstream error strings may contain prompts, credentials or tool results.
// Emit only fixed categories and a leading HTTP status; never the original text.
export const modelFailureDiagnostics = (message: string) => {
  const status = /^(?<status>[45]\d{2})(?:\s|:)/u.exec(message)?.groups?.status;
  let kind = "upstream_error";
  if (/context[_ ]length|maximum context|too many tokens/iu.test(message)) {
    kind = "context_limit";
  } else if (/timed? ?out|timeout/iu.test(message)) {
    kind = "upstream_timeout";
  } else if (/Stream ended without finish_reason/u.test(message)) {
    kind = "incomplete_stream";
  }
  return {
    httpStatus: status === undefined ? undefined : Number(status),
    kind,
  };
};
