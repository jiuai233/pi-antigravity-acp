import { constants } from "node:fs";
import { copyFile, mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

/** Snapshot native persistence, without editing the source or decoding its rows. */
export async function copyNativeConversation(
  sourceDirectory: string, targetDirectory: string, conversationId: string,
): Promise<string> {
  await mkdir(targetDirectory, { recursive: true });
  const protobuf = path.join(targetDirectory, `${conversationId}.pb`);
  try {
    await copyFile(path.join(sourceDirectory, `${conversationId}.pb`), protobuf, constants.COPYFILE_EXCL);
    return protobuf;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // session/new uses SQLite; imported histories use encrypted protobuf. Online
  // backup includes committed WAL pages even when the parent session is open.
  const source = path.join(sourceDirectory, `${conversationId}.db`);
  const target = path.join(targetDirectory, `${conversationId}.db`);
  const database = new DatabaseSync(source, { readOnly: true });
  let reserved = false;
  try {
    const file = await open(target, "wx");
    await file.close();
    reserved = true;
    await backup(database, target);
    return target;
  } catch (error) {
    if (reserved) await rm(target, { force: true });
    throw error;
  } finally {
    database.close();
  }
}

/** Only call for an exclusive bootstrap copy after its native process closes. */
export async function removeNativeBootstrap(file: string): Promise<void> {
  await rm(file, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 });
  if (file.endsWith(".db")) {
    await Promise.all(["-wal", "-shm", "-journal"].map(suffix => rm(file + suffix, { force: true })));
  }
}
