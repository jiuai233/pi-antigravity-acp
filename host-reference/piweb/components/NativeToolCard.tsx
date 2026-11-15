"use client";

import type { ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { NativeToolActivity } from "@/lib/native-tool-activity";
import type { ToolCallContent, ToolResultMessage } from "@/lib/types";

type Props = {
  activity: NativeToolActivity;
  isStreaming?: boolean;
  renderToolCall: (block: ToolCallContent, result?: ToolResultMessage, duration?: number, statusText?: string) => ReactNode;
};

/** Paint a display record with the ordinary tool renderer; never add it to model messages. */
export function NativeToolCard({ activity, isStreaming, renderToolCall }: Props) {
  const { t } = useI18n();
  const failed = activity.status === "failed";
  const active = activity.status === "pending" || activity.status === "in_progress";
  const statusText = failed ? t("chat.nativeToolFailed") : active
    ? t(isStreaming ? "chat.nativeToolRunning" : "chat.nativeToolUnfinished") : undefined;
  // These are client-only view props, not transcript entries or executable calls.
  const block: ToolCallContent = {
    type: "toolCall", toolCallId: `native:${activity.id}`, toolName: activity.toolName,
    input: activity.input ?? {},
  };
  const result: ToolResultMessage | undefined = activity.output || failed ? {
    role: "toolResult", toolCallId: block.toolCallId, toolName: activity.toolName,
    content: [{ type: "text", text: activity.output || t("chat.nativeToolFailed") }],
    isError: failed, timestamp: activity.updatedAt,
  } : undefined;
  const duration = !active && activity.updatedAt > activity.startedAt
    ? activity.updatedAt - activity.startedAt : undefined;
  return (
    <div data-native-tool-id={activity.id} data-native-tool-status={activity.status}>
      {renderToolCall(block, result, duration, statusText)}
      {activity.outputTruncated && (
        <div style={{ marginTop: 4, color: "var(--text-dim)", fontSize: 11 }}>
          {t("chat.nativeToolOutputTruncated")}
        </div>
      )}
    </div>
  );
}
