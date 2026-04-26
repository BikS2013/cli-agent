/**
 * Use the active LLM to extract subcommand names from raw --help text.
 * Falls back gracefully if the LLM call fails.
 */

import { z } from 'zod';
import type { BaseChatModel } from '../providers/types.js';

export interface SubcommandInfo {
  name: string;
  oneLineSynopsis: string;
}

const MAX_HELP_INPUT_BYTES = 8192;

export async function extractSubcommands(
  helpText: string,
  model: BaseChatModel,
): Promise<SubcommandInfo[]> {
  // Cap input
  const input = helpText.length > MAX_HELP_INPUT_BYTES
    ? helpText.slice(0, MAX_HELP_INPUT_BYTES) + '\n…[TRUNCATED]'
    : helpText;

  const prompt = `You are a parser. Given the --help output of a CLI tool, extract the list of subcommands.
Return ONLY a JSON object with this shape: {"subcommands": [{"name": "string", "oneLineSynopsis": "string"}]}
If there are no subcommands, return {"subcommands": []}.
Do not include flags or options — only subcommands.

Help text:
${input}`;

  try {
    const response = await model.invoke([{ role: 'user', content: prompt }]);
    const text = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);

    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*"subcommands"[\s\S]*\}/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]) as { subcommands?: unknown[] };
    const schema = z.object({
      subcommands: z.array(z.object({
        name: z.string(),
        oneLineSynopsis: z.string(),
      })),
    });
    const validated = schema.parse(parsed);
    return validated.subcommands;
  } catch {
    // Fallback: no subcommands extracted
    return [];
  }
}
