<cliAgent>
    <objective>
        Generic LangGraph ReAct agent that wraps one or more external CLI tools (passed at
        launch via repeatable --tool=&lt;name&gt; flags or via a `tools` array in
        ~/.tool-agents/cli-agent/config.json). Each declared tool is auto-added to the
        bash_run allowlist. At first launch the agent recursively introspects each tool's
        --help (depth-limited, byte-budgeted, time-budgeted) and stores the resulting
        Markdown capability document under ~/.tool-agents/cli-agent/capabilities/&lt;tool&gt;.md;
        the compiled capabilities document is embedded in the system prompt so the LLM
        knows the exact subcommand surface of every wrapped CLI. Ships with the full
        standardized cross-cutting toolkit (file_*, web_*, bash_*) and the eight standard
        LLM providers; default provider seeded into config.json is azure-openai.
    </objective>
    <command>
        cli-agent [prompt]
          [-i | --interactive]
          [--tool &lt;name&gt;]                 # repeatable; CLI binary to add to bash allowlist
          [-p | --provider &lt;name&gt;]
          [-m | --model &lt;id&gt;]
          [--base-url &lt;url&gt;]
          [--config &lt;path&gt;]
          [--env-file &lt;path&gt;]
          [--max-steps &lt;n&gt;]
          [--temperature &lt;t&gt;]
          [--system &lt;text&gt; | --system-file &lt;path&gt;]
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
          [--verbose]

        cli-agent show-capabilities --tool &lt;name&gt;
        cli-agent refresh-capabilities [--tool &lt;name&gt;]
    </command>
    <info>
        ## Overview

        cli-agent is a LangGraph ReAct agent that dynamically wraps any set of external
        CLI binaries. At startup it introspects each wrapped tool's --help tree
        (configurable depth, byte budget, and timeout), compiles a Markdown capability
        document per tool, and embeds those documents in the system prompt so that the
        underlying LLM can generate correct, subcommand-aware invocations.

        The agent ships with a full cross-cutting toolkit:
          - bash_*  — execute shell commands against the declared allowlist
          - file_*  — read, write, and edit files within the allowed root
          - web_*   — web search and fetch using the configured backend

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
            /last | /raw            Re-render the last assistant reply
            /copy                   Copy the last assistant reply to the system clipboard
            /memory                 Diagnostic view of MemorySaver state for the active thread

        Runtime switching
            /model [&lt;id&gt;]           Show or swap the active LLM model id (graph rebuilt in place)
            /provider [&lt;name&gt;]      Show or swap the active provider (one of the 8 standard names)
            /tools &lt;add|remove|list&gt; [name] [--save]
                                    Manage the wrapped-CLI tool list; --save persists to config.json
            /allow-mutations on|off Toggle mutating file_* tools and rebuild the catalog

        Capability inspection
            /capabilities           Per-tool freshness column (✓ fresh / ⚠ stale / ✗ missing)
            /refresh-capabilities [&lt;tool&gt;] | /refresh-caps
                                    Re-run capability discovery (single tool or all configured).
                                    Always performs the complete investigation including the
                                    LLM extractor, bypassing the skipLlmBelowBytes fast path.
            /tool-help &lt;tool&gt; [&lt;sub&gt;] | /help-tool
                                    TUI twin of the runtime tool_help LLM tool

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
        Ctrl+C                      During input: clear buffer; during a turn: abort the LLM call
        ESC                         During a turn: abort the LLM call via AbortController
        Ctrl+D                      On empty input: exit the TUI

        ### Persistent history layout

        Per-thread JSONL files plus an index live under the per-user config folder:

        ~/.tool-agents/cli-agent/history/      (mode 0700)
            thread-&lt;UTC-iso&gt;-&lt;threadId&gt;.jsonl  (mode 0600 — one line per turn)
            index.jsonl                         (mode 0600 — one line per thread; atomic)
            cursor.json                         (mode 0600 — last active threadId + ts)

        Per-turn JSONL records the user prompt and the assistant final text only —
        chunk-level fragments stay in `~/.tool-agents/cli-agent/logs/`.

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

        ## CLI Parameters

        --tool &lt;name&gt;
            (Repeatable) Name of an external CLI binary to wrap. Each named binary is
            added to the bash_run allowlist and introspected on first launch.

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

        --system &lt;text&gt;
            Append extra text to the system prompt (inline form).

        --system-file &lt;path&gt;
            Append the contents of a file to the system prompt.

        --per-tool-budget &lt;bytes&gt;
            Override capabilities.maxBytesPerTool for this invocation.

        --allow-mutations
            Unlock file_write, file_edit, and any bash command that produces side
            effects. Without this flag the agent operates in read-only mode.

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
            Each entry is auto-added to the bash allowlist at startup.

        bash.allow
            Additional bash allowlist entries (binary names or `argv-regex:&lt;pattern&gt;`
            rules) following the cli-agent-builder spec.

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
            Working root for file_* tools; defaults to process.cwd() at agent launch.

        fileEdit.allowPaths
            Optional explicit allowlist of paths outside the root that file_* tools
            may also access.

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
            Per-session hard cap for web_search/web_fetch calls (default 50).

        CLI_AGENT_LOG
            Set to off|0|false|no to disable structured JSONL logging (default on).

        FILE_EDIT_ROOT
            Override the file_* tools' working root (env form of fileEdit.root).

        ## Examples

        # One-shot: use gh CLI to list open PRs
        cli-agent --tool gh "List all open pull requests in the current repo"

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
    </info>
</cliAgent>
