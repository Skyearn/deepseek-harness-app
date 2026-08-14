/**
 * The git invariant companion registers its package ownership with the
 * invariant registry and disposes cleanly with its fiber.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as GitInvariant from '@deepseek-ai/dsh-git/invariant'

describe('git seam invariant companion', () => {
  it('registers package ownership and disposes with the fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const register = vi.spyOn(ctx.invariants, 'register')
    const fiber = await ctx.plugin(GitInvariant)
    expect(register).toHaveBeenCalledWith('@deepseek-ai/dsh-git', expect.any(Function))
    register.mockRestore()
    await fiber.dispose()
  })
})
