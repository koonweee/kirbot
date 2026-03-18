import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { createTelegramHarness } from "@kirbot/telegram-harness";

async function main(): Promise<void> {
  const harness = await createTelegramHarness();
  await harness.start();

  const rl = createInterface({
    input,
    output
  });

  printHelp();

  try {
    while (true) {
      const line = (await rl.question("harness> ")).trim();
      if (!line) {
        continue;
      }

      if (line === "exit" || line === "quit") {
        break;
      }

      if (line === "help") {
        printHelp();
        continue;
      }

      if (line === "transcript") {
        output.write(`${JSON.stringify(harness.getTranscript(), null, 2)}\n`);
        continue;
      }

      if (line === "events") {
        output.write(`${JSON.stringify(harness.getTelegramEvents(), null, 2)}\n`);
        continue;
      }

      if (line === "logs") {
        output.write(`${JSON.stringify(harness.getLogs(), null, 2)}\n`);
        continue;
      }

      if (line === "wait") {
        await harness.waitForIdle();
        output.write("idle\n");
        continue;
      }

      if (line.startsWith("root ")) {
        await harness.sendRootText(line.slice("root ".length));
        await harness.waitForIdle();
        output.write(`${JSON.stringify(harness.getTranscript(), null, 2)}\n`);
        continue;
      }

      if (line.startsWith("topic ")) {
        const [topicIdText, ...rest] = line.slice("topic ".length).split(" ");
        const topicId = Number(topicIdText);
        if (!Number.isInteger(topicId) || rest.length === 0) {
          output.write("Usage: topic <topicId> <text>\n");
          continue;
        }

        await harness.sendTopicText(topicId, rest.join(" "));
        await harness.waitForIdle();
        output.write(`${JSON.stringify(harness.getTranscript(), null, 2)}\n`);
        continue;
      }

      if (line.startsWith("press ")) {
        const [messageIdText, ...rest] = line.slice("press ".length).split(" ");
        const messageId = Number(messageIdText);
        if (!Number.isInteger(messageId)) {
          output.write("Usage: press <messageId> <callbackData>\n");
          continue;
        }

        await harness.pressButton({
          messageId,
          ...(rest.length > 0 ? { callbackData: rest.join(" ") } : {})
        });
        await harness.waitForIdle();
        output.write(`${JSON.stringify(harness.getTranscript(), null, 2)}\n`);
        continue;
      }

      output.write("Unknown command. Type `help`.\n");
    }
  } finally {
    rl.close();
    await harness.stop();
  }
}

function printHelp(): void {
  output.write(
    [
      "Commands:",
      "  root <text>",
      "  topic <topicId> <text>",
      "  press <messageId> <callbackData>",
      "  wait",
      "  transcript",
      "  events",
      "  logs",
      "  help",
      "  quit"
    ].join("\n") + "\n"
  );
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
