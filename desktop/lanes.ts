import type { CSSProperties } from "react";
import type { DesktopState } from "../src/desktop/contracts.js";

/** Number of distinct lane colours defined in style.css (--lane-1 … --lane-6). */
const LANES = 6;

/**
 * Every agent owns one line on the map, coloured by its position in the project's agent list.
 * The same colour marks its tasks in the rail, the task header and the activity feed.
 */
export function laneIndex(state: DesktopState, agentId: string | undefined): number {
  const index = state.agents.findIndex((agent) => agent.id === agentId);
  return index < 0 ? 0 : (index % LANES) + 1;
}

/** Inline style that sets --lane for an element and its children; lane 0 is the neutral line. */
export function laneStyle(state: DesktopState, agentId: string | undefined): CSSProperties {
  const index = laneIndex(state, agentId);
  return { "--lane": index ? `var(--lane-${index})` : "var(--line-strong)" } as CSSProperties;
}

/** Lane of the agent that owns a task, for events that only carry a task id. */
export function taskLaneStyle(state: DesktopState, taskId: string | undefined): CSSProperties {
  return laneStyle(state, state.snapshot.tasks.find((task) => task.id === taskId)?.agentId);
}
