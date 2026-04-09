import vine from '@vinejs/vine'

export const chatSchema = vine.compile(
  vine.object({
    model: vine.string().trim().minLength(1),
    messages: vine.array(
      vine.object({
        role: vine.enum(['system', 'user', 'assistant', 'tool'] as const),
        content: vine.string(),
      })
    ),
    stream: vine.boolean().optional(),
    sessionId: vine.number().positive().optional(),
    tools: vine
      .array(
        vine.object({
          type: vine.literal('function'),
          function: vine.object({
            name: vine.string().trim().minLength(1),
            description: vine.string().optional(),
            parameters: vine.any().optional(),
          }),
        })
      )
      .optional(),
  })
)

export const getAvailableModelsSchema = vine.compile(
  vine.object({
    sort: vine.enum(['pulls', 'name'] as const).optional(),
    recommendedOnly: vine.boolean().optional(),
    query: vine.string().trim().optional(),
    limit: vine.number().positive().optional(),
    force: vine.boolean().optional(),
  })
)
