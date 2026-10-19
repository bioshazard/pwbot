import { Effect } from "effect";

export type ReplyDebug = (
  event: string,
  fields?: Readonly<Record<string, string | number | boolean | undefined>>
) => void;

// Keep request bodies, tool arguments/results, credentials and raw errors out.
export const makeReplyDebug = (
  enabled: boolean,
  requestId: string
): ReplyDebug => {
  const started = performance.now();
  return (event, fields = {}) => {
    if (enabled) {
      Effect.runSync(
        Effect.logInfo("Reply debug", {
          ...fields,
          elapsedMs: Math.round(performance.now() - started),
          event,
          requestId,
        })
      );
    }
  };
};
