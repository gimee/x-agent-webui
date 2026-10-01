import { describe, expect, it } from 'vitest'
import {
  createRequestGeneration,
  isCurrentRequest,
} from '@/utils/request-generation'

describe('session safety request guards', () => {
  it('invalidates an older request when a newer request starts', () => {
    const generation = createRequestGeneration()
    const first = generation.next()
    const second = generation.next()

    expect(isCurrentRequest(first, generation.current())).toBe(false)
    expect(isCurrentRequest(second, generation.current())).toBe(true)
  })

  it('rejects a response when the request target changed', () => {
    const generation = createRequestGeneration()
    const request = generation.next()

    expect(generation.isTargetCurrent(request, ['session-a', 'profile-a', 'file-a'], ['session-a', 'profile-a', 'file-a'])).toBe(true)
    expect(generation.isTargetCurrent(request, ['session-a', 'profile-a', 'file-a'], ['session-b', 'profile-a', 'file-a'])).toBe(false)
    expect(generation.isTargetCurrent(request, ['session-a', 'profile-a', 'file-a'], ['session-a', 'profile-b', 'file-a'])).toBe(false)
    expect(generation.isTargetCurrent(request, ['session-a', 'profile-a', 'file-a'], ['session-a', 'profile-a', 'file-b'])).toBe(false)
  })
})
