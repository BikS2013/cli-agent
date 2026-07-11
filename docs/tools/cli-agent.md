<cliAgent>
    <objective>
        Generic LangGraph ReAct agent that wraps one or more external CLI tools (passed at
        launch via repeatable --tool=&lt;name&gt; flags or via a `tools` array in
        ~/.tool-agents/cli-agent/config.json). Each declared tool is auto-added to the
        bash_run allowlist. At first launch the agent recursively introspects each tool's
        --help (depth-limited, byte-budgeted, time-budgeted) and stores the resulting
        Markdown capability document under ~/.tool-agents/cli-agent/capabilities/&lt;tool&gt;.md;
        the compiled capabilities document is embedded in the system prompt so the LLM
        knows the exact subcommand surface of every wrapped CLI. Ships with the
        standardized cross-cutting toolkit (bash_*, tool_help), the agent-tools
        pack (agt_*, incl. first-party agt_file_read/list/write/edit/append and
        agt_web_search/agt_web_fetch), and the eight standard LLM providers; default
        provider seeded into config.json is azure-openai.
    </objective>
    <command>
        cli-agent [prompt]
          [-i | --interactive]
          [-r | --resume [&lt;threadId&gt;]]    # TUI only; omit threadId to use cursor.json
          [--tool &lt;name&gt;]                 # repeatable; CLI binary to add to bash allowlist
          [-p | --provider &lt;name&gt;]
          [-m | --model &lt;id&gt;]
          [--base-url &lt;url&gt;]
          [--config &lt;path&gt;]
          [--env-file &lt;path&gt;]
          [--max-steps &lt;n&gt;]
          [--temperature &lt;t&gt;]
          [--system-prompt &lt;path-or-name&gt;]    # select BASE prompt file; replaces default
          [--system &lt;text&gt; | --system-file &lt;path&gt;]   # APPEND on top of base
          [--inspect-io]                  # record exact LLM request/response per turn to JSONL
          [--inspect-io-raw]              # disable redaction for captures only (RISK: plaintext secrets)
          [--per-tool-budget &lt;bytes&gt;]
          [--allow-mutations]
          [--bash-allow &lt;csv&gt;]
          [--bash-allow-file &lt;path&gt;]
          [--bash-pass-secret &lt;NAME&gt;]     # repeatable
          [--web-search-backend &lt;id&gt;]     # tavily|serpapi|brave|duckduckgo|custom-http
          [--introspect-depth &lt;n&gt;]        # default 2
          [--introspect-max-bytes &lt;n&gt;]    # per tool; default 10240
          [--introspect-timeout-ms &lt;ms&gt;]  # per --help call; default 5000
          [--introspect-total-budget-ms &lt;ms&gt;]  # whole discovery pass; default 60000
          [--refresh-capabilities]        # force regenerate cached capability docs
          [--mode &lt;mode&gt;]                 # chat|basic|tool|composite — which tool groups load (default: composite)
          [--enable-tool &lt;name&gt;]          # repeatable; enable an agt_* tool by canonical name (e.g. agt_todo_write)
          [--disable-tool &lt;name&gt;]         # repeatable; disable an agt_* tool by canonical name (e.g. agt_web_fetch)
          [--verbose]

        cli-agent show-capabilities --tool &lt;name&gt;
        cli-agent refresh-capabilities [--tool &lt;name&gt;]
        cli-agent extract-recipes --tool &lt;name&gt; [--max-recipes &lt;n&gt;]
    </command>
    <info>
        ## Overview

        cli-agent is a LangGraph ReAct agent that dynamically wraps any set of external
        CLI binaries. At startup it introspects each wrapped tool's --help tree
        (configurable depth, byte budget, and timeout), compiles a Markdown capability
        document per tool, and embeds those documents in the system prompt so that the
        underlying LLM can generate correct, subcommand-aware invocations.

        The agent ships with a cross-cutting toolkit:
          - bash_*  — execute shell commands against the declared allowlist
          - tool_help — look up the full help of a wrapped CLI / subcommand

        File read/list/write/edit/append are provided by the agent-tools pack as the
        first-party agt_file_read / agt_file_list / agt_file_write / agt_file_edit /
        agt_file_append tools (plan-012), reusing the existing file sandbox. agt_file_read
        / agt_file_list are read-only and default ON; agt_file_write / agt_file_edit /
        agt_file_append default ON but are MUTATION-GATED (they register only with
        --allow-mutations). All five ride the agent-tools pack, which loads in every
        mode except `chat` (see "Agent mode" below).

        Web search/fetch are provided by the agent-tools pack as the first-party
        agt_web_search / agt_web_fetch tools (plan-011), using the configured web
        backend. They are read-only, default ON, and ride the agent-tools pack
        (present in every mode except `chat`).

        Which tool GROUPS load is decided by the single `--mode` knob
        (chat | basic | tool | composite, default composite — see "Agent mode
        (tool-group loading)" below); `--allow-mutations` stays the orthogonal
        read-only/read-write axis, and individual agt_* tools are toggled with
        the repeatable `--enable-tool &lt;name&gt;` / `--disable-tool &lt;name&gt;` pair.

        All eight standard LLM providers are supported out of the box (see Provider
        Configuration below). The default provider is azure-openai.

        ## TUI mode

        Bare `cli-agent` invocation (no positional prompt and no `-i`/`--interactive`)
        drops into a raw-mode terminal UI: a streaming token-by-token renderer with
        an animated spinner, in-flight tool-call indicators, ESC-to-abort, multiline
        input editing, input history, and a slash-command catalogue. The TUI is a
        single-process Node.js implementation — no Ink, no Blessed, no readline.

        Bare `cli-agent`            → TUI (drops into raw-mode interactive UI)
        cli-agent &lt;prompt&gt;          → one-shot streaming (tokens written as they arrive)
        cli-agent -i | --interactive → readline REPL (lightweight legacy fallback)

        Detect TTY-incompatibility (`!process.stdout.isTTY`, `TERM=dumb`, or the
        explicit `CLI_AGENT_NO_TUI=1` opt-out) and the bare invocation refuses with a
        friendly fallback message pointing at `--interactive`.

        ### Slash commands

        Core
            /help                   List all registered slash commands and keybindings
            /quit | /exit           Graceful shutdown; persists thread index, closes log
            /new  | /reset          Start a fresh thread (preserves provider/model/tools)
            /clear                  Clear the visible transcript (history files untouched)

        History &amp; memory
            /history [offset]       Browse the most recent threads (newest first)
            /resume [&lt;threadId&gt;]    Adopt a previously-persisted thread mid-session
                                    (omit threadId to use cursor.json's lastThreadId)
            /last | /raw            Re-render the last assistant reply
            /copy                   Copy the last assistant reply to the system clipboard
            /memory                 Diagnostic view of MemorySaver state for the active thread

        Runtime switching
            /model [&lt;id&gt;]           Show or swap the active LLM model id (graph rebuilt in place)
            /provider [&lt;name&gt;]      Show or swap the active provider (one of the 8 standard names)
            /tools &lt;add|remove|list&gt; [name] [--save]
                                    Manage the wrapped-CLI tool list; --save persists to config.json
            /allow-mutations on|off Toggle mutating tools (agt_file_write/edit/append,
                                    agt_multiedit/patch) and rebuild the catalog
            /mode [chat|basic|tool|composite]
                                    Show (no arg) or switch the agent mode; a valid
                                    value rebuilds the tool catalog in place. Invalid
                                    values are rejected with no state change; switching
                                    to chat/basic while wrapped CLIs are loaded is
                                    rejected (they run through bash_run, absent in
                                    those modes)

        Capability inspection
            /capabilities           Per-tool freshness column (✓ fresh / ⚠ stale / ✗ missing)
            /refresh-capabilities [&lt;tool&gt;] | /refresh-caps
                                    Re-run capability discovery (single tool or all configured).
                                    Always performs the complete investigation including the
                                    LLM extractor, bypassing the skipLlmBelowBytes fast path.
            /tool-help &lt;tool&gt; [&lt;sub&gt;] | /help-tool
                                    TUI twin of the runtime tool_help LLM tool

        LLM I/O inspector (only meaningful when launched with --inspect-io; alias /inspect-io)
            /inspect status         Report whether capture is active, the capture file
                                    path, and how many records have been captured so far
                                    (the no-arg /inspect default is the same as status)
            /inspect show [turn]    Render one captured turn — its REQUEST block (system
                                    prompt, memory by role, current user content, bound
                                    tool schemas) and RESPONSE block (assistant text,
                                    tool-calls with args, tool results) — in a clearly
                                    delimited, individually-labelled form, long blocks
                                    truncated with a visible `… [truncated]` marker.
                                    Omit [turn] for the latest; [turn] is 1-based.
            /inspect on | off       Informational only. File capture is established at
                                    launch (see Design Decision below): the JSONL writer
                                    and the bound-tool snapshot are wired when the session
                                    is built, so /inspect on|off cannot retro-actively
                                    create or tear down the writer mid-session. The
                                    command prints a clear [system] message saying so
                                    rather than silently doing nothing — to actually turn
                                    capture on, relaunch with --inspect-io.

        ### Keybindings

        Enter                       Submit current input
        Shift+Enter / Ctrl+J        Insert newline (Shift+Enter requires a CSI-u-capable
                                    terminal — Kitty / Ghostty / iTerm2 with the right
                                    setting; Ctrl+J is the universal fallback)
        ←/→                         Cursor left/right within the line
        ↑/↓                         Move between buffer lines, or browse input history
                                    at the top/bottom edge
        Home / End / Ctrl+A / Ctrl+E  Cursor to start/end of line
        Option+←/→ / Ctrl+←/→       Word-by-word motion
        Backspace / Delete          Delete char left / at cursor
        Ctrl+W / Alt+Backspace      Delete word left
        Ctrl+U / Ctrl+K             Delete to start / end of line
        Ctrl+C                      First press: cancel the current input or abort the
                                    in-flight LLM turn; print a hint that mentions the
                                    second-press exit. Second press within 1.5 s: graceful
                                    shutdown (same path as /quit).
        ESC                         During a turn: abort the LLM call via AbortController
        Ctrl+D                      On empty input: exit the TUI

        ### Persistent history layout

        Per-thread JSONL files plus an index live under the per-user config folder:

        ~/.tool-agents/cli-agent/history/      (mode 0700)
            thread-&lt;UTC-iso&gt;-&lt;threadId&gt;.jsonl  (mode 0600 — one line per turn)
            index.jsonl                         (mode 0600 — one line per thread; atomic)
            cursor.json                         (mode 0600 — last active threadId + ts)
            checkpoint-&lt;threadId&gt;.json          (mode 0600 — LangGraph state snapshot)

        Per-turn JSONL records the user prompt and the assistant final text only —
        chunk-level fragments stay in `~/.tool-agents/cli-agent/logs/`.

        ### Resume

        cli-agent's MemorySaver checkpointer is in-process — restarting the binary
        normally drops every LLM-side conversation memory. To restore the LLM-side
        state across restarts, the TUI snapshots the active thread's checkpointer
        to disk after every turn (`checkpoint-&lt;threadId&gt;.json`, see layout above)
        and rehydrates it on `--resume`.

        cli-agent --resume                  Resume the thread named in cursor.json
        cli-agent -r &lt;threadId&gt;             Resume the specified thread by id
        /resume                             (slash) Same as --resume, mid-session
        /resume &lt;threadId&gt;                  (slash) Same as -r &lt;threadId&gt;, mid-session

        On `--resume` the TUI:
          - Reads the snapshot file and writes the encoded blobs back into a
            fresh MemorySaver before constructing the agent graph; the LLM
            sees the prior conversation as part of its checkpointed state.
          - Re-renders the prior turns from the thread's JSONL transcript so
            the user sees what was previously discussed.

        Resume is supported only in TUI mode. `--resume --interactive` and
        `--resume &lt;prompt&gt;` exit with code 2 and a clear error message.

        Snapshots are best-effort: a write failure is logged in dim yellow as
        a one-line warning and the session continues. The previous on-disk
        snapshot (if any) is unchanged, so the next `--resume` still works.

        Snapshots are NOT auto-pruned. To free space, `rm` the snapshot files
        for threads you no longer need.

        ## Subcommands

        cli-agent [prompt]
            Run the agent with a one-shot prompt. Streams tokens to stdout as they
            arrive; exits after the LLM produces a final answer or exceeds --max-steps.

        cli-agent (no args)
            Drops into the raw-mode TUI. Refuses with a friendly fallback message on
            non-TTY contexts or when CLI_AGENT_NO_TUI=1 is set.

        cli-agent --interactive / -i
            Enter the legacy readline REPL session. Each user turn is processed as a
            separate agent invocation sharing the same capability documents. Useful in
            non-TTY contexts (scripts, restricted SSH shells).

        cli-agent show-capabilities --tool &lt;name&gt;
            Print the compiled Markdown capability document for the named tool to
            stdout. Reads from the cache; does not re-introspect.

        cli-agent refresh-capabilities [--tool &lt;name&gt;]
            Re-run the --help introspection pass and regenerate the cached capability
            documents. If --tool is omitted, refreshes all tools declared in config.json.
            This subcommand always performs the COMPLETE investigation including the LLM
            extractor, regardless of how small the top-level --help happens to be — the
            `capabilities.skipLlmBelowBytes` fast path is bypassed so a manual refresh
            always produces a fully LLM-analyzed capability document.

            Discovery also probes `man -w &lt;tool&gt;` to detect a manual page. When found,
            the cached document records `manRef: man:&lt;section&gt; &lt;tool&gt;` in frontmatter
            and emits a `## Manual reference` section pointing the agent at
            `man &lt;section&gt; &lt;tool&gt;`. When absent, neither artifact is written.

        cli-agent extract-recipes --tool &lt;name&gt; [--max-recipes &lt;n&gt;] [--stdout] [--append]
            Propose LLM-generated canonical invocation recipes for the given tool.
            Reads the cached capability doc and (when a manRef is recorded) the man
            page, feeds them through the configured LLM, and emits a `### &lt;title&gt;` +
            fenced-bash block per recipe. Default 8 recipes; hard cap 20.

            By default, writes the proposal directly between the existing
            `&lt;!-- USER-RECIPES:START --&gt;` / `&lt;!-- USER-RECIPES:END --&gt;` markers
            in `~/.tool-agents/cli-agent/capabilities/&lt;tool&gt;.md`, replacing any
            existing inner content. The user is the curator: anything they don't
            want they delete by hand.

            --stdout      Print to stdout without modifying any file (use for
                          piping, review, or CI).
            --append      Keep any existing recipes and append the new ones
                          instead of replacing the inner block.

            Raises `UsageError` when the capability document is missing the
            USER-RECIPES marker pair (e.g. an old schema-1 doc); fix it by
            running `refresh-capabilities` to regenerate the schema-2 shape.

        ## Capability Cache Behavior

        On every agent invocation, for each declared --tool &lt;name&gt;:
          - If ~/.tool-agents/cli-agent/capabilities/&lt;tool&gt;.md ALREADY EXISTS,
            the agent skips capability discovery entirely — no `which`, no
            `&lt;tool&gt; --version`, no `--help` calls, no LLM call. The cached
            document is loaded as-is and embedded in the system prompt.
            This makes warm-cache startup essentially free (a few ms per
            tool instead of 10-30 s on cold cache).
          - If the file is ABSENT, full discovery runs: probe binary,
            recursively introspect --help, call the LLM to extract
            subcommands, write the cache file.
          - To force re-discovery (e.g. after upgrading a wrapped binary
            to a new major version), pass --refresh-capabilities or run
            `cli-agent refresh-capabilities --tool &lt;name&gt;`. This is the
            only way to refresh the cache; the agent does NOT auto-detect
            binary upgrades.
          - User content placed inside the `&lt;!-- USER-RECIPES:START --&gt; ...
            &lt;!-- USER-RECIPES:END --&gt;` and `&lt;!-- USER-NOTES:START --&gt; ...
            &lt;!-- USER-NOTES:END --&gt;` marker pairs is preserved verbatim
            across every refresh. Recipes appear above notes; both are
            embedded in the system prompt when within byte budget.
          - schemaVersion 1 documents (pre-0.3.0) are treated as cache
            miss on read and re-discovered on next refresh; user content
            inside USER-NOTES is carried forward through the existing
            preservation path. USER-RECIPES is empty after the upgrade.

        The capabilities folder also stores ONE non-tool file:

          - `system-prompt.md` — the BASE system prompt (see "System Prompt
            Selection" below). The agent reads tool capability documents by
            exact filename match (`&lt;tool&gt;.md`), so this reserved name does
            NOT collide with any wrapped CLI unless someone literally wraps
            a CLI named `system-prompt`.

        ## System Prompt Selection

        The base system prompt — the instruction block that establishes the
        agent's identity and generic conduct — lives on disk at:

          ~/.tool-agents/cli-agent/capabilities/system-prompt.md  (mode 0600)

        On first run, the agent seeds this file with the built-in default. On
        subsequent runs, the file on disk is the source of truth — edit it to
        change how the agent behaves, no rebuild required.

        ### Slim base + runtime-injected built-in-tools block

        The seeded default base prompt is deliberately SLIM and tool-agnostic:
        it states the agent's identity and a couple of universal conduct rules
        (keep responses concise; never echo raw credentials) and says NOTHING
        about specific tools. The built-in cross-cutting toolkit's instructions
        — the `bash_run` framing, the CORE RULES, the OUT-OF-SCOPE bullets, and
        the available-tools list — are NOT baked into the base. They are
        injected at runtime as a `## Built-in tools` section, ONLY when the
        built-in tools are actually loaded — i.e. when the effective mode is
        `tool` or `composite`; in `chat` and `basic` modes the block is absent.
        This mirrors the agent-tools (`agt_*`) block and keeps the prompt
        coherent with the loaded toolset: with the built-in tools off, the
        model is no longer told about tools it cannot call (see "chat/basic
        modes remove `bash_run`" under "Agent mode (tool-group loading)").

        The `## Built-in tools` block is **adaptive**: its content describes
        EXACTLY the built-in tools actually registered this session, derived
        from the resolved tool names rather than a static superset. Concretely:

        - The `bash_run` framing and its two confirmation CORE RULES appear
          whenever `bash_run` is bound (i.e. the built-in group is on; since
          2026-07-04 an empty allowlist no longer unbinds it). The framing has
          two forms: an ALLOW-LISTED form when entries are configured, and an
          UNRESTRICTED form (with restraint guidance — prefer read-only, never
          run destructive commands unless asked) when NO allowlist is
          configured. Only a profile `deny` of `bash_run` produces the "command
          execution is unavailable" form.
        - The general CORE RULES (capability docs / `tool_help`, read-only
          evidence, error-JSON handling, `__truncated` handling) and the
          read-only built-in tools (`bash_list_allowed`/`bash_which`,
          `tool_help`) are always described when the built-in tools are
          loaded (mode `tool` or `composite`). (plan-011:
          web moved to the agent-tools pack, so the built-in block no longer
          mentions `web_search`/`web_fetch` or the "never invent URLs" rule;
          plan-012: the file tools likewise moved, so the built-in block no
          longer mentions `file_read`/`file_list` or the mutating-file clause
          (`file_write`/`file_edit`/`file_append`) — that guidance now rides on
          the `agt_file_*` and `agt_web_*` descriptions in the agent-tools block,
          and the dead `BuiltinToolsPresence.mutatingFile` flag is removed.)

        Because the presence is derived from the post-scoping tool list, a
        profile `deny` of a built-in tool is reflected too. The net effect: the
        inspector's "Bound tool schemas" and the system-prompt tool prose agree
        for the built-in toolkit across every gate (mode, allowlist,
        `--allow-mutations`, profile deny).

        Assembled-prompt order: base → built-in-tools block (if loaded) →
        wrapped-CLI capabilities → agent-tools block (if loaded) → user-provided
        instructions.

        ### In-place upgrade of an unmodified default

        Because the default was restructured (the built-in tool prose moved out
        of the base and into the runtime block), bootstrap performs a one-time,
        in-place upgrade: if `system-prompt.md` already exists AND its bytes are
        EXACTLY equal to a prior shipped default, it is overwritten with the new
        slim default. If the file differs in any way — i.e. you customized it,
        or it is already the new slim default — it is left BYTE-UNCHANGED. The
        upgrade never throws; a failed upgrade simply leaves the existing file.
        This is a bootstrap convenience, NOT a runtime fallback: a missing or
        unreadable SELECTED prompt still exits with code 2 (UsageError).

        ### Customized-base caveat

        The `## Built-in tools` block is injected on top of whatever base is on
        disk (exactly like the `agt_*` block). For the default (or upgraded)
        base — which is slim — there is no duplication. But if you keep a
        CUSTOMIZED base that STILL contains its own tool prose (e.g. you pasted
        the old built-in tool instructions into your prompt), the injected block
        can duplicate that prose when the built-in tools are loaded. That prose
        is yours to manage: drop it from your custom base and let the runtime
        block supply it, so it stays in lockstep with the loaded toolset.

        To use a DIFFERENT base prompt for a single invocation (or always),
        pass `--system-prompt &lt;path-or-name&gt;`:

          - absolute path             → used verbatim
          - bare filename             → resolved against the capabilities folder
          - relative path with slash  → resolved against the current working dir

        Equivalent env var: `CLI_AGENT_SYSTEM_PROMPT`.
        Equivalent config.json key: `systemPromptFile`.
        Precedence: CLI flag &gt; env (any tier) &gt; config.json &gt; default file path.

        If the resolved path is missing or unreadable, the agent exits with
        code 2 (UsageError) — no silent fallback to the built-in default. The
        built-in default is used ONLY as the bootstrap seed.

        `--system &lt;text&gt;` and `--system-file &lt;path&gt;` continue to APPEND on
        top of whichever base prompt is selected, under a `## User-provided
        instructions` section.

        ## LLM I/O Inspector

        A diagnostic switch that records the EXACT conversation between cli-agent
        and the LLM — turn by turn — to a structured, tailable JSONL file, so you
        can read back precisely what context the model received and exactly what
        it returned. It is a parallel, additive, read-only channel: it never edits,
        replays, or re-sends anything, and when the switch is off the agent's
        behaviour, provider payloads, streamed output, the operational `logs/`
        JSONL, transcript files, and `--help` output are byte-identical to a build
        without the feature.

        Enable it with the launch-time flag `--inspect-io` (it is OFF by default),
        or via `CLI_AGENT_INSPECT_IO=1` / the `config.json` `inspectIo.enabled`
        key — see "LLM I/O inspector" in CLI Parameters below and the
        configuration guide for the full precedence chain. The switch must be set
        at launch so that one-shot runs and the very first interactive turn are
        captured.

        ### What is captured (per LLM turn)

        For every LLM round-trip the inspector records both sides of the exchange:

          REQUEST (what cli-agent sent to the model):
            - the complete assembled system prompt (base prompt + capabilities
              section + agent-tools block + any --system / --system-file additions,
              exactly as composed for that turn);
            - the complete in-thread conversation memory — the ordered list of
              prior human / ai / tool messages the model receives;
            - the current turn's user/human content;
            - the bound tool/function JSON schemas the model is given (tool names,
              descriptions, and parameter schemas) — i.e. the instructions the LLM
              needs in order to call cli-agent's tools. The tool-use prose for each
              tool is embedded inside the captured system prompt; the JSON schemas
              are captured as a separate `boundTools` array. Schemas are captured
              once per session (they do not change between turns) and attached to
              the first request of each turn (`stepIndex: 0`).

          RESPONSE (what the model returned):
            - the assistant message text (`finalText`, the final assembled text);
            - every tool-call the model emitted (tool name + parsed arguments
              object), in order;
            - the tool results fed back into the loop (tool name, ok/error,
              duration, and — when present — the result payload), so the
              request → response → tool-result chain is inspectable end to end.

        ### Capture seam — provider-normalized, all 8 providers

        Capture hooks LangChain's `streamEvents v2` boundary, which sits ABOVE the
        provider SDK, so all eight supported providers produce the same record
        structure with no provider-specific code paths. The request is read from
        the literal message array the model is about to receive (which already
        contains the system prompt as a system message plus the full memory), and
        the response tool-calls are read from the aggregated end-of-turn message
        (fully-parsed argument objects, never partial streamed fragments). The
        non-streaming one-shot/REPL path is captured from the graph result after
        invocation.

        ### Capture file: location, format, permissions

        Captures are written under the per-user agent directory:

          ~/.tool-agents/cli-agent/io-captures/
              session-&lt;UTC&gt;-&lt;sessionId&gt;.jsonl   (mode 0600)
              latest.jsonl  → relative symlink to the most recent session file
                              (copy-skip fallback on platforms that reject symlinks)

        The directory is created at mode 0700; the `io-captures/` folder shares the
        same privacy posture as `logs/` because captures can contain the full
        system prompt, memory, and tool arguments. The capture file is JSONL — ONE
        JSON object per line — written incrementally as the conversation proceeds,
        so a partially-completed session still yields a valid, readable-so-far
        artifact. Because it is written live, you can watch it from a second
        terminal:

          tail -f ~/.tool-agents/cli-agent/io-captures/latest.jsonl

        Each line is one record of one of three kinds, sharing the correlation
        envelope `{ sessionId, threadId, turnId, stepIndex, ts }`:

          - `request`      — the model input: `messages` (each `{ role, content,
                             toolCalls?, toolCallId? }`) plus `boundTools` (only on
                             `stepIndex: 0`).
          - `response`     — `finalText` (assistant text) and `toolCalls`
                             (`{ id?, name, args }[]`, parsed-object args).
          - `tool_result`  — `toolName`, `ok`, `durationMs`, and optional `result`.

        `sessionId` matches the operational logger's session id; `turnId` is minted
        once per user turn; `stepIndex` distinguishes the multiple model calls a
        single ReAct turn can make (the request → tool → request chain).

        Field cap: any single string field larger than 64 KiB is truncated to its
        first 64 KiB and the record is marked with `_truncated: true` plus an
        `_orig_size_bytes` map recording the original byte size of each truncated
        field (rather than dropping large payloads silently).

        ### In-TUI inspection — the /inspect command

        In the raw-mode TUI, the `/inspect` slash command reads the in-memory
        capture and renders it without leaving the session:

          /inspect status        whether capture is active, the capture file path,
                                  and the number of records captured so far (this is
                                  also the no-arg default).
          /inspect show [turn]    render one turn's full REQUEST block (system
                                  prompt, memory by role, current user content,
                                  bound tool schemas) and RESPONSE block (assistant
                                  text, each tool-call name + args, each tool
                                  result), clearly labelled and delimited, with long
                                  blocks truncated by a visible `… [truncated]`
                                  marker. `[turn]` is 1-based; omit it for the latest.
          /inspect on | off       INFORMATIONAL ONLY. File capture is established at
                                  launch (Design Decision below); these sub-commands
                                  print a clear `[system]` message that capture is
                                  wired via `--inspect-io` at launch and cannot be
                                  retro-actively created/destroyed mid-session — they
                                  do NOT silently no-op.

        `/inspect` is also available under the alias `/inspect-io`. Its output uses
        the same stdout path as every other slash command,
        so it never interleaves with the live token stream or races the spinner.
        On a non-TTY / `CLI_AGENT_NO_TUI=1` context there is no TUI, so use the
        tailable file instead.

        ### Redaction (ON by default) and the raw opt-out — RISK

        By default, everything written to the capture file passes through the same
        redaction helper cli-agent uses for its logs: message content is run
        through `redactString` and tool-call args / tool results through
        `redactObject`, so credential-shaped values are masked.

        Because the request asked for EXACTLY what was sent, an explicit opt-out is
        provided: `--inspect-io-raw` (or `CLI_AGENT_INSPECT_IO_RAW=1`, or
        `config.json` `inspectIo.redact: false`) DISABLES redaction for the capture
        file only. This is a real secret-exposure RISK: with it set, secrets and
        API keys present in the system prompt, the conversation memory, or tool
        arguments are written to disk in PLAINTEXT under `io-captures/`. cli-agent
        prints a prominent one-line stderr warning BEFORE the capture file is
        opened whenever raw mode is active. Use it only against scrubbed inputs,
        and delete raw captures when you are done.

        ### No fallback

        The inspector follows cli-agent's strict no-fallback rule. When it is
        explicitly requested but cannot be initialised — e.g. the capture directory
        cannot be created or is not writable, or an invalid (non-boolean)
        `CLI_AGENT_INSPECT_IO` / `CLI_AGENT_INSPECT_IO_RAW` value is supplied —
        cli-agent raises `ConfigurationError` and exits, rather than silently
        disabling capture or substituting a default mode. When the switch is simply
        not requested, capture is off (a no-op channel); that is the normal disabled
        state, distinct from a misconfiguration.

        ### Known limitations

          - Provider-normalized fidelity, not literal wire bytes. Capture is taken
            at the LangChain message layer, one transformation step above each
            provider's on-the-wire HTTP request/response bodies. Literal per-provider
            wire-byte capture is explicitly deferred (a separate, provider-by-provider
            effort).
          - Per-turn granularity with `stepIndex`. `/inspect show [turn]` addresses
            the 1-based user turn; each ReAct model call within that turn is a
            `stepIndex` sub-step.
          - Not auto-pruned. Capture files accumulate under `io-captures/`; pruning
            is your responsibility (mirrors the existing checkpoint-snapshot policy).
            To reclaim space, `rm` the session files you no longer need.
          - Mid-session `/inspect on|off` cannot create the writer. The JSONL writer
            and the bound-tool snapshot are wired at session build, so capture must
            be enabled at launch with `--inspect-io`; `/inspect on|off` only reports
            this.
          - Scope. The inspector targets the main interactive (TUI), one-shot, and
            legacy-REPL agent conversation. The capability-discovery and
            composite-synthesis LLM calls are out of scope.

        ## CLI Parameters

        --tool &lt;name&gt;
            (Repeatable) Name of an external CLI binary to wrap. Each named binary is
            added to the bash_run allowlist and introspected on first launch.
            Wrapped CLIs execute through bash_run, which only exists in `tool`
            and `composite` modes — combining --tool (or config.json `tools`)
            with an effective mode of `chat` or `basic`, from ANY surface
            (flag, env, profile, or config.json), raises UsageError (exit 2)
            directing you to --mode tool or --mode composite.

        -p | --provider &lt;name&gt;
            LLM provider to use. One of: openai, anthropic, gemini, azure-openai,
            azure-anthropic, ollama, litellm, mlx. Overrides config.json and env vars.

        -m | --model &lt;id&gt;
            Model identifier understood by the chosen provider (e.g. gpt-4o,
            claude-3-5-sonnet-latest, gemini-2.0-flash). Overrides config.json.

        --base-url &lt;url&gt;
            Override the provider API base URL (useful for proxies and local servers).

        --config &lt;path&gt;
            Path to a JSON config file. Defaults to ~/.tool-agents/cli-agent/config.json.

        --env-file &lt;path&gt;
            Path to an additional .env file to load (tier 3 in the resolution chain).
            Defaults to .env in the current working directory.

        --max-steps &lt;n&gt;
            Maximum number of ReAct steps before the agent stops and returns whatever
            it has. Must be a positive integer.

        --temperature &lt;t&gt;
            Sampling temperature passed to the LLM API. Float in [0, 2].

        --system-prompt &lt;path-or-name&gt;
            Select the BASE system prompt file (replaces today's hard-coded default).
            Resolution rules:
              - absolute path             → used verbatim
              - bare filename (no slash)  → joined onto &lt;capabilitiesDir&gt;
              - relative path with slash  → joined onto cwd
            Omit the flag to use the seeded default at
              &lt;capabilitiesDir&gt;/system-prompt.md
            (the agent writes the built-in default to that path on first run, so users
            can edit it without rebuilding). If the resolved path does not exist, the
            agent exits with code 2 (UsageError) — no silent fallback to the built-in.
            Equivalent env var: CLI_AGENT_SYSTEM_PROMPT (same resolution rules).
            Equivalent config.json key: systemPromptFile (string).
            Precedence: CLI flag &gt; env &gt; config.json &gt; default file path.

        --system &lt;text&gt;
            Append extra text to the system prompt (inline form). Composes ON TOP
            of whichever base prompt --system-prompt selected.

        --system-file &lt;path&gt;
            Append the contents of a file to the system prompt. Composes ON TOP
            of whichever base prompt --system-prompt selected.

        --inspect-io
            Enable the LLM I/O inspector for this session. Records the exact
            provider-normalized request (assembled system prompt + full memory +
            current user content + bound tool/function JSON schemas) and response
            (assistant text + tool-calls + tool results) for every LLM turn to a
            tailable JSONL file under ~/.tool-agents/cli-agent/io-captures/. OFF by
            default. Equivalent env var: CLI_AGENT_INSPECT_IO. Equivalent
            config.json key: inspectIo.enabled. Precedence: CLI flag &gt; env &gt;
            config.json &gt; off. Redaction is ON by default. See "LLM I/O Inspector"
            above. When explicitly requested but un-initialisable (e.g. capture
            directory not writable), the agent exits with ConfigurationError — no
            silent fallback to disabled.

        --inspect-io-raw
            Disable redaction for the capture file ONLY. RISK: secrets / API keys
            in the system prompt, memory, or tool args are then written to disk in
            PLAINTEXT under io-captures/. A prominent stderr warning is printed
            before any unredacted byte is written. Implies the inspector is enabled
            only in combination with --inspect-io / CLI_AGENT_INSPECT_IO; on its
            own it just sets the redaction mode. Equivalent env var:
            CLI_AGENT_INSPECT_IO_RAW (truthy). Equivalent config.json key:
            inspectIo.redact (false). Default: redaction ON.

        --per-tool-budget &lt;bytes&gt;
            Override capabilities.maxBytesPerTool for this invocation.

        --allow-mutations
            Unlock the mutation-gated agent-tools (agt_file_write, agt_file_edit,
            agt_file_append, agt_multiedit, agt_patch) and any bash command that
            produces side effects. Without this flag the agent operates in
            read-only mode.

        --bash-allow &lt;csv&gt;
            Comma-separated list of additional binary names or `argv-regex:&lt;pattern&gt;`
            rules to add to the bash allowlist for this invocation.

        --bash-allow-file &lt;path&gt;
            Path to a newline-separated file of allowlist rules (same syntax as
            --bash-allow).

        --bash-pass-secret &lt;NAME&gt;
            (Repeatable) Allow the named env var to be forwarded to spawned child
            processes even if it looks like a credential.

        --web-search-backend &lt;id&gt;
            Override the web search/fetch backend. One of: tavily, serpapi, brave,
            duckduckgo, custom-http.

        --introspect-depth &lt;n&gt;
            Maximum recursion depth for --help tree introspection (default 2).

        --introspect-max-bytes &lt;n&gt;
            Per-tool byte budget for the compiled capability document (default 10240).

        --introspect-timeout-ms &lt;ms&gt;
            Per individual --help call timeout in milliseconds (default 5000).

        --introspect-total-budget-ms &lt;ms&gt;
            Total time budget (ms) for the whole capability-discovery pass (default 60000).

        --refresh-capabilities
            Force regeneration of all cached capability documents before processing the
            prompt.

        --mode &lt;mode&gt;
            Select which tool GROUPS load for the session. One of: chat, basic,
            tool, composite (default: composite). chat = no tool groups (plain
            conversational LLM); basic = the agent-tools pack (agt_*) only;
            tool = built-in toolkit (bash_*, tool_help) + agt_* pack;
            composite = all three groups including composite/virtual tools.
            See "Agent mode (tool-group loading)" below for the mapping table
            and the migration notes. An invalid value raises UsageError
            (exit 2) listing the four valid modes. Equivalent env var:
            CLI_AGENT_MODE. Equivalent config.json key: mode (string).
            Equivalent profile key: cliParams.mode. Precedence (pinnable-knob
            chain): CLI flag &gt; env &gt; profile &gt; config.json &gt;
            default(composite). An invalid env/config value raises
            ConfigurationError (exit 3) — no fallback; the profile value is
            schema-validated (enum).

        --enable-tool &lt;name&gt; / --disable-tool &lt;name&gt;
            (Both repeatable) Enable / disable a single agent-tools-pack tool
            by its canonical registered name: agt_glob, agt_grep,
            agt_multiedit, agt_patch, agt_todo_read, agt_todo_write,
            agt_web_search, agt_web_fetch, agt_file_read, agt_file_list,
            agt_file_write, agt_file_edit, agt_file_append. An unknown name
            raises UsageError (exit 2) listing all 13 valid names; naming the
            same tool in both flags raises UsageError (exit 2) — fail-fast, no
            silent precedence. These flags occupy the CLI tier of the per-tool
            chain (CLI flag &gt; env CLI_AGENT_AGT_* &gt; config.json
            agentTools.tools.* &gt; default) and operate WITHIN the pack — they
            do not resurrect the pack when the mode excludes it (chat), and
            mutation gating is unchanged: agt_file_write/edit/append,
            agt_multiedit, and agt_patch still additionally require
            --allow-mutations.

        --verbose
            Emit structured debug logs to stderr during the agent run.

        ## Provider Configuration

        The agent supports eight LLM providers. Configuration is resolved in the
        following priority order (lowest to highest):

          1. Shell environment variables (process.env)
          2. ~/.tool-agents/cli-agent/.env
          3. Local .env in the current working directory
          4. CLI flags (--provider, --model, --base-url, etc.)

        ### Direct OpenAI
          OPENAI_API_KEY      — API key (required)
          OPENAI_BASE_URL     — override base URL (optional)
          OPENAI_ORG_ID       — organization ID (optional)

        ### Direct Anthropic
          ANTHROPIC_API_KEY   — API key (required)
          ANTHROPIC_BASE_URL  — override base URL (optional)

        ### Gemini
          GOOGLE_API_KEY      — API key (required); GEMINI_API_KEY accepted as alias

        ### Azure OpenAI
          AZURE_OPENAI_API_KEY      — API key (required)
          AZURE_OPENAI_ENDPOINT     — Azure endpoint URL (required)
          AZURE_OPENAI_DEPLOYMENT   — deployment name / model alias (required)
          AZURE_OPENAI_API_VERSION  — API version string (required)

        ### Azure Anthropic (Foundry)
          AZURE_AI_INFERENCE_KEY      — API key (required)
          AZURE_AI_INFERENCE_ENDPOINT — Azure AI Inference endpoint (required)

        ### Local Ollama
          OLLAMA_HOST  — base URL of the Ollama server (e.g. http://localhost:11434)

        ### Local LiteLLM proxy
          LITELLM_PROXY_URL    — proxy base URL (required)
          LITELLM_MASTER_KEY   — master key for the proxy (required)

        ### Local MLX-LM
          OPENAI_BASE_URL  — point to the MLX-LM OpenAI-compatible server
                             (reuses the OpenAI base URL convention; no dedicated var)

        ## Extra Configuration Variables

        The following variables are read from config.json or environment (see resolution
        chain above):

        tools
            Default array of CLI binary names to wrap, e.g. ["git","gh","kubectl"].
            Each entry is auto-added to the bash allowlist at startup. Requires
            an effective mode of tool or composite (wrapped CLIs run through
            bash_run); with mode chat or basic a non-empty merged tools list
            raises UsageError (exit 2).

        mode  (config.json key; string)
            Persisted default agent mode: "chat" | "basic" | "tool" |
            "composite". Lowest explicit tier of the mode chain (CLI --mode &gt;
            env CLI_AGENT_MODE &gt; profile cliParams.mode &gt; config.json mode &gt;
            default "composite"). A value outside the enum raises
            ConfigurationError (exit 3) — no fallback.

        CLI_AGENT_MODE
            Env form of the mode knob (same enum). Read through the layered
            env tier (shell env &gt; ~/.tool-agents/cli-agent/.env &gt; local ./.env).
            A value outside the enum raises ConfigurationError (exit 3).

        REJECTED LEGACY KEYS (plan-015 — do not use): the former group-toggle
        env vars CLI_AGENT_DISABLE_COMPOSITES / CLI_AGENT_DISABLE_BUILTIN_TOOLS /
        CLI_AGENT_DISABLE_AGENT_TOOLS (a SET value — any value — raises
        ConfigurationError with a migration hint) and the former config.json
        keys `composites`, `builtinTools`, `agentTools.enabled` (presence
        raises ConfigurationError with a migration hint). `agentTools.tools.*`
        remains valid. See "Migration from the removed toggles (plan-015)"
        under "Agent mode (tool-group loading)".

        bash.allow
            Additional bash allowlist entries (binary names or `argv-regex:&lt;pattern&gt;`
            rules) following the cli-agent-builder spec. UNRESTRICTED DEFAULT
            (2026-07-04): when NO allowlist entry is configured anywhere (this
            key empty, no `--bash-allow` / `--bash-allow-file` /
            `BASH_ALLOWED_COMMANDS`, and no wrapped `--tool`), `bash_run` runs
            in UNRESTRICTED mode and may execute ANY binary on PATH; cli-agent
            prints a one-line stderr notice at startup. Adding any entry
            restores restrictive (OR'd) matching. `--allow-mutations` and the
            `cwd` sandbox still gate independently in both modes.

        bash.allowedRoots
            Filesystem roots inside which bash_run may set its cwd.

        bash.passEnv
            Env-var names the spawned child inherits from the agent process.
            Credential-shaped names are stripped unless opted in via --bash-pass-secret.

        bash.timeoutMs
            Per-call timeout for bash_run in milliseconds. Max 300000.

        bash.maxOutputBytes
            Per-stream output cap for bash_run in bytes.

        webSearch.backend
            Selected backend id: tavily | serpapi | brave | duckduckgo | custom-http.

        capabilities.depth
            Maximum --help introspection recursion depth (default 2).

        capabilities.maxBytesPerTool
            Max bytes of compiled capability Markdown embedded in the system prompt
            per tool (default 10240).

        capabilities.timeoutMs
            Per --help call timeout during capability discovery (default 5000).

        capabilities.totalTimeoutMs
            Total time budget for the whole capability-discovery pass (default 60000).

        capabilities.subcommandExtractor
            Provider/model used by the cheap LLM call that parses raw --help output
            to extract subcommand lists (defaults to the active provider/model).

        fileEdit.root
            Working root for the agt_file_* tools (plan-012); defaults to
            process.cwd() at agent launch.

        fileEdit.allowPaths
            Optional explicit allowlist of paths outside the root that the
            agt_file_* tools may also access.

        BASH_ALLOWED_COMMANDS
            CSV of binary names auto-added to the bash allowlist (env form of bash.allow).

        WEB_SEARCH_BACKEND
            Selected backend id env form (tavily|serpapi|brave|duckduckgo|custom-http).

        TAVILY_API_KEY
            API key for the Tavily web search backend (required if backend=tavily).

        SERPAPI_API_KEY
            API key for the SerpAPI backend (required if backend=serpapi).

        BRAVE_API_KEY
            API key for the Brave Search backend (required if backend=brave).

        WEB_SEARCH_URL
            Endpoint URL for the custom-http web search backend.

        WEB_SEARCH_API_KEY
            Optional auth token for the custom-http web search backend.

        WEB_SEARCH_MAX_REQUESTS
            Per-session hard cap for agt_web_search/agt_web_fetch calls
            (default 50). The two tools share one decrementing budget.

        CLI_AGENT_LOG
            Set to off|0|false|no to disable structured JSONL logging (default on).

        FILE_EDIT_ROOT
            Override the agt_file_* tools' working root (env form of fileEdit.root).

        CLI_AGENT_INSPECT_IO
            Enable the LLM I/O inspector (env form of --inspect-io / config.json
            inspectIo.enabled). Truthy (1/true/yes/on) turns capture on; off by
            default. An invalid (non-boolean) value raises ConfigurationError — no
            fallback. See "LLM I/O Inspector" above.

        CLI_AGENT_INSPECT_IO_RAW
            Disable redaction for captures ONLY (env form of --inspect-io-raw /
            config.json inspectIo.redact:false). Truthy disables redaction; a
            stderr warning is printed before any unredacted byte is written. RISK:
            plaintext secrets on disk. Invalid value raises ConfigurationError.

        inspectIo  (config.json key; object)
            { "enabled"?: boolean, "redact"?: boolean, "dir"?: string }. The
            lowest-priority of the three explicit inspector tiers. `enabled` turns
            capture on; `redact: false` opts out of redaction (RISK); `dir`
            overrides the default capture directory (~/.tool-agents/cli-agent/
            io-captures/). All fields optional. See the configuration guide for the
            full per-variable treatment and precedence.

        ## Examples

        # One-shot: use gh CLI to list open PRs
        cli-agent --tool gh "List all open pull requests in the current repo"

        # Plain conversational LLM — no tools at all (empty-toolset state)
        cli-agent --mode chat "Explain the difference between rebase and merge"

        # agt_* pack only, with the todo pair switched on and grep switched off
        cli-agent --mode basic --enable-tool agt_todo_write --disable-tool agt_grep \
          "Draft a todo list for refactoring this repo"

        # Built-in toolkit + agt_* pack, no composites (wrapped CLIs allowed)
        cli-agent --mode tool --tool git "Summarize the last 3 commits"

        # Interactive session wrapping git and gh
        cli-agent --interactive --tool git --tool gh

        # Use Anthropic provider with a specific model
        cli-agent --tool kubectl -p anthropic -m claude-3-5-sonnet-latest \
          "Show me all failing pods across all namespaces"

        # Force refresh capability documents then run a prompt
        cli-agent --tool helm --refresh-capabilities \
          "Upgrade the my-app release to chart version 2.3.1"

        # Show cached capability document for a tool
        cli-agent show-capabilities --tool gh

        # Refresh only the git capability document
        cli-agent refresh-capabilities --tool git

        # Run with a custom system prompt file and verbose logging
        cli-agent --tool kubectl --system-file ./prompts/k8s-expert.txt --verbose \
          "What is the memory usage of each pod in namespace production?"

        # Use LiteLLM proxy with a custom .env file
        cli-agent --tool gh --env-file /secrets/litellm.env -p litellm \
          "Create a GitHub issue summarizing the build failures from the last CI run"

        # Record the exact LLM request/response to a tailable JSONL file
        cli-agent --tool git --inspect-io "Summarize the last 3 commits"
        # ...then in a second terminal:
        tail -f ~/.tool-agents/cli-agent/io-captures/latest.jsonl

        # Capture WITHOUT redaction (RISK: plaintext secrets) — use on scrubbed inputs only
        cli-agent --tool git --inspect-io --inspect-io-raw "Summarize the last 3 commits"
    </info>
    <agentToolsPack>
        ## Agent-tools pack (curated subset, vendored from `BikS2013/agent-tools` + first-party file & web)

        ### Purpose

        cli-agent ships a curated 6-tool subset of the upstream
        [`BikS2013/agent-tools`](https://github.com/BikS2013/agent-tools) library,
        registered alongside the standard `bash_*` toolkit, PLUS seven
        **first-party** tools: five file tools (`agt_file_read`, `agt_file_list`,
        `agt_file_write`, `agt_file_edit`, `agt_file_append`) and two web tools
        (`agt_web_search`, `agt_web_fetch`).
        The 4 default-on vendored tools (`agt_glob`, `agt_grep`, `agt_multiedit`,
        `agt_patch`) provide filesystem search and content-mutation primitives;
        the 2 default-off tools (`agt_todo_read`, `agt_todo_write`) maintain a
        per-session in-memory todo list.

        `agt_file_*` and `agt_web_*` are the ONLY first-party (non-vendored)
        members of the `agt_` namespace. They were moved out of the built-in
        cross-cutting toolkit and re-homed here, REUSING the existing cli-agent
        first-party logic — no upstream read/write/edit/list/web tools are
        vendored and no new runtime dependency is added.

        The five `agt_file_*` tools (plan-012) REUSE the existing file sandbox
        (`src/agent/tools/file/sandbox.ts`). `agt_file_read` / `agt_file_list`
        are read-only and default ON; `agt_file_write` / `agt_file_edit` /
        `agt_file_append` default ON but are MUTATION-GATED — they register only
        when the per-tool flag is on AND `--allow-mutations` is in effect
        (mirroring `agt_multiedit` / `agt_patch` and the former native file-tool
        gating, so today's effective behavior is preserved exactly: read+list
        load by default, the three mutators load only with `--allow-mutations`).
        After this change the built-in toolkit contains ONLY `bash_run`,
        `bash_list_allowed`, `bash_which`, and `tool_help`. Because the file
        tools ride the agent-tools pack, they are independent of the built-in
        toolkit: they load in every mode except `chat`, and individual tools
        are switched off with `--disable-tool agt_file_*` (or the per-tool
        env/config keys).

        `agt_web_search` / `agt_web_fetch` (plan-011) REUSE the existing
        cli-agent web backend (`src/agent/tools/web/backends/`). Both are
        read-only and default ON. Because they ride the agent-tools pack, they
        too are independent of the built-in toolkit and load in every mode
        except `chat`; switch them off with `--disable-tool agt_web_search` /
        `--disable-tool agt_web_fetch` (or the per-tool env/config keys). They
        share a single per-session request budget (`WEB_SEARCH_MAX_REQUESTS`,
        default 50).

        Whether the pack loads AT ALL is decided by the mode knob: the pack is
        present in `basic`, `tool`, and `composite` modes and absent in `chat`
        (there is no umbrella flag or `agentTools.enabled` config key anymore —
        plan-015 removed them; presence of the pack = mode ≥ basic).

        Each wrapped tool routes all security-sensitive operations through
        `cliAgentPermissionPolicy(cfg)` — the bridge factory in
        `src/agent/tools/agent-tools/permissions.ts` that delegates
        `evaluateBash` to cli-agent's bash allowlist (UNRESTRICTED — allow all
        — when the allowlist is unconfigured, since 2026-07-04; restrictive
        once any entry exists) and `evaluateFsWrite` to cli-agent's sandbox +
        mutation gate (denied unless `--allow-mutations` is on AND the path
        resolves under `fileEdit.root` / `fileEdit.allowPaths`). The upstream
        interface has no read gate; reads are jailed by `ToolContext.cwd`.
        Credential stripping is provided by the standalone `scrubEnv(cfg, env)`
        helper exported from the same module (it is NOT a `PermissionPolicy`
        method — the upstream interface does not declare one). The policy
        object is constructed once per session and shared across every bundled
        wrapper.

        ### Tools

        | Tool name        | Default                                    | Mutating? | Purpose (1 line) |
        |------------------|--------------------------------------------|-----------|------------------|
        | `agt_glob`       | on                                         | no        | filesystem glob matching (uses `fast-glob`) |
        | `agt_grep`       | on                                         | no        | regex content search (`@vscode/ripgrep` if available, JS fallback otherwise) |
        | `agt_multiedit`  | on (gated by `--allow-mutations`)          | yes       | atomic multi-edit on a single file |
        | `agt_patch`      | on (gated by `--allow-mutations`)          | yes       | apply unified-diff / opencode-style patch envelope |
        | `agt_todo_read`  | off                                        | no        | read session-scoped in-memory todo list |
        | `agt_todo_write` | off                                        | no        | write session-scoped in-memory todo list (NOT host-mutating; not gated) |
        | `agt_file_read`  | on                                         | no        | first-party file read within the sandbox (reuses the cli-agent file sandbox) |
        | `agt_file_list`  | on                                         | no        | first-party directory listing within the sandbox (reuses the cli-agent file sandbox) |
        | `agt_file_write` | on (gated by `--allow-mutations`)          | yes       | first-party file write within the sandbox (reuses the cli-agent file sandbox) |
        | `agt_file_edit`  | on (gated by `--allow-mutations`)          | yes       | first-party in-place file edit within the sandbox (reuses the cli-agent file sandbox) |
        | `agt_file_append`| on (gated by `--allow-mutations`)          | yes       | first-party file append within the sandbox (reuses the cli-agent file sandbox) |
        | `agt_web_search` | on                                         | no        | first-party web search (reuses the cli-agent web backend) |
        | `agt_web_fetch`  | on                                         | no        | first-party URL fetch → readable text (reuses the cli-agent web backend) |

        ### Per-tool CLI flags — the generic `--enable-tool` / `--disable-tool` pair

        A single repeatable flag pair covers every tool in the pack, keyed by
        the canonical registered tool name (underscores, exactly as the tool
        appears in the catalog):

        ```
        --enable-tool <name>     # repeatable; e.g. --enable-tool agt_todo_write
        --disable-tool <name>    # repeatable; e.g. --disable-tool agt_grep
        ```

        Valid names (all 13): `agt_glob`, `agt_grep`, `agt_multiedit`,
        `agt_patch`, `agt_todo_read`, `agt_todo_write`, `agt_web_search`,
        `agt_web_fetch`, `agt_file_read`, `agt_file_list`, `agt_file_write`,
        `agt_file_edit`, `agt_file_append`.

        - An UNKNOWN name raises `UsageError` (exit 2) whose message lists all
          13 valid names.
        - Naming the SAME tool in both `--enable-tool` and `--disable-tool`
          raises `UsageError` (exit 2). Precedence is **fail-fast**, not
          silent winner-take-all. (Duplicates within one flag are harmless.)
        - The flags operate WITHIN the pack: they cannot resurrect the pack
          when the effective mode is `chat` (no umbrella flag exists anymore —
          pack presence is decided solely by the mode).
        - Mutation gating is unchanged: `agt_file_write` / `agt_file_edit` /
          `agt_file_append`, `agt_multiedit`, and `agt_patch` still
          additionally require `--allow-mutations` even when explicitly
          enabled.

        ### Per-tool env vars

        | Env var                                | Effect                                                |
        |----------------------------------------|-------------------------------------------------------|
        | `CLI_AGENT_AGT_GLOB=true|false`        | per-tool override for `agt_glob`                      |
        | `CLI_AGENT_AGT_GREP=true|false`        | per-tool override for `agt_grep`                      |
        | `CLI_AGENT_AGT_MULTIEDIT=true|false`   | per-tool override for `agt_multiedit`                 |
        | `CLI_AGENT_AGT_PATCH=true|false`       | per-tool override for `agt_patch`                     |
        | `CLI_AGENT_AGT_TODO_READ=true|false`   | per-tool override for `agt_todo_read`                 |
        | `CLI_AGENT_AGT_TODO_WRITE=true|false`  | per-tool override for `agt_todo_write`                |
        | `CLI_AGENT_AGT_FILE_READ=true|false`   | per-tool override for `agt_file_read`                 |
        | `CLI_AGENT_AGT_FILE_LIST=true|false`   | per-tool override for `agt_file_list`                 |
        | `CLI_AGENT_AGT_FILE_WRITE=true|false`  | per-tool override for `agt_file_write`                |
        | `CLI_AGENT_AGT_FILE_EDIT=true|false`   | per-tool override for `agt_file_edit`                 |
        | `CLI_AGENT_AGT_FILE_APPEND=true|false` | per-tool override for `agt_file_append`               |
        | `CLI_AGENT_AGT_WEB_SEARCH=true|false`  | per-tool override for `agt_web_search`                |
        | `CLI_AGENT_AGT_WEB_FETCH=true|false`   | per-tool override for `agt_web_fetch`                 |

        Each per-tool env var is parsed as a tri-state: `1` / `true` enable,
        `0` / `false` disable, missing → defer to the next tier.

        ### config.json shape

        Persisted defaults live in
        `~/.tool-agents/cli-agent/config.json` under the `agentTools` key:

        ```json
        {
          "agentTools": {
            "tools": {
              "glob": true,
              "grep": true,
              "multiedit": true,
              "patch": true,
              "todoRead": false,
              "todoWrite": false,
              "fileRead": true,
              "fileList": true,
              "fileWrite": true,
              "fileEdit": true,
              "fileAppend": true,
              "webSearch": true,
              "webFetch": true
            }
          }
        }
        ```

        Every field is optional. Defaults shown above are applied AFTER all
        precedence tiers have been consulted; they are explicit starting values,
        NOT runtime fallbacks for missing required config (per project
        convention). The legacy `agentTools.enabled` key was removed in
        plan-015 — its presence in config.json raises `ConfigurationError`
        with a migration hint (the `tools` sub-tree stays valid).

        ### Precedence (per-tool)

        Mirrors cli-agent's standard four-tier resolution chain:

        ```
        CLI flag (--enable-tool <name> / --disable-tool <name>)
          > shell env var (CLI_AGENT_AGT_*)
          > ~/.tool-agents/cli-agent/.env
          > local ./.env
          > config.json (agentTools.tools.*)
          > default
        ```

        This chain decides each tool WITHIN the pack. Whether the pack loads
        at all is decided upstream by the mode knob (`--mode` /
        `CLI_AGENT_MODE` / profile `cliParams.mode` / config.json `mode`):
        present in every mode except `chat`. See "Agent mode (tool-group
        loading)" below.

        ### Mutation gating

        `agt_file_write`, `agt_file_edit`, `agt_file_append`, `agt_multiedit`,
        and `agt_patch` are excluded from the LLM-visible catalog when
        `--allow-mutations` is off, regardless of per-tool flags or the
        effective mode (FR-AGT-010 / FR-AGT-FILE-001). The three `agt_file_*` mutators
        inherit the exact gating semantics of the former native `file_write` /
        `file_edit` / `file_append` tools, so the effective default behavior is
        unchanged: `agt_file_read` / `agt_file_list` load by default, the three
        mutators load only with `--allow-mutations`.

        ### Provenance

        The pack is vendored — not installed from npm — under
        `src/agent/tools/agent-tools-vendored/`, pinned at upstream SHA
        `b8ab63b2f4124325a31e00c9afd3645f02ffd072` (`BikS2013/agent-tools`,
        MIT-licensed). Re-sync via `bash scripts/sync-agent-tools.sh
        --sha <new-sha>`; provenance, sync date, and the file allow-list are
        recorded in `src/agent/tools/agent-tools-vendored/PROVENANCE.md`.
    </agentToolsPack>
    <toolLoadingToggles>
        ## Agent mode (tool-group loading)

        cli-agent groups its tools into three families — the built-in
        cross-cutting toolkit (`bash_*`, `tool_help`), the agent-tools pack
        (`agt_*`), and the composites (virtual tools) — and a SINGLE knob
        decides which of them load for a session: the agent mode
        (`--mode <chat|basic|tool|composite>`, plan-015). `--allow-mutations`
        remains the orthogonal read-only/read-write axis, and the repeatable
        `--enable-tool` / `--disable-tool` pair adjusts individual `agt_*`
        tools WITHIN the pack (see the agent-tools pack section above).

        ### Mode → group mapping

        | Mode | Built-in toolkit (`bash_*`, `tool_help`) | Agent-tools pack (`agt_*`) | Composites |
        |---|---|---|---|
        | `chat` | — | — | — |
        | `basic` | — | loaded | — |
        | `tool` | loaded | loaded | — |
        | `composite` (default) | loaded | loaded | loaded |

        `composite` is the default: a flagless invocation loads all three
        groups, identical in behavior to the pre-mode binary. Group members:
        built-in toolkit = `bash_list_allowed` / `bash_which` / `bash_run` +
        `tool_help` (web moved to the agt_* pack — plan-011; file tools —
        plan-012); agent-tools pack = the 13 `agt_*` tools; composites = every
        virtual/composite tool registered under
        `~/.tool-agents/cli-agent/composites/` (loaded by
        `loadVirtualToolsSync`).

        ### Precedence (pinnable-knob chain)

        The mode resolves exactly like the other pinnable knobs (provider,
        model, allowMutations) — note the profile sits ABOVE config.json,
        unlike the retired group-toggle chain:

        ```
        CLI --mode
          > env CLI_AGENT_MODE  (layered tier: shell env > ~/.tool-agents/cli-agent/.env > local ./.env)
          > profile cliParams.mode
          > config.json "mode"
          > default: composite
        ```

        The `composite` default is a documented optional-knob starting value,
        NOT a runtime fallback for missing required config. `profile-dry-run`
        reports a `mode` row with source attribution like every other knob.

        ### Invalid values — fail fast, no fallback

        - CLI tier (`--mode bogus`) → `UsageError`, exit 2, listing the four
          valid values.
        - Env tier (`CLI_AGENT_MODE`) or config.json tier (`mode`) →
          `ConfigurationError`, exit 3, naming the surface — never a silent
          downgrade to `composite`.
        - Profile tier (`cliParams.mode`) is schema-validated (Zod enum), so
          an invalid value fails profile parsing.

        ### chat/basic modes remove `bash_run` — wrapped-CLI conflict

        The built-in toolkit includes `bash_run`, the path the agent uses to
        execute the *wrapped* CLIs declared via `--tool` (or config.json
        `tools`). `chat` and `basic` do not load the built-in toolkit, so a
        wrapped CLI combined with an effective mode of `chat` or `basic`
        raises `UsageError` (exit 2) directing you to `--mode tool` or
        `--mode composite`. The check applies to the EFFECTIVE mode from ANY
        surface (flag, env, profile, config.json) and to the MERGED
        wrapped-tools list (config.json `tools` included).

        In `chat` and `basic` modes the built-in tool INSTRUCTIONS are removed
        from the system prompt too — the entire `## Built-in tools` block (the
        `bash_run` framing, CORE RULES, OUT-OF-SCOPE, and the available-tools
        list) is gated on mode ≥ `tool`, so the model is not told about tools
        it cannot call. When the block IS present, its content further adapts
        to the actually-registered built-in tools: the `bash_run` framing
        appears only with a non-empty allowlist (see "Slim base +
        runtime-injected built-in-tools block" under "System Prompt
        Selection"). The slim default base prompt carries no tool prose of its
        own, so `chat`/`basic` yield a prompt with no built-in tool
        instructions. Caveat: a CUSTOMIZED base that still hard-codes tool
        prose owns that prose — the mode cannot strip it from your custom text.

        ### `--mode chat` — the empty-toolset state (no error)

        `--mode chat` with no wrapped CLI is the supported empty-toolset
        state: the catalog is empty and the agent degrades to a plain
        conversational LLM with no tools. It is NOT an error and does NOT
        throw. cli-agent emits ONE stderr notice at catalog-build time:

        ```
        [cli-agent] note: no tools are loaded for this session (all tool groups disabled); the agent will run as a plain conversational LLM with no tools.
        ```

        The no-tools system-prompt notice likewise tells the model to direct
        the user at `--mode composite` or `--mode tool` (plus
        `--allow-mutations` or a bash allowlist where needed) to enable tools.
        (This is distinct from profile tool-scoping's empty-survivor error,
        which still applies when an `allow`/`deny` list excludes everything.)

        ### The TUI `/mode` command

        In the raw-mode TUI, `/mode [chat|basic|tool|composite]` mirrors
        `/allow-mutations`:

        - `/mode` with no argument reports the current mode and usage.
        - A valid argument switches the mode and rebuilds the LLM binding,
          tool catalog, system prompt, and agent graph in place — the next
          user prompt runs with the new toolset.
        - An invalid value prints an error; no state change.
        - Switching to `chat`/`basic` while wrapped CLIs are loaded is
          rejected with no state change (they run through `bash_run`, absent
          in those modes) — use `/mode tool` / `/mode composite`, or restart
          without `--tool`.
        - `/mode` is session-scoped: nothing is persisted to config.json or a
          profile. `/allow-mutations` is orthogonal and unchanged.

        ### Interaction with profile `tools.allow` / `tools.deny` / `tools.order`

        The mode runs FIRST (it decides which families are even built).
        Profile `tools.allow/deny/order` scoping runs AFTER, on whatever
        survived the mode — so per-id allow/deny continues to operate exactly
        as before on the remaining tools.

        ### config.json / profile shape

        ```json
        { "mode": "tool" }
        ```

        ```yaml
        cliParams:
          mode: tool        # chat | basic | tool | composite
        ```

        The key is optional on every surface; omitted values defer down the
        chain and ultimately to the default (`composite`).

        ### Migration from the removed toggles (plan-015)

        Plan-015 HARD-REMOVED the previous group-toggle surface — the three
        flag pairs, the 26 per-tool `--enable-agt-*`/`--disable-agt-*` flags
        (32 flags total), and the matching env vars / config.json keys /
        profile keys. Nothing legacy is silently ignored — every removed
        surface fails fast with a migration hint:

        | Removed surface | Behavior now | Replacement |
        |---|---|---|
        | Flags `--composites`/`--no-composites`, `--builtin-tools`/`--no-builtin-tools`, `--agent-tools`/`--no-agent-tools` | `UsageError`, exit 2, migration hint (argv pre-scan in `src/cli-removed-flags.ts`, before Commander parses) | `--mode <chat\|basic\|tool\|composite>` |
        | The 26 per-tool flags `--enable-agt-<tool>` / `--disable-agt-<tool>` | `UsageError`, exit 2, migration hint | `--enable-tool <name>` / `--disable-tool <name>` with the canonical `agt_*` name |
        | Env vars `CLI_AGENT_DISABLE_COMPOSITES` / `CLI_AGENT_DISABLE_BUILTIN_TOOLS` / `CLI_AGENT_DISABLE_AGENT_TOOLS` | a SET value — ANY value — raises `ConfigurationError` (exit 3) with the hint | `CLI_AGENT_MODE` |
        | config.json keys `composites`, `builtinTools`, `agentTools.enabled` | presence raises `ConfigurationError` with the hint (`agentTools.tools.*` stays valid) | config.json `mode` |
        | Profile keys `tools.composites` / `tools.builtin` / `tools.agentTools` | presence raises `ConfigurationError` from the profile codec, pointing at `cliParams.mode` | profile `cliParams.mode` |

        Posture equivalents:

        | Old posture | New invocation |
        |---|---|
        | flagless (all three groups) | flagless, or `--mode composite` |
        | `--no-composites` (builtin + agt_*) | `--mode tool` |
        | `--no-builtin-tools --no-composites` (agt_* only) | `--mode basic` |
        | all three groups off (empty toolset) | `--mode chat` |
        | `--disable-agt-grep` (per-tool off) | `--disable-tool agt_grep` |
        | "shell-only" (builtin ON, agt_* OFF) | no group-level equivalent anymore (accepted plan-015 consequence). Nearest: `--mode tool` plus one `--disable-tool agt_<name>` per pack tool (all 13 names), or persist `agentTools.tools.*: false` entries in config.json. |

        Group combinations outside the four modes (e.g. composites without the
        built-in toolkit) are intentionally no longer expressible at the group
        level; use per-tool disables within the pack where a finer posture is
        needed. The old group-toggle precedence chain (config.json above
        profile) is gone with the keys themselves — the mode is a pinnable
        knob, so the profile now sits ABOVE config.json.
    </toolLoadingToggles>
</cliAgent>
