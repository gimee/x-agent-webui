export type RequestTarget = string | null | undefined

export function isCurrentRequest(
  requestGeneration: number,
  currentGeneration: number,
): boolean {
  return requestGeneration === currentGeneration
}

export function createRequestGeneration() {
  let generation = 0
  return {
    next(): number {
      generation += 1
      return generation
    },
    current(): number {
      return generation
    },
    isCurrent(requestGeneration: number): boolean {
      return requestGeneration === generation
    },
    isTargetCurrent(
      requestGeneration: number,
      expectedTargets: readonly RequestTarget[],
      actualTargets: readonly RequestTarget[],
    ): boolean {
      return requestGeneration === generation
        && expectedTargets.length === actualTargets.length
        && expectedTargets.every((target, index) => target === actualTargets[index])
    },
  }
}
