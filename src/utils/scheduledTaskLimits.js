// Shared caps for scheduled tasks, wherever they are created from: the
// `/ai schedule` command, the model's own `schedule_task` tool, and anything
// added later. In the style of `utils/reminderLimits.js`, and in one place for
// the same reason — a cap enforced on one route and not the other is not a cap.
//
// A scheduled task is not a reminder, though, and the numbers say so: every run
// of one is a provider call the guild pays for, made when nobody is watching.
// So the ceilings are an order of magnitude tighter than the reminder ones, and
// there is a floor on how often a task may repeat that reminders have no need
// for.
module.exports = {
    // Per guild, counting only tasks that are switched on. The guild's monthly
    // AI ceiling (#831) is what bounds the spend; this bounds how much of the
    // minute tick's work one server can be.
    MAX_TASKS_PER_GUILD: 20,

    // Per person, so one member cannot fill the guild's allowance on their own.
    // Tasks the model creates count against the person it was talking to.
    MAX_TASKS_PER_USER: 5,

    MAX_TASK_PROMPT_LENGTH: 500,

    // How far ahead a task may be scheduled. A year, matching reminders — past
    // that the guild has almost certainly changed shape around it.
    MAX_TASK_DELAY_MINUTES: 525_600,

    // And the nearest a task may fire, which is one tick of the scheduler.
    MIN_TASK_DELAY_MINUTES: 1,

    // Consecutive failures before the service switches a task off. Three days
    // of a daily task failing the same way is not a hiccup, and each attempt
    // costs tokens; the task is kept, disabled, with its last error on it.
    MAX_TASK_FAILURES: 3,

    // How long one task's handler may run before the tick gives up on it.
    //
    // The tick runs its due tasks one after another, so anything that never
    // returns does not just lose its own run — it holds the tick open, and
    // jobRunner drops every later tick as an overlap. The whole scheduled-task
    // system would then be stalled by one hung HTTP request.
    //
    // And such a request is reachable: of the four providers only Ollama sets a
    // request timeout of its own, so a `getCompletion` on a provider whose
    // socket goes quiet is bounded by that provider's SDK default, if it has
    // one. Ten minutes is longer than any legitimate `ai_prompt` run — the MCP
    // turn budget is a fraction of it — and short enough that the scheduler
    // recovers on its own. The abandoned request is not cancelled; the point is
    // that the tick stops waiting for it.
    TASK_RUN_TIMEOUT_MS: 10 * 60 * 1000,

    // How many due tasks one tick will run. The tick is a minute and each
    // `ai_prompt` run is a provider call, so a backlog after long downtime is
    // drained over several ticks rather than fanned out all at once.
    MAX_TASKS_PER_TICK: 10
};
