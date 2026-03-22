import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createKirbotRuntime,
  createSourceLogger,
  loadConfig,
  type AppConfig,
  type AppLogEntry,
  type AppLogTarget,
  type BridgeCodexApi,
  type KirbotRuntime,
  type UserTurnInput,
  type UserTurnMessage
} from "@kirbot/core";
import {
  RecordingTelegram,
  type HarnessTelegramEvent,
  type HarnessTranscript
} from "./recording-telegram";

export type CreateTelegramHarnessOptions = {
  config?: AppConfig;
  stateDir?: string;
  codexApi?: BridgeCodexApi;
  workspaceMode?: "empty" | "inherit";
  workspaceDir?: string;
};

export type WaitForIdleOptions = {
  timeoutMs?: number;
  settleMs?: number;
};

export type PressButtonInput = {
  messageId: number;
  callbackData?: string;
  buttonText?: string;
};

export type HarnessImageInput = {
  caption?: string;
  bytes: Uint8Array;
  fileName?: string;
  mimeType?: string;
};

export type TelegramHarness = {
  start(): Promise<void>;
  stop(): Promise<void>;
  sendRootText(text: string): Promise<{ messageId: number; updateId: number }>;
  sendRootImage(input: HarnessImageInput): Promise<{ messageId: number; updateId: number }>;
  sendTopicText(topicId: number, text: string): Promise<{ messageId: number; updateId: number }>;
  sendTopicImage(topicId: number, input: HarnessImageInput): Promise<{ messageId: number; updateId: number }>;
  pressButton(input: PressButtonInput): Promise<void>;
  waitForIdle(options?: WaitForIdleOptions): Promise<void>;
  getTranscript(): HarnessTranscript;
  getTelegramEvents(): HarnessTelegramEvent[];
  getLogs(): AppLogEntry[];
};

const HARNESS_SIMULATED_SENDER_USER_ID = 42;

