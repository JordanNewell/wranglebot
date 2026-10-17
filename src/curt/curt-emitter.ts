import fs from "node:fs";
import path from "node:path";
import { curtFilename, serializeCurt, type CurtConversation } from "curt-format";
import type { CurtRecord } from "../types.js";
import { recordToMessage } from "./mapper.js";

export interface CurtEmitterOptions {
  /** Session this emitter buffers for; records must match. */
  sessionId: string;
  /** Conversation title; defaults to `wranglebot <sessionId>`. */
  title?: string;
  provider?: string;
  model?: string;
  /** Generator string written into the .curt envelope. */
  generator?: string;
}

const DEFAULT_GENERATOR = "wranglebot 0.1.0";

/**
 * Buffers CurtRecords for one supervised session and serializes them to a
 * .curt file (the WrangleBot consumer side of the .curt standard).
 */
export class CurtEmitter {
  private readonly sessionId: string;
  private readonly title: string;
  private readonly provider?: string;
  private readonly model?: string;
  private readonly generator: string;
  private records: CurtRecord[] = [];

  constructor(options: CurtEmitterOptions) {
    this.sessionId = options.sessionId;
    this.title = options.title ?? `wranglebot ${options.sessionId}`;
    this.provider = options.provider;
    this.model = options.model;
    this.generator = options.generator ?? DEFAULT_GENERATOR;
  }

  /** Buffer one supervised tool call. Throws on a foreign sessionId. */
  add(record: CurtRecord): void {
    if (record.sessionId !== this.sessionId) {
      throw new Error(
        `curt-emitter: record sessionId "${record.sessionId}" does not match emitter session "${this.sessionId}"`,
      );
    }
    this.records.push(record);
  }

  /** Buffered record count (useful for daemons deciding when to flush). */
  get size(): number {
    return this.records.length;
  }

  /**
   * Serialize and write the conversation. If `writePath` is an existing
   * directory (or ends in a path separator), the file is named with
   * curtFilename() inside it; otherwise `writePath` is used verbatim.
   * Returns the file written.
   */
  flush(writePath: string): string {
    const conversation = this.conversation();
    const body = serializeCurt(conversation, this.generator);

    const isDir =
      writePath.endsWith("/") ||
      writePath.endsWith("\\") ||
      (fs.existsSync(writePath) && fs.statSync(writePath).isDirectory());
    const file = isDir ? path.join(writePath, curtFilename(conversation)) : writePath;

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body, "utf8");
    return file;
  }

  private conversation(): CurtConversation {
    const timestamps = this.records.map((r) => r.ts);
    const createdAt = timestamps.length ? Math.min(...timestamps) : Date.now();
    const updatedAt = timestamps.length ? Math.max(...timestamps) : createdAt;
    const conversation: CurtConversation = {
      id: this.sessionId,
      title: this.title,
      createdAt,
      updatedAt,
      messages: this.records.map(recordToMessage),
    };
    if (this.provider !== undefined) conversation.provider = this.provider;
    if (this.model !== undefined) conversation.model = this.model;
    return conversation;
  }
}
