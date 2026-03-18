import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { extname, join } from "node:path";

export type PreparedImageFiles = {
  readonly paths: readonly string[];
  attachToTurn(turnId: string): void;
  discard(): Promise<void>;
};

export class TemporaryImageStore {
  readonly #turnPaths = new Map<string, Set<string>>();

  constructor(private readonly rootDir: string) {}

  async initialize(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
  }

  async cleanupStaleFiles(): Promise<void> {
    await this.initialize();
    const entries = await readdir(this.rootDir, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        await rm(join(this.rootDir, entry.name), { force: true, recursive: true });
      })
    );
    this.#turnPaths.clear();
  }

  async writeImage(bytes: Uint8Array, filenameHint?: string | null): Promise<string> {
    await this.initialize();
    const extension = normalizeImageExtension(filenameHint);
    const path = join(this.rootDir, `${randomUUID()}${extension}`);
    await writeFile(path, bytes);
    return path;
  }

  async deleteFile(path: string): Promise<void> {
    await rm(path, { force: true });
  }

  prepareImageFiles(paths: string[]): PreparedImageFiles {
    return new PendingTurnImages(this, paths);
  }

  retainTurnFiles(turnId: string, paths: readonly string[]): void {
    if (paths.length === 0) {
      return;
    }

    const existing = this.#turnPaths.get(turnId) ?? new Set<string>();
    for (const path of paths) {
      existing.add(path);
    }
    this.#turnPaths.set(turnId, existing);
  }

  async releaseTurnFiles(turnId: string): Promise<void> {
    const paths = this.#turnPaths.get(turnId);
    if (!paths) {
      return;
    }

    this.#turnPaths.delete(turnId);
    await this.deleteFiles([...paths]);
  }

  async deleteFiles(paths: readonly string[]): Promise<void> {
    await Promise.all(paths.map((path) => this.deleteFile(path)));
  }
}

class PendingTurnImages implements PreparedImageFiles {
  #attached = false;
  readonly paths: readonly string[];

  constructor(
    private readonly store: TemporaryImageStore,
    paths: readonly string[]
  ) {
    this.paths = [...paths];
  }

  attachToTurn(turnId: string): void {
    if (this.#attached) {
      return;
    }

    // Local images are only retained for the active turn for now. If we need
    // "look at the earlier image again" behavior later, extend this with a
    // per-thread TTL or another durable cleanup policy.
    this.store.retainTurnFiles(turnId, this.paths);
    this.#attached = true;
  }

  async discard(): Promise<void> {
    if (this.#attached || this.paths.length === 0) {
      return;
    }

    await this.store.deleteFiles(this.paths);
  }
}

function normalizeImageExtension(filenameHint?: string | null): string {
  if (!filenameHint) {
    return ".img";
  }

  const extension = extname(filenameHint).trim().toLowerCase();
  if (!extension) {
    return ".img";
  }

  return extension.replace(/[^a-z0-9.]/g, "") || ".img";
}
