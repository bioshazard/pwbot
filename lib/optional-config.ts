import { Config, Option, Redacted } from "effect";

// Empty optional Secret values should behave like omitted environment variables.
export const optionalText = (name: string) =>
  Config.String(name).pipe(
    Config.option,
    Config.map(Option.map((value) => value.trim())),
    Config.map(Option.filter((value) => value.length > 0))
  );

export const optionalSecret = (name: string) =>
  optionalText(name).pipe(Config.map(Option.map(Redacted.make)));
