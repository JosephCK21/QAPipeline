/**
 * Normalize a raw step from API/DB (string legacy or { action, expectedResult }) for RTM UI.
 * @returns {{ action: string, expectedResult: string }}
 */
export function normalizeStepForDisplay(step) {
  if (typeof step === 'string') {
    return { action: step.trim(), expectedResult: '' };
  }
  if (step && typeof step === 'object') {
    const action = String(step.action != null ? step.action : '')
      || String(step.description != null ? step.description : '')
      || String(step.text != null ? step.text : '');
    const expectedResult = String(
      step.expectedResult != null ? step.expectedResult
        : step.expected != null ? step.expected
          : ''
    );
    return { action: action.trim(), expectedResult: expectedResult.trim() };
  }
  return { action: '', expectedResult: '' };
}
