import vine from '@vinejs/vine'

export const mcpServerConfigSchema = vine.compile(
  vine.object({
    id: vine
      .string()
      .trim()
      .minLength(1)
      .maxLength(32)
      .regex(/^[a-z0-9_-]+$/),
    name: vine.string().trim().minLength(1).maxLength(100),
    transport: vine.enum(['stdio', 'sse']),
    url: vine.string().trim().optional(),
    headers: vine.record(vine.string()).optional(),
    command: vine.string().trim().optional(),
    args: vine.array(vine.string()).optional(),
    env: vine.record(vine.string()).optional(),
    enabled: vine.boolean(),
  })
)
