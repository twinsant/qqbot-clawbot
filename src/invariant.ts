/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-qqbot-clawbot`.
 * @module @deepseek-ai/dsh-qqbot-clawbot/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-qqbot-clawbot'

/** Cordis companion plugin name. */
export const name = 'qqbot-clawbot-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the driver creates no session event type of its own;
 * inbound follow-ups are ordinary `user/message` facts owned by dsh-session,
 * and gateway lifetime is an effect observed by unloading the plugin fiber.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns The installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
