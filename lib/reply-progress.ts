import { Effect, Exit } from "effect";

interface ReactionTarget {
  channel: string;
  timestamp: string;
}
interface Reactions {
  add: (target: ReactionTarget & { name: string }) => Promise<{ ok?: boolean }>;
  remove: (
    target: ReactionTarget & { name: string }
  ) => Promise<{ ok?: boolean }>;
}

// Status is best effort: a missing Slack scope must never block the reply.
export const withReplyProgress = <E, R>(
  reactions: Reactions,
  target: ReactionTarget,
  work: Effect.Effect<boolean, E, R>
) => {
  const react = (operation: "add" | "remove", name: string) =>
    Effect.tryPromise(
      async () => await reactions[operation]({ ...target, name })
    ).pipe(
      Effect.timeout("3 seconds"),
      // oxlint-disable-next-line promise/prefer-await-to-then -- This handles Effect errors, not Promise rejection.
      Effect.catch(() =>
        Effect.logWarning("Reply status reaction failed", { name, operation })
      )
    );
  return Effect.gen(function* trackReplyProgress() {
    yield* react("add", "eyes");
    return yield* work;
  }).pipe(
    Effect.onExit((exit) =>
      Effect.gen(function* finishReplyProgress() {
        if (Exit.isSuccess(exit) && exit.value) {
          yield* react("add", "white_check_mark");
        }
        yield* react("remove", "eyes");
      })
    )
  );
};