export async function createTelegramHarness(options: CreateTelegramHarnessOptions = {}): Promise<TelegramHarness> {
  const baseConfig = options.config ?? loadConfig();
  const stateDir = options.stateDir ?? mkdtempSync(join(tmpdir(), "kirbot-telegram-harness-"));
  const config = await buildHarnessConfig(baseConfig, stateDir, options);
  const logTarget = new BufferingLogTarget();
  const harnessLogger = createSourceLogger(logTarget, "harness");
  const telegram = new RecordingTelegram(config.telegram.workspaceChatId);

  let runtime: KirbotRuntime | null = null;
  let nextMessageId = 1;
  let nextUpdateId = 1;
  let nextCallbackQueryId = 1;
  let nextFileId = 1;

  const ensureStarted = async (): Promise<KirbotRuntime> => {
    if (runtime) {
      return runtime;
    }

    runtime = await createKirbotRuntime({
      config,
      telegramApi: telegram,
      logTarget,
      ...(options.codexApi ? { codexApi: options.codexApi } : {})
    });
    harnessLogger.info(
      `Started harness with state dir ${stateDir} (codex=stdio, cwd=${config.codex.defaultCwd})`
    );
    return runtime;
  };

  return {
    start: async () => {
      await ensureStarted();
    },
    stop: async () => {
      if (!runtime) {
        return;
      }

      await runtime.shutdown();
      runtime = null;
      harnessLogger.info("Stopped harness runtime");
    },
    sendRootText: async (text: string) => {
      const activeRuntime = await ensureStarted();
      const message = buildUserMessage(
        nextMessageId++,
        nextUpdateId++,
        config.telegram.workspaceChatId,
        HARNESS_SIMULATED_SENDER_USER_ID,
        text
      );
      telegram.recordUserTextMessage({
        chatId: message.chatId,
        topicId: null,
        messageId: message.messageId,
        text
      });
      harnessLogger.info(`Sending root message ${message.messageId}`);
      await activeRuntime.bridge.handleUserTextMessage(message);
      return {
        messageId: message.messageId,
        updateId: message.updateId
      };
    },
    sendRootImage: async (input: HarnessImageInput) => {
      const activeRuntime = await ensureStarted();
      const fileId = `harness-image-${nextFileId++}`;
      const message = buildUserImageMessage(
        nextMessageId++,
        nextUpdateId++,
        config.telegram.workspaceChatId,
        HARNESS_SIMULATED_SENDER_USER_ID,
        input.caption ?? "",
        fileId,
        input,
        null
      );
      telegram.recordUserImageMessage({
        chatId: message.chatId,
        topicId: null,
        messageId: message.messageId,
        text: message.text,
        fileId,
        bytes: input.bytes,
        ...(input.fileName ? { fileName: input.fileName } : {})
      });
      harnessLogger.info(`Sending root image message ${message.messageId}`);
      await activeRuntime.bridge.handleUserMessage(message);
      return {
        messageId: message.messageId,
        updateId: message.updateId
      };
    },
    sendTopicText: async (topicId: number, text: string) => {
      const activeRuntime = await ensureStarted();
      const message = buildUserMessage(
        nextMessageId++,
        nextUpdateId++,
        config.telegram.workspaceChatId,
        HARNESS_SIMULATED_SENDER_USER_ID,
        text,
        topicId
      );
      telegram.recordUserTextMessage({
        chatId: message.chatId,
        topicId,
        messageId: message.messageId,
        text
      });
      harnessLogger.info(`Sending topic ${topicId} message ${message.messageId}`);
      await activeRuntime.bridge.handleUserTextMessage(message);
      return {
        messageId: message.messageId,
        updateId: message.updateId
      };
    },
    sendTopicImage: async (topicId: number, input: HarnessImageInput) => {
      const activeRuntime = await ensureStarted();
      const fileId = `harness-image-${nextFileId++}`;
      const message = buildUserImageMessage(
        nextMessageId++,
        nextUpdateId++,
        config.telegram.workspaceChatId,
        HARNESS_SIMULATED_SENDER_USER_ID,
        input.caption ?? "",
        fileId,
        input,
        topicId
      );
      telegram.recordUserImageMessage({
        chatId: message.chatId,
        topicId,
        messageId: message.messageId,
        text: message.text,
        fileId,
        bytes: input.bytes,
        ...(input.fileName ? { fileName: input.fileName } : {})
      });
      harnessLogger.info(`Sending topic ${topicId} image message ${message.messageId}`);
      await activeRuntime.bridge.handleUserMessage(message);
      return {
        messageId: message.messageId,
        updateId: message.updateId
      };
    },
    pressButton: async (input: PressButtonInput) => {
      const activeRuntime = await ensureStarted();
      const callbackData = resolveCallbackData(telegram.getTranscript(), input);
      const location = telegram.findMessageLocation(input.messageId);
      if (!location) {
        throw new Error(`Could not find message ${input.messageId} in transcript`);
      }

      const callbackQueryId = `callback-${nextCallbackQueryId++}`;
      harnessLogger.info(`Pressing callback on message ${input.messageId}: ${callbackData}`);
      await activeRuntime.bridge.handleCallbackQuery({
        callbackQueryId,
        data: callbackData,
        chatId: location.chatId,
        topicId: location.topicId,
        userId: HARNESS_SIMULATED_SENDER_USER_ID
      });
    },
    waitForIdle: async (waitOptions: WaitForIdleOptions = {}) => {
      const activeRuntime = await ensureStarted();
      const timeoutMs = waitOptions.timeoutMs ?? 30000;
      const settleMs = waitOptions.settleMs ?? 100;
      const deadline = Date.now() + timeoutMs;

      while (Date.now() < deadline) {
        const snapshot = await activeRuntime.getActivitySnapshot();
        if (
          snapshot.activeTurnCount === 0 &&
          snapshot.pendingRequestCount === 0 &&
          Date.now() - telegram.lastActivityAt >= settleMs
        ) {
          return;
        }

        await sleep(50);
      }

      const snapshot = await activeRuntime.getActivitySnapshot();
      throw new Error(
        `Timed out waiting for idle. activeTurnCount=${snapshot.activeTurnCount} pendingRequestCount=${snapshot.pendingRequestCount}`
      );
    },
    getTranscript: () => telegram.getTranscript(),
    getTelegramEvents: () => telegram.getEvents(),
    getLogs: () => logTarget.getEntries()
  };
}

