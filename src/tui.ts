import { Plugin } from "@opencode/plugin/tui"
import { createComponent, createEffect, onCleanup } from "solid-js"
import { type Job, SessionTime } from "./rpc.ts"
import { splitFirstToken } from "./utils/text.ts"
import { parseWhen } from "./utils/time.ts"

const WHITESPACE_RUN = /\s+/g
const USAGE = "Use /session-time [later <when> [message] | list | help]."
const WHEN_PLACEHOLDER = "3h, 1h30m, 0.5d, or 2026-11-06T18:00:00-05:00"
const TASK_PLACEHOLDER = "Prompt text, or a /registered-command with arguments"

type TaskAction = "resume" | "cancel" | "open"

const kindLabel = (job: Job) => (job.kind === "freeze" ? "resume" : "task")
const shortID = (job: Job) => job.id.slice(0, 8)
const dueLabel = (job: Job) => new Date(job.dueAt).toLocaleString()

const taskOption = (job: Job) => {
  const description = [
    job.sessionID,
    job.text.replace(WHITESPACE_RUN, " ").slice(0, 120),
    job.error ? `Error: ${job.error}` : "",
  ]
    .filter(Boolean)
    .join(" · ")
  return {
    title: `${kindLabel(job)} · ${job.status} · ${dueLabel(job)} · ${shortID(job)}`,
    value: job.id,
    ...(description ? { description } : {}),
  }
}

