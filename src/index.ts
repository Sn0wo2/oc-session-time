import { Plugin } from "@opencode/plugin"
import { Goal } from "@opencode/schema/goal"
import { Job, SessionTime } from "./rpc.ts"
import { splitFirstToken } from "./utils/text.ts"

export default Plugin.define({
  id: "oc-session-time",
  async setup(ctx) {
    const prefix = `jobs/${encodeURIComponent(ctx.location.directory)}/`
    const jobs = new Map<string, Job>()
    const frozen = new Map<string, Job>()
    const parents = new Map<string, string | undefined>()
    const controller = new AbortController()
    const goals = ctx.rpc(Goal.Definition)
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let queue = Promise.resolve()

    function exclusive<T>(run: () => Promise<T> | T) {
      const result = queue.then(() => {
        if (stopped) throw new Error("Session timer is stopping; reconnect and try again.")
        return run()
      })
      queue = result.then(
        () => {},
        () => {},
      )
      return result
    }

    async function save(job: Job) {
      await ctx.storage.set(prefix + job.id, job)
      jobs.set(job.id, job)
      if (job.kind === "freeze") frozen.set(job.sessionID, job)
    }

    async function remove(job: Job) {
      await ctx.storage.remove(prefix + job.id)
      jobs.delete(job.id)
      if (frozen.get(job.sessionID)?.id === job.id) frozen.delete(job.sessionID)
    }

    async function findFreeze(sessionID: string, ignore?: string) {
      let current: string | undefined = sessionID
      while (current && frozen.size) {
        const job = frozen.get(current)
        if (job && job.id !== ignore) return job
        if (!parents.has(current)) parents.set(current, (await ctx.session.get({ sessionID: current })).parentID)
        current = parents.get(current)
      }
      return undefined
    }

    async function gate(sessionID: string) {
      const job = await findFreeze(sessionID)
      if (job)
        throw new Error(
          `Session frozen until ${new Date(job.dueAt).toISOString()} (timer ${job.id}). Use /session-time to resume or cancel.`,
        )
    }

    async function interruptTree(sessionID: string) {
      const sessions = [sessionID]
      for (const id of sessions) {
        await ctx.session.interrupt({ sessionID: id, resume: false })
        let cursor: string | undefined
        do {
          const page = await ctx.session.list({ parentID: id, limit: 100, ...(cursor ? { cursor } : {}) })
          sessions.push(...page.data.map((session) => session.id))
          cursor = page.cursor.next ?? undefined
        } while (cursor)
      }
    }

    async function validateCommand(text: string) {
      if (!text.startsWith("/")) return
      const [name] = splitFirstToken(text.slice(1))
      const commands = await ctx.command.list({ location: { directory: ctx.location.directory } })
      if (!commands.data.some((command) => command.name === name))
        throw new Error(`/${name} is not a registered server command. Schedule plain task text instead.`)
    }

    let after: string | undefined
    do {
      const page = await ctx.storage.scan({ prefix, limit: 100, ...(after ? { after } : {}) })
      for (const entry of page.entries) {
        const job = Job.parse(entry.value)
        if (entry.key !== prefix + job.id) throw new Error(`Invalid session timer storage key: ${entry.key}`)
        if (job.status === "delivering") {
          await save({
            ...job,
            status: "failed",
            error: "The service stopped during delivery. Check the session, then resume explicitly if needed.",
          })
        } else {
          jobs.set(job.id, job)
          if (job.kind === "freeze") frozen.set(job.sessionID, job)
        }
      }
      after = page.next
    } while (after)

    const hooks = await Promise.all([
      ctx.session.hook("prompt", (event) => gate(event.sessionID)),
      ctx.session.hook("model.request", (event) => gate(event.sessionID)),
      ctx.session.hook("retry", async (event) => {
        if (await findFreeze(event.sessionID)) event.decision = { retry: false }
      }),
    ])

    function arm(backoff = 0) {
      clearTimeout(timer)
      if (stopped) return
      let dueAt = Number.POSITIVE_INFINITY
      for (const job of jobs.values()) if (job.status === "scheduled") dueAt = Math.min(dueAt, job.dueAt)
      if (!Number.isFinite(dueAt)) return
      timer = setTimeout(
        () => {
          void exclusive(async () => {
            for (const job of jobs.values()) {
              if (job.status !== "scheduled" || job.dueAt > Date.now()) continue
              await save({ ...job, status: "waiting" })
              await rpc.events.emit("due", { id: job.id })
            }
          }).then(
            () => arm(),
            (error: unknown) => {
              if (!stopped) console.error("oc-session-time:", error)
              arm(30_000)
            },
          )
        },
        Math.min(2_147_483_647, Math.max(backoff, dueAt - Date.now())),
      )
    }

    const rpc = await ctx.rpc.register(SessionTime, {
      freeze: (input) =>
        exclusive(async () => {
          if (input.dueAt <= Date.now()) throw new Error("Choose a future freeze deadline.")
          await ctx.session.get({ sessionID: input.sessionID })
          const previous = frozen.get(input.sessionID)
          const goal = await goals.get({ sessionID: input.sessionID })
          const job: Job = {
            id: previous?.id ?? crypto.randomUUID(),
            kind: "freeze",
            sessionID: input.sessionID,
            sessionCreated: true,
            goalID: goal?.status === "active" ? goal.id : (previous?.goalID ?? null),
            dueAt: input.dueAt,
            createdAt: previous?.createdAt ?? Date.now(),
            text: input.text?.trim() || "The scheduled freeze has ended. Continue the unfinished task in this session.",
            status: "scheduled",
            error: null,
          }
          await save(job)
          arm()
          try {
            await interruptTree(job.sessionID)
          } catch (error) {
            await save({ ...job, status: "failed", error: error instanceof Error ? error.message : String(error) })
            arm()
            throw error
          }
          return job
        }),
      schedule: (input) =>
        exclusive(async () => {
          if (input.dueAt <= Date.now()) throw new Error("Choose a future start time.")
          await validateCommand(input.text)
          const id = crypto.randomUUID()
          const job: Job = {
            id,
            kind: "new",
            sessionID: `ses_${id}`,
            sessionCreated: false,
            goalID: null,
            dueAt: input.dueAt,
            createdAt: Date.now(),
            text: input.text,
            status: "scheduled",
            error: null,
          }
          await save(job)
          arm()
          return job
        }),
      list: () => exclusive(() => Array.from(jobs.values()).sort((left, right) => left.dueAt - right.dueAt)),
      run: (input) =>
        exclusive(async () => {
          let job = jobs.get(input.id)
          if (!job || (!input.force && (job.dueAt > Date.now() || job.status === "failed"))) return { started: false }
          const inherited = job.kind === "freeze" ? await findFreeze(job.sessionID, job.id) : undefined
          if (inherited) throw new Error(`The parent session is still frozen (timer ${inherited.id}).`)
          job = { ...job, status: "delivering", error: null }
          await save(job)
          const model = {
            providerID: input.model.providerID,
            id: input.model.id,
            ...(input.model.variant !== undefined ? { variant: input.model.variant } : {}),
          }
          try {
            if (job.kind === "new") {
              await validateCommand(job.text)
              if (!job.sessionCreated) {
                await ctx.session.create({
                  id: job.sessionID,
                  model,
                  title: job.text.slice(0, 100),
                  location: { directory: ctx.location.directory },
                })
                job = { ...job, sessionCreated: true }
                await save(job)
              }
            }
            await interruptTree(job.sessionID)
            await ctx.session.switchModel({ sessionID: job.sessionID, model })
            if (frozen.get(job.sessionID)?.id === job.id) frozen.delete(job.sessionID)
            if (job.kind === "freeze") {
              const goal = job.goalID ? await goals.get({ sessionID: job.sessionID }) : null
              const resumeGoal = goal?.id === job.goalID && goal?.status === "paused"
              await ctx.session.synthetic({
                sessionID: job.sessionID,
                id: `msg_${job.id}`,
                text: job.text,
                description: "Scheduled session resume",
                delivery: "queue",
                resume: !resumeGoal,
              })
              if (resumeGoal)
                await ctx.session.command({ sessionID: job.sessionID, name: "goal", text: "resume", delivery: "queue" })
            } else if (job.text.startsWith("/")) {
              const [name, text] = splitFirstToken(job.text.slice(1))
              await ctx.session.command({ sessionID: job.sessionID, name, text, delivery: "queue" })
            } else {
              await ctx.session.prompt({
                sessionID: job.sessionID,
                id: `msg_${job.id}`,
                text: job.text,
                delivery: "queue",
                resume: true,
              })
            }
            await remove(job)
            arm()
            return { started: true, sessionID: job.sessionID }
          } catch (error) {
            await save({ ...job, status: "failed", error: error instanceof Error ? error.message : String(error) })
            if (job.kind === "freeze") {
              await interruptTree(job.sessionID).catch((interruption: unknown) => {
                console.error("oc-session-time:", interruption)
              })
            }
            arm()
            throw error
          }
        }),
      cancel: (input) =>
        exclusive(async () => {
          const job = jobs.get(input.id)
          if (!job) return false
          await remove(job)
          arm()
          return true
        }),
    })

    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        try {
          if (event.type === "session.deleted") {
            parents.clear()
            await exclusive(async () => {
              for (const job of jobs.values()) if (job.sessionID === event.data.sessionID) await remove(job)
              arm()
            })
          } else if (event.type === "session.execution.started") {
            await exclusive(async () => {
              const job = await findFreeze(event.data.sessionID)
              if (job) await ctx.session.interrupt({ sessionID: event.data.sessionID, resume: false })
            })
          }
        } catch (error) {
          if (!stopped) console.error("oc-session-time:", error)
        }
      }
    })().catch((error: unknown) => {
      if (!controller.signal.aborted) console.error("oc-session-time:", error)
    })

    for (const job of frozen.values()) {
      try {
        await interruptTree(job.sessionID)
      } catch (error) {
        await save({ ...job, status: "failed", error: error instanceof Error ? error.message : String(error) })
      }
    }
    arm()

    return async () => {
      stopped = true
      clearTimeout(timer)
      controller.abort()
      await queue
      await Promise.all([rpc.dispose(), ...hooks.map((hook) => hook.dispose())])
    }
  },
})
