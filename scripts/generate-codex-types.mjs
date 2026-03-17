import { resolve } from "node:path";

import { generateCodexTypes } from "./codex-cli.mjs";

const outDir = resolve("src/generated/codex");
generateCodexTypes(outDir);
