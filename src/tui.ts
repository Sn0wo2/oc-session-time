import { Plugin } from "@opencode/plugin/tui"
import { createComponent, createEffect, onCleanup } from "solid-js"
import { type Job, SessionTime } from "./rpc.ts"
import { splitFirstToken } from "./utils/text.ts"
import { parseWhen } from "./utils/time.ts"

const WHITESPACE_RUN = /\s+/g

const CommandsHost = (props: { ctx: Plugin.Context }) => {
  const { ctx } = props
  const rpc = ctx.client.rpc(SessionTime)
  const controller = new AbortController()
  const requestOptions = { location: ctx.location ?? ctx.data.location.default(), signal: controller.signal }
  const automaticFailures = new Set<string>()
  let checking = false
  let running = false
  let rerunRequested = false
  let alive = true

  const toastError = (message: string, sessionID?: string) => {
    if (!alive) return
    ctx.ui.toast.show({
      title: "Session time",
      message,
      variant: "error",
      ...(sessionID === undefined ? {} : { sessionID }),
    })
  }

  const routeSessionID = () => {
    const route = ctx.ui.router.current()
    return route.type === "session" ? route.sessionID : undefined
  }

  const notifyStarted = (job: Job, sessionID: string | undefined, manual: boolean) => {
    if (!alive) return
    const target = sessionID ?? job.sessionID
    if (job.kind === "new" && sessionID) ctx.ui.tabs.open(sessionID)
    ctx.ui.toast.show({
      title: "Session time",
      message: manual
        ? "Task resumed."
        : job.kind === "new"
          ? "Scheduled session started."
          : "Scheduled session resumed.",
      variant: "success",
      sessionID: target,
    })
  }

  const runTask = async (job: Job, manual: boolean) => {
    if (!alive) return { kind: "disposed" as const }
    if (running) {
      rerunRequested = true
      return { kind: "in-flight" as const }
    }
    running = true

    try {
      const current = ctx.ui.model.current()
      if (!current) return { kind: "no-model" as const }

      const result = await rpc.run(
        {
          id: job.id,
          model: {
            providerID: current.providerID,
            id: current.modelID,
            ...(current.variant === undefined ? {} : { variant: current.variant }),
          },
          ...(manual ? { force: true } : {}),
        },
        requestOptions,
      )
      return alive ? { kind: "result" as const, result } : { kind: "disposed" as const }
    } finally {
      running = false
      if (alive && rerunRequested && !checking) {
        rerunRequested = false
        queueMicrotask(() => void checkDue())
      }
    }
  }

  const runAutomatically = async (job: Job) => {
    if (!alive) return
    try {
      const outcome = await runTask(job, false)
      if (!alive || outcome.kind !== "result" || !outcome.result.started) return
      automaticFailures.delete(job.id)
      notifyStarted(job, outcome.result.sessionID, false)
    } catch (error) {
      if (!alive || automaticFailures.has(job.id)) return
      automaticFailures.add(job.id)
      const message = error instanceof Error ? error.message : String(error)
      toastError(`Scheduled task ${job.id.slice(0, 8)} failed: ${message}`, job.sessionID)
    }
  }

  const checkDue = async () => {
    if (!alive) return
    if (checking || running) {
      rerunRequested = true
      return
    }

    checking = true
    let listed = false
    try {
      const jobs = await rpc.list({}, requestOptions).catch(() => undefined)
      if (!(alive && jobs)) return
      listed = true
      const now = Date.now()
      for (const job of jobs) {
        if (!alive) break
        if ((job.status === "scheduled" || job.status === "waiting") && job.dueAt <= now) {
          await runAutomatically(job)
        }
      }
    } finally {
      checking = false
      if (rerunRequested) {
        rerunRequested = false
        if (alive && listed) queueMicrotask(() => void checkDue())
      }
    }
  }

  const onDue = rpc.events.on(
    "due",
    (event) => {
      if (!alive || event.location.directory !== requestOptions.location.directory) return
      void checkDue()
    },
    { signal: controller.signal },
  )
  const timer = setInterval(() => void checkDue(), 15_000)
  onCleanup(() => {
    alive = false
    controller.abort()
    clearInterval(timer)
    onDue()
  })

  createEffect(() => {
    ctx.ui.model.current()
    void checkDue()
  })

  const manageTask = async (job: Job, selectedAction?: "resume" | "cancel" | "open") => {
    const action =
      selectedAction ??
      (await ctx.ui.dialog.select<"resume" | "cancel" | "open">({
        title: `Task ${job.id.slice(0, 8)} · ${job.status}`,
        options: [
          ...(job.status === "delivering" ? [] : [{ title: "Resume now", value: "resume" as const }]),
          {
            title: job.kind === "freeze" ? "Cancel automatic resume (session stays stopped)" : "Cancel task",
            value: "cancel",
          },
          { title: "Open session if it exists", value: "open" },
        ],
      }))
    if (!alive || action === undefined) return

    if (action === "resume") {
      const outcome = await runTask(job, true)
      if (!alive || outcome.kind === "disposed") return
      if (outcome.kind === "no-model") {
        toastError("Select a model in the TUI before resuming a task.", job.sessionID)
        return
      }
      if (outcome.kind === "in-flight") {
        ctx.ui.toast.show({ message: "This task is already being started.", variant: "info", sessionID: job.sessionID })
        return
      }
      if (!outcome.result.started) {
        ctx.ui.toast.show({
          message: "Task was not started; another client may already be delivering it.",
          variant: "info",
          sessionID: job.sessionID,
        })
        return
      }
      automaticFailures.delete(job.id)
      notifyStarted(job, outcome.result.sessionID, true)
    } else if (action === "cancel") {
      const confirmed = await ctx.ui.dialog.confirm({
        title: `Cancel ${job.kind} task ${job.id.slice(0, 8)}?`,
        message:
          job.kind === "freeze"
            ? "This cancels the automatic resume and lifts the freeze gate, but leaves the session stopped. It will not resume the session."
            : "This permanently cancels the scheduled task.",
        label: { confirm: "Cancel task" },
      })
      if (!(alive && confirmed)) return

      const cancelled = await rpc.cancel({ id: job.id }, requestOptions)
      if (!alive) return
      if (!cancelled) {
        ctx.ui.toast.show({
          message: "Task was not cancelled; it may already be running or complete.",
          variant: "info",
        })
        return
      }
      ctx.ui.toast.show({
        message:
          job.kind === "freeze"
            ? "Automatic resume cancelled; the session remains stopped."
            : "Scheduled task cancelled.",
        variant: "success",
        sessionID: job.sessionID,
      })
    } else {
      await ctx.data.session.sync(job.sessionID)
      if (!alive) return
      if (!ctx.data.session.get(job.sessionID)) {
        await ctx.ui.dialog.alert({
          title: "Session unavailable",
          message: `Session ${job.sessionID} no longer exists.`,
        })
        return
      }
      ctx.ui.router.navigate({ type: "session", sessionID: job.sessionID })
    }
  }

  const runCommand = async (command: () => Promise<void>) => {
    if (!alive) return
    try {
      await command()
    } catch (error) {
      toastError(error instanceof Error ? error.message : String(error), routeSessionID())
    }
  }

  ctx.keymap.layer(() => {
    return {
      mode: "global",
      commands: [
        {
          id: "oc-session-time.freeze",
          title: "Freeze session",
          description: "Stop the current session and resume it later",
          group: "Session time",
          bind: false,
          palette: true,
          slash: { name: "freeze", arguments: true },
          run: (input) =>
            runCommand(async () => {
              const sessionID = routeSessionID()
              if (!sessionID) {
                ctx.ui.toast.show({ message: "Open a session before using /freeze.", variant: "warning" })
                return
              }
              const [when, text] = splitFirstToken(input)
              if (!when) throw new Error("Usage: /freeze <duration|ISO timestamp> [continuation text].")
              const dueAt = parseWhen(when)
              const job = await rpc.freeze({ sessionID, dueAt, ...(text.trim() ? { text } : {}) }, requestOptions)
              if (!alive) return
              ctx.ui.toast.show({
                message: `Session frozen until ${new Date(job.dueAt).toLocaleString()}.`,
                variant: "success",
                sessionID,
              })
            }),
        },
        {
          id: "oc-session-time.later",
          title: "Schedule a task",
          description: "Schedule a prompt or registered command for later",
          group: "Session time",
          bind: false,
          palette: true,
          slash: { name: "later", arguments: true },
          run: (input) =>
            runCommand(async () => {
              const [when, text] = splitFirstToken(input)
              if (!(when && text.trim()))
                throw new Error("Usage: /later <duration|ISO timestamp> <prompt or /registered-command arguments>.")
              const dueAt = parseWhen(when)
              const job = await rpc.schedule({ dueAt, text }, requestOptions)
              if (!alive) return
              ctx.ui.toast.show({
                message: `Task ${job.id.slice(0, 8)} scheduled for ${new Date(job.dueAt).toLocaleString()}.`,
                variant: "success",
                sessionID: job.sessionID,
              })
            }),
        },
        {
          id: "oc-session-time.manage",
          title: "Manage session time tasks",
          description: "List, resume, cancel, or open scheduled tasks",
          group: "Session time",
          bind: false,
          palette: true,
          slash: { name: "session-time", arguments: true },
          run: (input) =>
            runCommand(async () => {
              const parts = (input ?? "").trim().split(WHITESPACE_RUN).filter(Boolean)
              const action = parts[0]?.toLowerCase() ?? "list"
              const prefix = parts[1]
              if (
                parts.length > 2 ||
                (action !== "list" && action !== "resume" && action !== "cancel" && action !== "help") ||
                (action === "help" && prefix !== undefined)
              ) {
                throw new Error("Use /session-time [list|resume [id/prefix]|cancel [id/prefix]|help].")
              }
              if (action === "help") {
                await ctx.ui.dialog.alert({
                  title: "Session time",
                  message: [
                    "/freeze <duration|ISO timestamp> [continuation text] — stop the current session and resume it later.",
                    "/later <duration|ISO timestamp> <prompt or /registered-command arguments> — create a scheduled task without making a model call now.",
                    "Durations use s/m/h/d/w and can be compound or fractional: 3h, 1h30m, 0.5h. ISO timestamps must include a timezone, for example 2026-11-06T18:00:00-05:00; past or ambiguous times are rejected.",
                    "Example: /later 3h /goal review the release plan. Slash commands are supported only when registered with the server.",
                    "/session-time [list|resume [id/prefix]|cancel [id/prefix]|help] manages persisted tasks. With no arguments, choose a task to resume now, cancel, or open its existing session.",
                    "Cancelling a freeze task cancels its automatic resume and lifts the freeze gate, but leaves that session stopped; it does not resume the session.",
                    "Without a TUI and current model, due tasks stay waiting. Jobs are not OS wake timers: if the service process is off, overdue tasks can run only after the service and a suitable TUI return.",
                  ].join("\n\n"),
                })
                return
              }
              if (action === "list" && prefix) throw new Error("Use /session-time list without a task ID.")

              if (action === "list" || prefix === undefined) {
                const jobs = await rpc.list({}, requestOptions)
                if (!alive) return
                if (jobs.length === 0) {
                  await ctx.ui.dialog.alert({ title: "Session time", message: "There are no scheduled tasks." })
                  return
                }
                const selected = await ctx.ui.dialog.select<string>({
                  title: "Session time tasks",
                  placeholder: "Select a task",
                  options: jobs.map((job) => {
                    const description = [
                      job.sessionID,
                      job.text.replace(WHITESPACE_RUN, " ").slice(0, 120),
                      job.error ? `Error: ${job.error}` : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")
                    return {
                      title: `${job.kind} · ${job.status} · ${new Date(job.dueAt).toLocaleString()} · ${job.id.slice(0, 8)}`,
                      value: job.id,
                      ...(description ? { description } : {}),
                    }
                  }),
                })
                if (!alive || selected === undefined) return
                const job = jobs.find((candidate) => candidate.id === selected)
                if (job) await manageTask(job, action === "resume" || action === "cancel" ? action : undefined)
                return
              }

              const jobs = await rpc.list({}, requestOptions)
              if (!alive) return
              const matches = jobs.filter((job) => job.id.startsWith(prefix))
              if (matches.length === 0) {
                toastError(`No task matches “${prefix}”.`)
                return
              }
              if (matches.length > 1) {
                toastError(`Task prefix “${prefix}” is ambiguous; use a longer ID prefix.`)
                return
              }
              const job = matches[0]
              if (job) await manageTask(job, action)
            }),
        },
      ],
    }
  })

  return null
}

export default Plugin.define({
  id: "oc-session-time",
  setup(ctx) {
    return ctx.ui.slot({ append: "app", render: () => createComponent(CommandsHost, { ctx }) })
  },
})
