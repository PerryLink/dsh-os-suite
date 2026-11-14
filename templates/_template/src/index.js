import { defineTool } from '@deepseek-ai/dsh-tools'
import { childrenByParent } from './core.js'

export const name = 'dsh-os-NAME'
export const inject = ['tools']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'NAME_STATUS',
      description: 'DESCRIPTION',
      parameters: {
        id: { type: 'string', required: true, description: 'Item id' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args) {
        return { id: args.id, children: childrenByParent([{ id: args.id }]).get('') ?? [] }
      },
    }),
  )
}
