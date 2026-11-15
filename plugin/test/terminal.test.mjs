import assert from 'node:assert/strict';
import test from 'node:test';
import {nativePromptError} from '../src/terminal.ts';

const error = {type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE', status: 'CORTEX_STEP_STATUS_DONE',
  errorMessage: {error: {shortError: 'INVALID_ARGUMENT (code 400)', details: 'ORIGINAL_DETAILS', errorCode: 400}}};
const reply = {type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE',
  plannerResponse: {response: 'Recovered response'}};

test('terminal errors preserve shortError/details, not a retryable wrapper', () => {
  const failure = nativePromptError({steps: [error]}, -1);
  assert.equal(failure.message, 'INVALID_ARGUMENT (code 400)\nORIGINAL_DETAILS');
  assert.deepEqual(failure.nativeError, error.errorMessage.error);
  assert.equal(failure.stepIndex, 0);
  assert.ok(nativePromptError({steps: [{...error, type: 17, status: 3}]}, -1));
});
test('only current prompt errors not followed by a completed planner response fail', () => {
  assert.equal(nativePromptError({steps: [error, reply]}, 0), undefined);
  assert.equal(nativePromptError({steps: [error, reply]}, -1), undefined);
  assert.ok(nativePromptError({steps: [error, {...reply, status: 'CORTEX_STEP_STATUS_RUNNING'}]}, -1));
  assert.ok(nativePromptError({steps: [error, {status: 3, mcpTool: {resultString: 'tool finished'}}]}, -1));
  assert.ok(nativePromptError({steps: [error, reply, error]}, -1));
});
test('absent boundary or telemetry cannot justify rejecting success', () => {
  assert.equal(nativePromptError({steps: [error]}, undefined), undefined);
  assert.equal(nativePromptError(undefined, -1), undefined);
});
