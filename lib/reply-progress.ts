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

export type ReplyStage = "researching" | "composing";

// Status is best effort: a missing Slack scope must never block the reply.
export const withReplyProgress = <E, R>(
  reactions: Reactions,
  target: ReactionTarget,
  work:
    | Effect.Effect<boolean, E, R>
    | ((
        progress: (stage: ReplyStage) => Promise<void>
      ) => Effect.Effect<boolean, E, R>)
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
  let active: string | undefined;
  const attempted = new Set<string>();
  let closed = false;
  let pending = Promise.resolve();
  const progress = async (stage: ReplyStage) => {
    const name = stage === "researching" ? "mag" : "writing_hand";
    if (closed || active === name) {
      return;
    }
    const previous = active;
    active = name;
    attempted.add(name);
    pending = Effect.runPromise(
      Effect.gen(function* changeStage() {
        if (previous !== undefined) {
          yield* react("remove", previous);
        }
        yield* react("add", name);
      })
    );
    await pending;
  };
  return Effect.gen(function* trackReplyProgress() {
    yield* react("add", "eyes");
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Both branches are trusted typed work, not external data.
    return yield* typeof work === "function" ? work(progress) : work;
  }).pipe(
    Effect.onExit((exit) =>
      Effect.gen(function* finishReplyProgress() {
        closed = true;
        yield* Effect.promise(async () => {
          await pending;
        });
        if (Exit.isSuccess(exit) && exit.value) {
          yield* react("add", "white_check_mark");
        }
        for (const name of attempted) {
          yield* react("remove", name);
        }
        yield* react("remove", "eyes");
      })
    )
  );
};