class BufferingLogTarget implements AppLogTarget {
  readonly #entries: AppLogEntry[] = [];

  write(entry: AppLogEntry): void {
    this.#entries.push(entry);
  }

  getEntries(): AppLogEntry[] {
    return structuredClone(this.#entries);
  }
}

async function buildHarnessConfig(
  baseConfig: AppConfig,
  stateDir: string,
  options: Pick<
    CreateTelegramHarnessOptions,
    "codexApi" | "workspaceMode" | "workspaceDir"
  >
): Promise<AppConfig> {
  const { workspaceDir, createWorkspaceDir } = resolveHarnessWorkspaceDir(baseConfig, stateDir, options);
  if (createWorkspaceDir) {
    mkdirSync(workspaceDir, { recursive: true });
  }

  return {
    ...baseConfig,
    telegram: {
      ...baseConfig.telegram,
      mediaTempDir: join(stateDir, "media")
    },
    database: {
      path: join(stateDir, "telegram-harness.sqlite")
    },
    codex: {
      ...baseConfig.codex,
      defaultCwd: workspaceDir
    }
  };
}

function resolveHarnessWorkspaceDir(
  baseConfig: AppConfig,
  stateDir: string,
  options: Pick<CreateTelegramHarnessOptions, "workspaceMode" | "workspaceDir">
): { workspaceDir: string; createWorkspaceDir: boolean } {
  if (options.workspaceDir) {
    return {
      workspaceDir: options.workspaceDir,
      createWorkspaceDir: true
    };
  }

  if (options.workspaceMode === "inherit") {
    return {
      workspaceDir: baseConfig.codex.defaultCwd,
      createWorkspaceDir: false
    };
  }

  return {
    workspaceDir: join(stateDir, "workspace"),
    createWorkspaceDir: true
  };
}

function buildUserMessage(
  messageId: number,
  updateId: number,
  chatId: number,
  userId: number,
  text: string,
  topicId: number | null = null
): Omit<UserTurnMessage, "input" | "submittedInputSignature"> {
  return {
    chatId,
    topicId,
    messageId,
    updateId,
    userId,
    text
  };
}

function buildUserImageMessage(
  messageId: number,
  updateId: number,
  chatId: number,
  userId: number,
  text: string,
  fileId: string,
  image: HarnessImageInput,
  topicId: number | null = null
): UserTurnMessage {
  return {
    ...buildUserMessage(messageId, updateId, chatId, userId, text, topicId),
    input: buildImageInput(text, fileId, image)
  };
}

function buildImageInput(text: string, fileId: string, image: HarnessImageInput): UserTurnInput[] {
  const input: UserTurnInput[] = [];
  if (text.trim().length > 0) {
    input.push({
      type: "text",
      text,
      text_elements: []
    });
  }
  input.push({
    type: "telegramImage",
    fileId,
    ...(image.fileName !== undefined ? { fileName: image.fileName } : {}),
    ...(image.mimeType !== undefined ? { mimeType: image.mimeType } : {})
  });
  return input;
}

function resolveCallbackData(transcript: HarnessTranscript, input: PressButtonInput): string {
  const message = [...transcript.root.messages, ...transcript.topics.flatMap((topic) => topic.messages)].find(
    (candidate) => candidate.messageId === input.messageId
  );
  if (!message?.inlineButtons || message.inlineButtons.length === 0) {
    throw new Error(`Message ${input.messageId} does not have any callback buttons`);
  }

  if (input.callbackData) {
    return input.callbackData;
  }

  if (input.buttonText) {
    for (const row of message.inlineButtons) {
      const button = row.find((candidate) => candidate.text === input.buttonText);
      if (button && "callback_data" in button) {
        return button.callback_data;
      }
    }

    throw new Error(`Message ${input.messageId} does not have a button labeled "${input.buttonText}"`);
  }

  const buttons = message.inlineButtons.flat();
  if (buttons.length === 1) {
    const [button] = buttons;
    if (button && "callback_data" in button) {
      return button.callback_data;
    }
  }

  throw new Error(`Message ${input.messageId} has multiple buttons; specify callbackData or buttonText`);
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
