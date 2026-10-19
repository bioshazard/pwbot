import { Effect, Option, Redacted, Schema } from "effect";

export const fallbackContextWindow = 32_768;
export const fallbackOutputTokens = 8192;
type LimitSource = "override" | "fallback" | "upstream";

const announcedValue = Schema.optional(Schema.Unknown);
const limits = {
  context_length: announcedValue,
  context_window: announcedValue,
  max_input_tokens: announcedValue,
  max_model_len: announcedValue,
  max_output_tokens: announcedValue,
};
const decodeCatalog = Schema.decodeUnknownSync(
  Schema.Struct({ data: Schema.Array(Schema.Unknown) })
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
const decodeLimit = Schema.decodeUnknownOption(
  Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
  )
);
const smallestValid = (values: readonly unknown[]) => {
  const valid = values.flatMap((value) => {
    const parsed = decodeLimit(value);
    return Option.isSome(parsed) ? [parsed.value] : [];
  });
  return valid.length > 0 ? Math.min(...valid) : undefined;
};
const smallestShared = (values: (number | undefined)[]) => {
  if (values.length === 0 || values.some((value) => value === undefined)) {
    return;
  }
  return Math.min(
    ...values.filter((value): value is number => value !== undefined)
  );
};
export interface ModelContextSettings {
  apiKey: Redacted.Redacted;
  baseUrl: string;
  contextWindow: number;
  contextWindowSource: LimitSource;
  maxTokens: number;
  maxTokensSource: LimitSource;
  model: string;
}
interface AnnouncedLimits {
  contextWindow?: number;
  maxTokens?: number;
}
const advertisedLimits = (
  data: readonly unknown[],
  model: string
): AnnouncedLimits => {
  const entries = data.filter((entry) => {
    const identity = decodeIdentity(entry);
    return (
      Option.isSome(identity) &&
      (identity.value.model_name === model || identity.value.id === model)
    );
  });
  const parsed = entries.map((entry) => decodeModel(entry));
  if (parsed.some(Option.isNone)) {
    return {};
  }
  const matches = parsed.flatMap((entry) =>
    Option.isSome(entry) ? [entry.value] : []
  );
  return {
    contextWindow: smallestShared(
      matches.map((entry) =>
        smallestValid([
          entry.context_window,
          entry.context_length,
          entry.max_model_len,
          entry.max_input_tokens,
          entry.model_info?.context_window,
          entry.model_info?.context_length,
          entry.model_info?.max_model_len,
          entry.model_info?.max_input_tokens,
        ])
      )
    ),
    maxTokens: smallestShared(
      matches.map((entry) =>
        smallestValid([
          entry.max_output_tokens,
          entry.model_info?.max_output_tokens,
        ])
      )
    ),
  };
};
interface ResolvedLimit {
  value: number;
  source: LimitSource;
}
const resolveLimit = (
  configured: number,
  source: LimitSource,
  announced: number | undefined,
  fallback: number
): ResolvedLimit => {
  if (source === "override") {
    return { source, value: configured };
  }
  if (announced !== undefined) {
    return { source: "upstream", value: announced };
  }
  return { source: "fallback", value: fallback };
};

// Resolve both limits independently once at startup; raw config never performs IO.
export const resolveModelContext = <A extends ModelContextSettings>(
  settings: A,
  timeoutMs = 3000
) =>
  Effect.gen(function* resolveLimits() {
    const announced: AnnouncedLimits = {};
    if (
      settings.contextWindowSource !== "override" ||
      settings.maxTokensSource !== "override"
    ) {
      yield* Effect.tryPromise(async (signal) => {
        const base = new URL(`${settings.baseUrl}/`);
        const proxy = new URL(base);
        proxy.pathname = proxy.pathname.replace(/\/v1\/$/u, "/");
        for (const endpoint of [
          new URL("model/info", proxy),
          new URL("models", base),
        ]) {
          // Each fallback depends on the preceding response; auth never follows redirects.
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
          const found = advertisedLimits(catalog.data, settings.model);
          announced.contextWindow ??= found.contextWindow;
          announced.maxTokens ??= found.maxTokens;
          if (
            (settings.contextWindowSource === "override" ||
              announced.contextWindow !== undefined) &&
            (settings.maxTokensSource === "override" ||
              announced.maxTokens !== undefined)
          ) {
            return;
          }
        }
      }).pipe(
        Effect.timeout(timeoutMs),
        // Preserve either limit already discovered if a later endpoint fails or stalls.
        // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Effect error recovery.
        Effect.catch(() => Effect.void)
      );
    }
    const context = resolveLimit(
      settings.contextWindow,
      settings.contextWindowSource,
      announced.contextWindow,
      fallbackContextWindow
    );
    const output = resolveLimit(
      settings.maxTokens,
      settings.maxTokensSource,
      announced.maxTokens,
      fallbackOutputTokens
    );
    const resolved: Omit<A, "contextWindowSource" | "maxTokensSource"> &
      Pick<ModelContextSettings, "contextWindowSource" | "maxTokensSource"> = {
      ...settings,
      contextWindow: context.value,
      contextWindowSource: context.source,
      maxTokens: output.value,
      maxTokensSource: output.source,
    };
    const summary = {
      contextWindow: context.value,
      contextWindowSource: context.source,
      maxTokens: output.value,
      maxTokensSource: output.source,
    };
    yield* context.source === "fallback" || output.source === "fallback"
      ? Effect.logWarning("Model limits resolved with fallback", summary)
      : Effect.logInfo("Model limits resolved", summary);
    return resolved;
  });
