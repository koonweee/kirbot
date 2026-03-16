import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { extname, join } from "node:path";

export class TemporaryImageStore {
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
