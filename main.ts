import { BunRuntime } from "@effect/platform-bun";
import { Layer } from "effect";

import { AppLive } from "./lib/layers";
import { SlackLive } from "./slack";

BunRuntime.runMain(Layer.launch(SlackLive.pipe(Layer.provide(AppLive))));
