/**
 * Typed error hierarchy for cli-agent.
 *
 * Exit-code mapping (reused by src/cli.ts):
 *   0   Success
 *   1   Unexpected / unknown error
 *   2   Usage error (bad flag, missing prompt, missing required tool)
 *   3   Configuration error (missing required env var / config value)
 *   4   Auth error
 *   5   Upstream / provider SDK error
 *   6   IO error
 *   130 SIGINT during interactive session
 */

export type ErrorCode =
  // Configuration
  | 'E_CONFIG_MISSING'
  | 'E_CONFIG_SCHEMA_VERSION'
  | 'E_PROVIDER_NOT_SUPPORTED'
  | 'E_PROVIDER_UPSTREAM_UNREACHABLE'
  // Usage
  | 'E_USAGE'
  // Auth
  | 'E_AUTH'
  // IO / file tools
  | 'E_FILE_NOT_FOUND'
  | 'E_FILE_TOO_LARGE'
  | 'E_FILE_PATH_OUTSIDE_ROOT'
  | 'E_FILE_EDIT_NO_MATCH'
  | 'E_FILE_EDIT_AMBIGUOUS_MATCH'
  | 'E_FILE_PERMISSION'
  // Bash tools
  | 'E_BASH_COMMAND_NOT_ALLOWED'
  | 'E_BASH_BINARY_NOT_FOUND'
  | 'E_BASH_TIMEOUT'
  | 'E_BASH_KILLED'
  | 'E_BASH_CWD_OUTSIDE_ROOT'
  | 'E_BASH_NONZERO_EXIT'
  // Web tools
  | 'E_SEARCH_API_KEY_MISSING'
  | 'E_SEARCH_RATE_LIMITED'
  | 'E_SEARCH_TIMEOUT'
  | 'E_SEARCH_BUDGET_EXCEEDED'
  | 'E_FETCH_HTTP'
  | 'E_FETCH_TIMEOUT'
  | 'E_FETCH_TOO_LARGE'
  | 'E_FETCH_BLOCKED_BY_ROBOTS'
  // Capability discovery
  | 'E_CAPABILITY_BINARY_NOT_FOUND'
  | 'E_CAPABILITY_TIMEOUT'
  | 'E_CAPABILITY_EXTRACTOR_FAILED'
  | 'E_CAPABILITY_CACHE_SCHEMA_VERSION'
  | 'E_CAPABILITY_NOT_FOUND'
  // Agent runtime
  | 'E_AGENT_RUNTIME'
  | 'E_AGENT_TOOL_VALIDATION'
  | 'E_AGENT_CONFIRMATION_REQUIRED';

export class CliAgentError extends Error {
  public readonly code: ErrorCode;
  public readonly details: Readonly<Record<string, unknown>>;
  public readonly exitCode: number;

  public constructor(
    code: ErrorCode,
    message: string,
    exitCode: number,
    details?: Record<string, unknown>,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = new.target.name;
    this.code = code;
    this.exitCode = exitCode;
    this.details = Object.freeze({ ...(details ?? {}) });
    Object.setPrototypeOf(this, new.target.prototype);
  }

  public toJSON(): { code: ErrorCode; message: string; details: Record<string, unknown> } {
    return { code: this.code, message: this.message, details: { ...this.details } };
  }
}

export class ConfigurationError extends CliAgentError {
  public constructor(
    missingSetting: string,
    checkedSources: string[],
    details?: Record<string, unknown>,
  ) {
    super(
      'E_CONFIG_MISSING',
      `Required configuration '${missingSetting}' is not set. Checked: ${checkedSources.join(', ')}.`,
      3,
      { missingSetting, checkedSources, ...details },
    );
  }
}

export class UsageError extends CliAgentError {
  public constructor(message: string, details?: Record<string, unknown>) {
    super('E_USAGE', message, 2, details);
  }
}

export class AuthError extends CliAgentError {
  public constructor(message: string, details?: Record<string, unknown>) {
    super('E_AUTH', message, 4, details);
  }
}

export class UpstreamError extends CliAgentError {
  public constructor(message: string, details?: Record<string, unknown>) {
    super('E_PROVIDER_UPSTREAM_UNREACHABLE', message, 5, details);
  }
}

export class ProviderNotSupportedError extends CliAgentError {
  public constructor(provider: string) {
    super(
      'E_PROVIDER_NOT_SUPPORTED',
      `Provider '${provider}' is not supported. Valid providers: openai, anthropic, gemini, azure-openai, azure-anthropic, ollama, litellm, mlx.`,
      2,
      { provider },
    );
  }
}

export class FileError extends CliAgentError {
  public constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, 6, details);
  }
}

export class BashError extends CliAgentError {
  public constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, 1, details);
  }
}

export class WebError extends CliAgentError {
  public constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, 1, details);
  }
}

export class CapabilityError extends CliAgentError {
  public constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, 1, details);
  }
}

export class AgentRuntimeError extends CliAgentError {
  public constructor(message: string, details?: Record<string, unknown>) {
    super('E_AGENT_RUNTIME', message, 1, details);
  }
}

/** Routes tool errors — returns string for recoverable, rethrows for fatal. */
export function handleToolError(err: unknown): string {
  if (err instanceof ConfigurationError) throw err;
  if (err instanceof AuthError) throw err;

  if (err instanceof CliAgentError) {
    return JSON.stringify({
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
  }

  if (err instanceof Error) {
    return JSON.stringify({
      error: {
        code: 'E_AGENT_RUNTIME',
        message: err.message,
      },
    });
  }

  throw err;
}
