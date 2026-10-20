import type { AgentAdapter, AgentExecution, AgentResult } from "../core/contracts.js";

/** Gerçek model çağrısı yapmadan ajan yürütmesini sınamak için. */
export class MockAgent implements AgentAdapter {
  readonly provider = "mock";
  readonly connection = "mock" as const;
  readonly liveMessages = true;

  constructor(
    readonly id: string,
    private readonly work: (input: AgentExecution) => AgentResult | Promise<AgentResult>,
  ) {}

  async execute(input: AgentExecution): Promise<AgentResult> {
    input.acknowledgeInbox?.();
    return this.work(input);
  }
}
