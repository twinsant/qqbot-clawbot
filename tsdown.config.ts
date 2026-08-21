import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  '@deepseek-ai/dsh-qqbot-clawbot',
  ['lib/types/index.js', 'lib/types/invariant.js'],
)
