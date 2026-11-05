import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"

export const Job = z.object({
  id: z.uuid(),
  kind: z.enum(["freeze", "new"]),
  sessionID: z.string().startsWith("ses"),
  sessionCreated: z.boolean(),
  goalID: z.string().nullable(),
  dueAt: z.number().int().positive().max(8_640_000_000_000_000),
  createdAt: z.number().int().positive(),
  text: z.string(),
  status: z.enum(["scheduled", "waiting", "delivering", "failed"]),
  error: z.string().nullable(),
})

export const SessionTime = Rpc.define({
  id: "oc-session-time",
  methods: {
    freeze: {
      input: z.object({
        sessionID: z.string().startsWith("ses"),
        dueAt: z.number().int().positive().max(8_640_000_000_000_000),
        text: z.string().optional(),
      }),
      output: Job,
    },
    schedule: {
      input: z.object({
        dueAt: z.number().int().positive().max(8_640_000_000_000_000),
        text: z.string().trim().min(1),
      }),
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
