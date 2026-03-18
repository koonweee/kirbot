import { resolve } from "node:path";

import { generateCodexTypes } from "./codex-cli.mjs";

const outDir = resolve("packages/codex-client/src/generated/codex");
generateCodexTypes(outDir);
