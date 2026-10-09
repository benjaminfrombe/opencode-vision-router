import { resolveImagePath, resolveMediaPath } from "./image";
import type { FilePartLike, MediaPartLike, Msg } from "./types";

const IMAGE_PREFIX = "[The user attached an image, saved at:";
const IMAGE_SUFFIX = "]";

/** Build the text pointer that replaces an image file part. */
export function imagePointer(path: string, agentName: string): string {
  return (
    `${IMAGE_PREFIX} ${path}${IMAGE_SUFFIX}\n` +
    `Use the "${agentName}" subagent (via the Task tool) to analyze this image ` +
    `and answer the user's request about it. Pass the path and the request to the subagent.`
  );
}

 export function isImagePart(part: any): part is FilePartLike {
   return part?.type === "file" && typeof part.mime === "string" && part.mime.startsWith("image/");
 }

/**
 * Pure transform: replace image file parts on **user** messages with a text pointer
 * containing the resolved image path. Other messages (and assistant messages) are
 * returned unchanged. Returns a new message array; the input is not mutated.
 */
export function transformMessages(
  messages: Msg[],
  agentName: string,
  tmpDir?: string,
): Msg[] {
  return messages.map((msg) => {
    const parts: any[] = msg?.parts || [];
    const hasImage = parts.some(isImagePart);
    if (!hasImage) return msg;
    if (msg.info?.role && msg.info.role !== "user") return msg;

    let replaced = false;
    const newParts = parts.map((part) => {
      if (isImagePart(part)) {
        const path = resolveImagePath(part, tmpDir);
        if (path) {
          replaced = true;
          return { type: "text", text: imagePointer(path, agentName) };
        }
      }
      return part;
    });

    return replaced ? { ...msg, parts: newParts } : msg;
  });
}

/** OpenCode V2 message: `role` plus a `content` array of parts. */
export interface V2Msg {
  role?: string;
  content?: unknown;
}

/** V2 media part carrying image bytes. */
export function isMediaImagePart(part: any): part is MediaPartLike {
  if (part?.type !== "media") return false;
  // OpenCode >= 2.0.x nests the media type under media.source
  const mediaType =
    part.mediaType ??
    part.media?.source?.mediaType ??
    part.media?.mediaType;
  return typeof mediaType === "string" && mediaType.startsWith("image/");
}

/**
 * An image file part embedded in a tool-result value. The read tool returns
 * images as data-URI file parts; these persist in history and are replayed to
 * the model on every later step, so they must be stripped for text-only models
 * too, not just images on user messages.
 */
export function isFileUriImagePart(part: any): boolean {
  if (part?.type !== "file") return false;
  const uri = part?.uri;
  if (typeof uri !== "string") return false;
  if (uri.startsWith("data:image/")) return true;
  return uri.startsWith("file://") || uri.startsWith("/");
}

/**
 * V2 variant of `transformMessages`: OpenCode V2 messages use `role` + a
 * `content` array. Images arrive as `media` parts on user messages, and also
 * as data-URI file parts inside tool-result values (e.g. the read tool).
 * Replace both with the text pointer so a text-only model never sees image
 * bytes, regardless of where in the history they live. Returns a new message
 * array; the input is not mutated.
 */
export function transformV2Messages(
  messages: V2Msg[],
  agentName: string,
  tmpDir?: string,
): V2Msg[] {
  return messages.map((msg) => {
    const role = msg?.role;

    // Tool messages: strip image parts embedded in tool-result values.
    if (role === "tool") {
      const parts = msg?.content;
      if (!Array.isArray(parts)) return msg;
      let replaced = false;
      const newParts = (parts as any[]).map((part) => {
        const next = stripToolResultImages(part, agentName, tmpDir);
        if (next !== part) replaced = true;
        return next;
      });
      return replaced ? { ...msg, content: newParts } : msg;
    }

    // User messages: replace image media/file parts with the pointer.
    if (role && role !== "user") return msg;
    const parts = msg?.content;
    if (!Array.isArray(parts)) return msg;
    const hasImage =
      (parts as any[]).some(isMediaImagePart) ||
      (parts as any[]).some(isImagePart);
    if (!hasImage) return msg;

    let replaced = false;
    const newParts = (parts as any[]).map((part) => {
      if (isMediaImagePart(part)) {
        const path = resolveMediaPath(part, tmpDir);
        if (path) {
          replaced = true;
          return { type: "text", text: imagePointer(path, agentName) };
        }
      }
      if (isImagePart(part)) {
        const path = resolveMediaPath(part as any, tmpDir);
        if (path) {
          replaced = true;
          return { type: "text", text: imagePointer(path, agentName) };
        }
      }
      return part;
    });

    return replaced ? { ...msg, content: newParts } : msg;
  });
}

/**
 * Replace image file parts inside a tool-result `content` value with the text
 * pointer. Returns the part unchanged when there is nothing to strip.
 */
function stripToolResultImages(
  part: any,
  agentName: string,
  tmpDir?: string,
): any {
  if (part?.type !== "tool-result") return part;
  const result = part?.result;
  if (!result || result.type !== "content" || !Array.isArray(result.value)) {
    return part;
  }
  let replaced = false;
  const newValue = (result.value as any[]).map((item) => {
    if (isFileUriImagePart(item)) {
      const path = resolveMediaPath(
        { ...item, media: { source: { type: "url", url: item.uri } } } as any,
        tmpDir,
      );
      if (path) {
        replaced = true;
        return { type: "text", text: imagePointer(path, agentName) };
      }
    }
    if (isMediaImagePart(item)) {
      const path = resolveMediaPath(item, tmpDir);
      if (path) {
        replaced = true;
        return { type: "text", text: imagePointer(path, agentName) };
      }
    }
    return item;
  });
  return replaced ? { ...part, result: { ...result, value: newValue } } : part;
}
