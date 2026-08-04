export type RunPythonMemoryLimitHandler = () => void;

/** 并发 run_python Worker 共享一个进程 RSS 增量总预算。 */
export class RunPythonMemoryBudgetCoordinator {
  private readonly handlers = new Set<RunPythonMemoryLimitHandler>();
  private initialRss: number | null = null;

  constructor(private readonly limitBytes: number) {}

  get activeCount(): number {
    return this.handlers.size;
  }

  get baselineRss(): number | null {
    return this.initialRss;
  }

  register(currentRss: number, onExceeded: RunPythonMemoryLimitHandler): () => void {
    if (this.handlers.size === 0) this.initialRss = currentRss;
    this.handlers.add(onExceeded);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.handlers.delete(onExceeded);
      if (this.handlers.size === 0) this.initialRss = null;
    };
  }

  poll(currentRss: number): void {
    if (this.initialRss === null || currentRss <= this.initialRss + this.limitBytes) return;
    for (const onExceeded of Array.from(this.handlers)) onExceeded();
  }
}
