import { Effect, Option, Redacted, Schema } from "effect";

export const fallbackContextWindow = 8192;

const announcedNumber = Schema.optional(Schema.NullOr(Schema.Number));
const limits = {
  context_length: announcedNumber,
  context_window: announcedNumber,
  max_input_tokens: announcedNumber,
  max_model_len: announcedNumber,
};
const decodeCatalog = Schema.decodeUnknownSync(
  Schema.Struct({
    data: Schema.Array(Schema.Unknown),
  })
);
const decodeIdentity = Schema.decodeUnknownOption(
  Schema.Struct({
    id: Schema.optional(Schema.String),
    model_name: Schema.optional(Schema.String),
  })
);
const decodeModel = Schema.decodeUnknownOption(
  Schema.Struct({
    ...limits,
    id: Schema.optional(Schema.String),
    model_info: Schema.optional(Schema.Struct(limits)),
    model_name: Schema.optional(Schema.String),
  })
);
export interface ModelContextSettings {
  apiKey: Redacted.Redacted;
  baseUrl: string;
  contextWindow: number;
  contextWindowSource: "override" | "fallback" | "upstream";
  model: string;
}
const advertisedContext = (data: readonly unknown[], model: string) => {
  const entries = data.filter((entry) => {
    const identity = decodeIdentity(entry);
    return (
      Option.isSome(identity) &&
      (identity.value.model_name === model || identity.value.id === model)
    );
  });
  if (entries.length === 0) {
    return;
  }
  const parsed = entries.map((entry) => decodeModel(entry));
  if (parsed.some(Option.isNone)) {
    return;
  }
  const matches = parsed.flatMap((entry) =>
    Option.isSome(entry) ? [entry.value] : []
  );
  const windows = matches.map((entry) => {
    const info = entry.model_info;
    const candidates = [
      entry.context_window,
      entry.context_length,
      entry.max_model_len,
      entry.max_input_tokens,
      info?.context_window,
      info?.context_length,
      info?.max_model_len,
      info?.max_input_tokens,
    ];
    const valid = candidates.filter(
      (value): value is number =>
        value !== undefined &&
        value !== null &&
        Number.isSafeInteger(value) &&
        value > 0
    );
    return valid.length > 0 ? Math.min(...valid) : undefined;
  });
  // An alias may route to several deployments; every matched deployment must fit.
  if (windows.some((value) => value === undefined)) {
    return;
  }
  return Math.min(
    ...windows.filter((value): value is number => value !== undefined)
  );
};

// Resolve once at service startup. Config parsing itself remains free of network IO.
export const resolveModelContext = <A extends ModelContextSettings>(
  settings: A,
  timeoutMs = 3000
) =>
  Effect.gen(function* resolveContext() {
    if (settings.contextWindowSource === "override") {
      yield* Effect.logInfo("Model context resolved", {
        contextWindow: settings.contextWindow,
        source: "override",
      });
      return settings;
    }
    const announced = yield* Effect.tryPromise(async (signal) => {
      const base = new URL(`${settings.baseUrl}/`);
      const proxy = new URL(base);
      proxy.pathname = proxy.pathname.replace(/\/v1\/$/u, "/");
      const endpoints = [new URL("model/info", proxy), new URL("models", base)];
      for (const endpoint of endpoints) {
        // Each fallback depends on the preceding response; never forward auth on redirects.
        // oxlint-disable-next-line eslint/no-await-in-loop
        const response = await fetch(endpoint, {
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${Redacted.value(settings.apiKey)}`,
          },
          redirect: "error",
          signal,
        });
        if (!response.ok) {
          continue;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop
        const catalog = decodeCatalog(await response.json());
        const window = advertisedContext(catalog.data, settings.model);
        if (window !== undefined) {
          return window;
        }
      }
      return null;
    }).pipe(
      Effect.timeout(timeoutMs),
      // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Effect error recovery.
      Effect.catch(() => Effect.succeed(null))
    );
    const contextWindow = announced ?? fallbackContextWindow;
    const contextWindowSource: ModelContextSettings["contextWindowSource"] =
      announced === null ? "fallback" : "upstream";
    const resolved: Omit<A, "contextWindowSource"> &
      Pick<ModelContextSettings, "contextWindowSource"> = {
      ...settings,
      contextWindow,
      contextWindowSource,
    };
    yield* announced === null
      ? Effect.logWarning(
          "Model context metadata unavailable; using fallback",
          { contextWindow }
        )
      : Effect.logInfo("Model context resolved", {
          contextWindow,
          source: contextWindowSource,
        });
    return resolved;
  });
