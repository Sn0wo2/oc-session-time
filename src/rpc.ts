import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"

const SessionID = z.string().startsWith("ses")
const DueAt = z.number().int().positive().max(8_640_000_000_000_000)

export const Job = z.object({
  id: z.uuid(),
  kind: z.enum(["freeze", "new"]),
  sessionID: SessionID,
  sessionCreated: z.boolean(),
  goalID: z.string().nullable(),
  dueAt: DueAt,
  createdAt: z.number().int().positive(),
  text: z.string(),
  status: z.enum(["scheduled", "waiting", "delivering", "failed"]),
  error: z.string().nullable(),
})

export type Job = z.output<typeof Job>

export const SessionTime = Rpc.define({
  id: "oc-session-time",
  methods: {
    freeze: {
      input: z.object({ sessionID: SessionID, dueAt: DueAt, text: z.string().optional() }),
      output: Job,
    },
    schedule: {
      input: z.object({ dueAt: DueAt, text: z.string().trim().min(1) }),
      output: Job,
    },
    list: { input: z.object({}), output: z.array(Job) },
    run: {
      input: z.object({
        id: z.uuid(),
        model: z.object({ providerID: z.string().min(1), id: z.string().min(1), variant: z.string().optional() }),
        force: z.boolean().optional(),
      }),
      output: z.object({ started: z.boolean(), sessionID: z.string().optional() }),
    },
    cancel: { input: z.object({ id: z.uuid() }), output: z.boolean() },
  },
  events: {
    due: { schema: z.object({ id: z.uuid() }) },
  },
})
