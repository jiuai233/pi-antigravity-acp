/** Keep native content visible when Pi has no equivalent block type. */
export function visibleContent(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? String(value);
}

/** Normalize compatible base64 spellings without silently deleting invalid payload bytes. */
export function nativeBase64(value: string): string {
  const data = value.replace(/^data:[^,]*;base64,/i, "").replace(/\s/g, "").replace(/-/g, "+").replace(/_/g, "/");
  return data.padEnd(Math.ceil(data.length / 4) * 4, "=");
}

export function acpContent(content: unknown): any[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return content == null ? [] : [{ type: "text", text: visibleContent(content) }];
  return content.map(part => {
    if (part.type === "image" || part.type === "audio") return { ...part, data: nativeBase64(part.data) };
    if (["text", "resource", "resource_link"].includes(part.type)) return structuredClone(part);
    return { type: "text", text: visibleContent(part) };
  });
}