const SessionTimeHost = (props: { ctx: Plugin.Context }) => {
  const { ctx } = props
  const rpc = ctx.client.rpc(SessionTime)
  const controller = new AbortController()
  const requestOptions = { location: ctx.location ?? ctx.data.location.default(), signal: controller.signal }
  const automaticFailures = new Set<string>()
  let checking = false
  let running = false
  let rerunRequested = false
  let alive = true

  const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "info", sessionID?: string) => {
    if (!alive) return
    ctx.ui.toast.show({
      title: "Session time",
      message,
      variant,
      ...(sessionID === undefined ? {} : { sessionID }),
    })
  }

  const toastError = (message: string, sessionID?: string) => toast(message, "error", sessionID)

  const routeSessionID = () => {
    const route = ctx.ui.router.current()
    return route.type === "session" ? route.sessionID : undefined
  }

  const notifyStarted = (job: Job, sessionID: string | undefined, manual: boolean) => {
    if (!alive) return
    if (job.kind === "new" && sessionID) ctx.ui.tabs.open(sessionID)
    toast(
      manual ? "Task resumed." : job.kind === "new" ? "Scheduled session started." : "Scheduled session resumed.",
      "success",
      sessionID ?? job.sessionID,
    )
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
      toastError(`Scheduled task ${shortID(job)} failed: ${message}`, job.sessionID)
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

  const runCommand = async (command: () => Promise<void>) => {
    if (!alive) return
    try {
      await command()
    } catch (error) {
      toastError(error instanceof Error ? error.message : String(error), routeSessionID())
    }
  }

  const askWhen = async (title: string) => {
    const value = await ctx.ui.dialog.prompt({ title, placeholder: WHEN_PLACEHOLDER })
    if (!alive || value === undefined) return undefined
    return parseWhen(value)
  }

  const scheduleLater = async (input: string | undefined) => {
    const [when, text] = splitFirstToken(input)
    const sessionID = routeSessionID()
    const dueAt = when
      ? parseWhen(when)
      : await askWhen(sessionID ? "Freeze this session until when?" : "Run the task when?")
    if (dueAt === undefined) return
    if (sessionID) {
      const job = await rpc.freeze({ sessionID, dueAt, ...(text.trim() ? { text } : {}) }, requestOptions)
      toast(`Session frozen until ${dueLabel(job)}; it resumes automatically.`, "success", sessionID)
      return
    }
    let task = text.trim()
    if (!task) {
      const answer = await ctx.ui.dialog.prompt({ title: "Task to run", placeholder: TASK_PLACEHOLDER })
      if (!alive || answer === undefined) return
      task = answer.trim()
      if (!task) return
    }
    const job = await rpc.schedule({ dueAt, text: task }, requestOptions)
    toast(`Task ${shortID(job)} scheduled for ${dueLabel(job)}.`, "success", job.sessionID)
  }

  const resumeTask = async (job: Job) => {
    const outcome = await runTask(job, true)
    if (!alive || outcome.kind === "disposed") return
    if (outcome.kind === "no-model") {
      toastError("Select a model in the TUI before resuming a task.", job.sessionID)
      return
    }
    if (outcome.kind === "in-flight") {
      toast("This task is already being started.", "info", job.sessionID)
      return
    }
    if (!outcome.result.started) {
      toast("Task was not started; another client may already be delivering it.", "info", job.sessionID)
      return
    }
    automaticFailures.delete(job.id)
    notifyStarted(job, outcome.result.sessionID, true)
  }

  const cancelTask = async (job: Job) => {
    const confirmed = await ctx.ui.dialog.confirm({
      title: job.kind === "freeze" ? `Cancel automatic resume ${shortID(job)}?` : `Cancel task ${shortID(job)}?`,
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
      toast("Task was not cancelled; it may already be running or complete.", "info", job.sessionID)
      return
    }
    toast(
      job.kind === "freeze" ? "Automatic resume cancelled; the session remains stopped." : "Scheduled task cancelled.",
      "success",
      job.sessionID,
    )
  }

  const openTask = async (job: Job) => {
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

  const taskAction = async (job: Job, action: TaskAction) => {
    if (action === "resume") await resumeTask(job)
    else if (action === "cancel") await cancelTask(job)
    else await openTask(job)
  }

  const manageTasks = async () => {
    const jobs = await rpc.list({}, requestOptions)
    if (!alive) return
    if (jobs.length === 0) {
      await ctx.ui.dialog.alert({ title: "Session time", message: "There are no scheduled tasks." })
      return
    }
    const act = (action: TaskAction) => (id: string) => {
      ctx.ui.dialog.clear()
      const job = jobs.find((candidate) => candidate.id === id)
      if (job) void runCommand(() => taskAction(job, action))
    }
    const selected = await ctx.ui.dialog.select<string>({
      title: "Session time tasks",
      placeholder: "Select a task, or use a footer action",
      options: jobs.map(taskOption),
      actions: [
        { bind: "r", title: "Resume", onTrigger: act("resume") },
        { bind: "c", title: "Cancel", onTrigger: act("cancel") },
        { bind: "o", title: "Open", onTrigger: act("open") },
      ],
    })
    if (!alive || selected === undefined) return
    const job = jobs.find((candidate) => candidate.id === selected)
    if (!job) return
    const action = await ctx.ui.dialog.select<TaskAction>({
      title: `Task ${shortID(job)} · ${job.status}`,
      options: [
        ...(job.status === "delivering" ? [] : [{ title: "Resume now", value: "resume" as const }]),
        {
          title: job.kind === "freeze" ? "Cancel automatic resume (session stays stopped)" : "Cancel task",
          value: "cancel" as const,
        },
        { title: "Open session if it exists", value: "open" as const },
      ],
    })
    if (!alive || action === undefined) return
    await taskAction(job, action)
  }

  const showHelp = async () => {
    await ctx.ui.dialog.alert({
      title: "Session time",
      message: [
        "/session-time — open the menu: later, manage, or help.",
        "/session-time later <when> [message] — in a session, freeze it now and resume it automatically with the message; on the home screen, run a prompt or /registered-command in a new session.",
        "/session-time list — pick a task to resume now, cancel, or open its session.",
        "<when> uses durations (3h, 1h30m, 0.5h) or ISO timestamps with a timezone (2026-11-06T18:00:00-05:00); past or ambiguous times are rejected.",
        "Cancelling an automatic resume lifts the freeze gate but leaves that session stopped.",
        "Tasks run only while the service and a TUI with a selected model are up; they are not OS wake timers.",
      ].join("\n\n"),
    })
  }

  const openHub = async () => {
    const inSession = routeSessionID() !== undefined
    const choice = await ctx.ui.dialog.select<"later" | "list" | "help">({
      title: "Session time",
      placeholder: "Choose an action",
      options: [
        {
          title: "Later",
          value: "later",
          description: inSession
            ? "Freeze this session now and resume it automatically"
            : "Run a prompt or /command in a new session",
        },
        {
          title: "Manage tasks",
          value: "list",
          description: "Resume, cancel, or open scheduled tasks",
        },
        {
          title: "Help",
          value: "help",
          description: "Usage and time formats",
        },
      ],
    })
    if (!alive || choice === undefined) return
    await dispatch(choice)
  }

  const dispatch = (input: string | undefined): Promise<void> => {
    const [verb, rest] = splitFirstToken(input)
    switch (verb.toLowerCase()) {
      case "later":
        return scheduleLater(rest)
      case "list":
        return manageTasks()
      case "help":
        return showHelp()
      case "":
        return openHub()
      default:
        throw new Error(USAGE)
    }
  }

  ctx.keymap.layer(() => {
    return {
      mode: "global",
      commands: [
        {
          id: "oc-session-time",
          title: "Session time",
          description: "Schedule the current session or new tasks for later, and manage timers",
          group: "Session time",
          bind: false,
          palette: true,
          slash: { name: "session-time", arguments: true },
          run: (input) => runCommand(() => dispatch(input)),
        },
      ],
    }
  })

  return null
}

export default Plugin.define({
  id: "oc-session-time",
  setup(ctx) {
    return ctx.ui.slot({ append: "app", render: () => createComponent(SessionTimeHost, { ctx }) })
  },
})
