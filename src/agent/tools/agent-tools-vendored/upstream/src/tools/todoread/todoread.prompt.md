Read the agent's session todo list.

This tool returns the in-process todo list scoped to the current session.
The list is the same one mutated by `todowrite`; if `todowrite` has not yet
been called for this session the list is empty.

When to use this tool:
- At the start of a multi-step task, to recover the plan from a previous
  turn instead of re-deriving it.
- After completing a subtask, to confirm what remains and pick the next
  item.
- When reorienting after a long tool chain or after a user clarification,
  to make sure the plan still matches the current intent.

Inputs: none. The schema is an empty object — call this tool with `{}`.

Output format: a human-readable list, one todo per line, of the form

  [x] 1. Done item              (priority: high)
  [~] 2. In-progress item       (priority: medium)
  [ ] 3. Pending item

`[x]` marks a completed item, `[~]` marks an in-progress item, `[ ]` marks
a pending item. The numeric prefix is the todo's stable id. The
`(priority: ...)` suffix is omitted when the todo carries no priority.

When the list is empty (no `todowrite` yet, or the session was cleared),
the tool returns the literal string `(no todos)` and the structured
`data.todos` payload is an empty array.
