/** Read-only terminal interpretation of GetCascadeTrajectory (not ACP stopReason). */
export const isNativeErrorStep = (step: any): boolean =>
  step?.type === "CORTEX_STEP_TYPE_ERROR_MESSAGE" || step?.type === 17 || step?.errorMessage !== undefined;
export const isNativeDoneStep = (step: any): boolean =>
  step?.status === "CORTEX_STEP_STATUS_DONE" || step?.status === 3;

/** Only steps appended by this prompt can fail it. A later completed response
 * proves an in-prompt error was healed; tool completions alone do not. Missing
 * telemetry cannot establish either failure or a new accepted native cursor. */
export function nativePromptError(trajectory: any, startStep: number | undefined): Error | undefined {
  if (startStep === undefined || !Array.isArray(trajectory?.steps)) return undefined;
  const steps: any[] = trajectory.steps;
  const errorIndex = steps.findLastIndex((step, index) => index > startStep && isNativeErrorStep(step));
  if (errorIndex < 0) return undefined;
  if (steps.slice(errorIndex + 1).some(step => isNativeDoneStep(step) && !isNativeErrorStep(step)
    && typeof step.plannerResponse?.response === "string" && step.plannerResponse.response.trim())) return undefined;
  const raw = steps[errorIndex].errorMessage?.error;
  const message = [raw?.shortError, raw?.details].filter(value => typeof value === "string" && value.length).join("\n")
    || raw?.userErrorMessage || "AGY native prompt ended with an ERROR_MESSAGE step.";
  return Object.assign(new Error(message), { nativeError: raw, stepIndex: errorIndex });
}
