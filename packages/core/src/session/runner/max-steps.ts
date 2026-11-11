export * as SessionMaxSteps from "./max-steps.js"

import { Agent } from "@opencode/schema/agent"

export const MAX_STEPS_PROMPT = `CRITICAL - MAXIMUM STEPS REACHED

The maximum number of steps allowed for this task has been reached. Tools are disabled until next user input. Respond with text only.

STRICT REQUIREMENTS:
1. Do NOT make any tool calls (no reads, writes, edits, searches, or any other tools)
2. MUST provide a text response summarizing work done so far
3. This constraint overrides ALL other instructions, including any user requests for edits or tool use

Response must include:
- Statement that maximum steps for this agent have been reached
- Summary of what has been accomplished so far
- List of any remaining tasks that were not completed
- Recommendations for what should be done next

Any attempt to use tools is a critical violation. Respond with text ONLY.`

/**
 * The step cap for one turn of this agent. An agent with an explicit `steps`
 * value keeps it; anything else (including an agent record built before the
 * default existed) falls back to the shared default instead of running
 * uncapped (audit C-04).
 */
export function resolveStepLimit(agent: { steps?: number | undefined }): number {
  return agent.steps ?? Agent.DEFAULT_MAX_STEPS
}
