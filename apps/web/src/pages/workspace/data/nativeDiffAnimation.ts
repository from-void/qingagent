import type { PmBlockNode, PmDoc, PmInlineNode } from "@qingagent/pm-schema";
import type { ViewBlock } from "./protocol";
import {
  MAX_NATIVE_AGENT_COUNT,
  MIN_NATIVE_AGENT_COUNT,
  MIN_STEP_DELAY_MS,
  getNativePresentationConfig,
  resolveNativeStepDelayMs,
  sanitizeNativePresentationConfig,
} from "./presentationRuntimeConfig";
import { laneColor } from "./humanCursorLanes";
import * as presentationSpans from "./presentationSpans";
import { sectionText, tableCellEntries, visibleReviewSections } from "./presentationSpans";
import { shouldTypewriteTable } from "./tableTypewriter";

export type NativePresentationMode = "diff" | "whole";

export type NativePresentationTarget = {
  kind: "tableCell";
  rowIndex: number;
  cellIndex: number;
  textBlockIndex: number;
};

export interface NativePresentationRun {
  id: number;
  docVersion: number;
  sessionId: string | null;
  mode: NativePresentationMode;
  baselineDoc?: PmDoc;
  finalDoc?: PmDoc;
  baselineSections: ViewBlock[];
  finalSections: ViewBlock[];
}

export type NativeDiffInstruction =
  | {
      kind: "cursor";
      taskId: string;
      blockId?: string;
      pmAt?: number;
      blockIndex: number;
      at: number;
      tone: "blue" | "red";
      target?: NativePresentationTarget;
      label: string;
    }
  | {
      kind: "deleteText";
      taskId: string;
      blockId?: string;
      pmFrom?: number;
      pmTo?: number;
      blockIndex: number;
      from: number;
      to: number;
      text: string;
      target?: NativePresentationTarget;
    }
  | {
      kind: "insertText";
      taskId: string;
      blockId?: string;
      pmAt?: number;
      blockIndex: number;
      at: number;
      text: string;
      target?: NativePresentationTarget;
    }
  | {
      kind: "redDot";
      taskId: string;
      blockId?: string;
      pmAt?: number;
      blockIndex: number;
      at: number;
    }
  | {
      kind: "insertSection";
      blockId?: string;
      pmAt?: number;
      blockIndex: number;
      section: ViewBlock;
      label: string;
    };

export interface NativeTimingPlan {
  totalDurationMs: number;
  stepDelayMs: number;
  chunkSize: number;
}

export interface InstantPresentationOptions {
  reducedMotion: boolean;
  coordinateAvailable?: boolean;
  instructionCount: number;
}

const AGENT_LABELS = ["Agent·1", "Agent·2", "Agent·3", "Agent·4", "Agent·5", "Agent·6"] as const;

interface NativePmBlockRef {
  blockIndex: number;
  blockId: string;
  pmStart: number;
  pmEnd: number;
  text: string;
}

function pmNodeSize(node: PmDoc | PmBlockNode | PmInlineNode): number {
  if (node.type === "doc") {
    return node.content.reduce((sum, child) => sum + pmNodeSize(child), 0);
  }
  if (node.type === "text") return node.text.length;
  if (node.type === "hardBreak") return 1;
  if (!("content" in node) || !Array.isArray(node.content)) return 1;
  return 2 + node.content.reduce((sum, child) => sum + pmNodeSize(child as PmBlockNode | PmInlineNode), 0);
}

function pmInlineText(content: readonly PmInlineNode[] | undefined): string {
  return (content ?? [])
    .map((node) => {
      if (node.type === "hardBreak") return "\n";
      // inlineMath 原子节点在动画文本投影中按 1 个占位符处理(与 PM nodeSize 一致)。
      if (node.type === "inlineMath") return "￼";
      return node.text;
    })
    .join("");
}

function pmPresentationText(node: PmBlockNode): string {
  switch (node.type) {
    case "heading":
    case "paragraph":
    case "codeBlock":
    case "penNote":
      return pmInlineText(node.content);
    case "columnList":
      return node.content
        .flatMap((column) => column.content.map(pmPresentationText))
        .filter(Boolean)
        .join("\n");
    default:
      return "";
  }
}

function collectTopLevelPresentationBlocks(doc: PmDoc): NativePmBlockRef[] {
  const refs: NativePmBlockRef[] = [];
  let pmPos = 0;
  doc.content.forEach((block, blockIndex) => {
    const text = pmPresentationText(block);
    if (text.length > 0) {
      refs.push({
        blockIndex,
        blockId: block.attrs.blockId,
        pmStart: pmPos + 1,
        pmEnd: pmPos + 1 + text.length,
        text,
      });
    }
    pmPos += pmNodeSize(block);
  });
  return refs;
}

function pmBlockBySection(doc: PmDoc | undefined): Map<number, NativePmBlockRef> {
  return new Map((doc ? collectTopLevelPresentationBlocks(doc) : []).map((ref) => [ref.blockIndex, ref]));
}

export type NativeConcurrentPhase = "skeleton" | "content" | "diff" | "done";
export type NativeConcurrentCursorPhase = "idle" | "typing";

export type NativeConcurrentOperation =
  | {
      kind: "cursor";
      blockId?: string;
      pmAt?: number;
      blockIndex: number;
      at: number;
      tone: "blue" | "red";
      target?: NativePresentationTarget;
    }
  | {
      kind: "deleteText";
      blockId?: string;
      pmFrom?: number;
      pmTo?: number;
      blockIndex: number;
      from: number;
      to: number;
      text: string;
      target?: NativePresentationTarget;
    }
  | {
      kind: "insertText";
      blockId?: string;
      pmAt?: number;
      blockIndex: number;
      at: number;
      text: string;
      target?: NativePresentationTarget;
    }
  | {
      kind: "redDot";
      blockId?: string;
      pmAt?: number;
      blockIndex: number;
      at: number;
      target?: NativePresentationTarget;
    };

const nativeOperationGraphemeCache = new WeakMap<NativeConcurrentOperation, string[]>();

export interface NativeConcurrentTask {
  id: string;
  phase: Exclude<NativeConcurrentPhase, "done">;
  blockId?: string;
  blockIndex: number;
  operations: readonly NativeConcurrentOperation[];
}

export interface NativeConcurrentAgent {
  id: string;
  label: string;
  color: string;
  blockIndex: number | null;
  taskId: string | null;
  assignmentId: number;
  operationIndex: number;
  charIndex: number;
  cursorPhase: NativeConcurrentCursorPhase;
  startDelayTicks: number;
}

export interface NativeConcurrentState {
  runId: number;
  phase: NativeConcurrentPhase;
  agents: readonly NativeConcurrentAgent[];
  tasks: readonly NativeConcurrentTask[];
  pendingTaskIds: readonly string[];
  completedTaskIds: ReadonlySet<string>;
  tick: number;
  elapsedMs: number;
  maxDurationMs: number;
  stepDelayMs: number;
  stepAccumulatorMs: number;
  chunkSize: number;
  lastBatchSize: number;
  startJitter: boolean;
}

export interface CreateNativeConcurrentStateOptions {
  run: Pick<NativePresentationRun, "id" | "mode" | "baselineSections" | "finalDoc" | "finalSections">;
  instructions: readonly NativeDiffInstruction[];
  agentCount?: number;
  stepDelayMs?: number;
  chunkSize?: number;
  maxDurationMs?: number;
  // 是否启用各光标启动抖动错位(默认 true);测试可关掉走精确时序
  startJitter?: boolean;
}

export type NativeConcurrentStep =
  | {
      kind: "cursor";
      agentId: string;
      assignmentId: number;
      label: string;
      color: string;
      taskId: string;
      operationIndex: number;
      operationKey: string;
      blockId?: string;
      pmAt?: number;
      blockIndex: number;
      at: number;
      tone: "blue" | "red";
      operationLength: 0;
      operationComplete: true;
      target?: NativePresentationTarget;
    }
  | {
      kind: "deleteText";
      agentId: string;
      assignmentId: number;
      label: string;
      color: string;
      taskId: string;
      operationIndex: number;
      operationKey: string;
      blockId?: string;
      pmFrom?: number;
      pmTo?: number;
      blockIndex: number;
      chunkFrom: number;
      chunkTo: number;
      operationLength: number;
      operationComplete: boolean;
      target?: NativePresentationTarget;
    }
  | {
      kind: "insertText";
      agentId: string;
      assignmentId: number;
      label: string;
      color: string;
      taskId: string;
      operationIndex: number;
      operationKey: string;
      blockId?: string;
      pmAt?: number;
      blockIndex: number;
      at: number;
      chunkFrom: number;
      chunkTo: number;
      text: string;
      operationLength: number;
      operationComplete: boolean;
      target?: NativePresentationTarget;
    }
  | {
      kind: "redDot";
      agentId: string;
      assignmentId: number;
      label: string;
      color: string;
      taskId: string;
      operationIndex: number;
      operationKey: string;
      blockId?: string;
      pmAt?: number;
      blockIndex: number;
      at: number;
      operationLength: 0;
      operationComplete: true;
      target?: NativePresentationTarget;
    };

export interface NativeConcurrentAdvanceResult {
  state: NativeConcurrentState;
  steps: NativeConcurrentStep[];
}

export interface NativeConcurrentProgress {
  current: number;
  total: number;
  activeAgents: number;
}

export function buildNativeDiffInstructions(
  run: Pick<NativePresentationRun, "finalDoc" | "finalSections">,
): NativeDiffInstruction[] {
  return buildWholeDocumentInstructions(visibleReviewSections(run.finalSections), run.finalDoc);
}

export function planNativeTiming(
  instructions: readonly NativeDiffInstruction[],
  maxDurationMs?: number,
): NativeTimingPlan {
  const config = getNativePresentationConfig();
  const timingConfig = sanitizeNativePresentationConfig({
    ...config,
    maxDurationMs: maxDurationMs ?? config.maxDurationMs,
  });
  const stepDelayMs = resolveNativeStepDelayMs(timingConfig);
  const durationBudgetMs = timingConfig.maxDurationMs;
  const editableUnits = instructions.reduce((sum, instruction) => {
    if (instruction.kind === "insertText" || instruction.kind === "deleteText") {
      return sum + Math.max(1, presentationSpans.splitGraphemes(instruction.text).length);
    }
    if (instruction.kind === "insertSection") {
      if (instruction.section.kind === "table") {
        return sum + tableCellEntries(instruction.section).reduce(
          (cellSum, cell) => cellSum + presentationSpans.splitGraphemes(cell.text).length,
          0,
        );
      }
      return sum + Math.max(1, presentationSpans.splitGraphemes(sectionText(instruction.section)).length);
    }
    return sum + 1;
  }, 0);
  if (editableUnits === 0) {
    return {
      totalDurationMs: 0,
      stepDelayMs,
      chunkSize: timingConfig.chunkSize,
    };
  }
  const nominal = Math.ceil(editableUnits / timingConfig.chunkSize) * stepDelayMs;
  const budgetChunkSize =
    nominal <= durationBudgetMs
      ? timingConfig.chunkSize
      : Math.ceil((editableUnits * stepDelayMs) / durationBudgetMs);
  const chunkSize = Math.max(timingConfig.chunkSize, budgetChunkSize);
  const stepCount = Math.ceil(editableUnits / chunkSize);
  return {
    totalDurationMs: Math.min(durationBudgetMs, stepCount * stepDelayMs),
    stepDelayMs,
    chunkSize,
  };
}

export function shouldUseInstantNativePresentation({
  reducedMotion,
  coordinateAvailable = true,
  instructionCount,
}: InstantPresentationOptions): boolean {
  return reducedMotion || !coordinateAvailable || instructionCount === 0;
}

export function shouldForwardEditorUpdate({
  isApplyingRemote,
  isAnimating,
}: {
  isApplyingRemote: boolean;
  isAnimating: boolean;
}): boolean {
  return !isApplyingRemote && !isAnimating;
}

export function buildNativePresentationSeedSections(
  run: Pick<NativePresentationRun, "finalSections" | "finalDoc">,
): ViewBlock[] {
  return visibleReviewSections(run.finalSections).map((section, blockIndex) => {
    switch (section.kind) {
      case "h1":
        return { kind: "h1", text: "" };
      case "h2":
        return { kind: "h2", text: "", anchor: section.anchor };
      case "p":
        return { kind: "p", spans: [{ kind: "text", text: "" }] };
      case "table":
        if (!shouldTypewriteTable(section, run.finalDoc?.content[blockIndex])) {
          return cloneViewSection(section);
        }
        return {
          ...cloneViewSection(section),
          head: section.head.map(() => ""),
          rows: section.rows.map((row) => row.map(() => "")),
          ...(section.headSpans ? { headSpans: section.headSpans.map(() => []) } : {}),
          ...(section.rowSpans
            ? { rowSpans: section.rowSpans.map((row) => row.map(() => [])) }
            : {}),
        };
      default:
        return cloneViewSection(section);
    }
  });
}

export function cloneNativePresentationRun(
  run: NativePresentationRun,
): NativePresentationRun {
  return {
    ...run,
    ...(run.baselineDoc ? { baselineDoc: run.baselineDoc } : {}),
    ...(run.finalDoc ? { finalDoc: run.finalDoc } : {}),
    baselineSections: run.baselineSections.map(cloneViewSection),
    finalSections: run.finalSections.map(cloneViewSection),
  };
}

export function createNativeConcurrentState({
  run,
  instructions,
  agentCount,
  stepDelayMs,
  chunkSize,
  maxDurationMs,
  startJitter = true,
}: CreateNativeConcurrentStateOptions): NativeConcurrentState {
  const config = getNativePresentationConfig();
  const stateConfig = sanitizeNativePresentationConfig({
    ...config,
    agentCount: agentCount ?? config.agentCount,
    stepDelayMs: stepDelayMs ?? resolveNativeStepDelayMs(config),
    chunkSize: chunkSize ?? config.chunkSize,
    maxDurationMs: maxDurationMs ?? config.maxDurationMs,
    speedScale: 1,
  });
  const tasks = buildNativeConcurrentTasks(run, instructions);
  const phase = firstNativePhaseWithTasks(tasks);
  const resolvedStepDelayMs = Math.max(MIN_STEP_DELAY_MS, stateConfig.stepDelayMs);
  return {
    runId: run.id,
    phase,
    agents: createNativeAgents(stateConfig.agentCount),
    tasks,
    pendingTaskIds: taskIdsForPhase(tasks, phase),
    completedTaskIds: new Set(),
    tick: 0,
    elapsedMs: 0,
    maxDurationMs: stateConfig.maxDurationMs,
    stepDelayMs: resolvedStepDelayMs,
    stepAccumulatorMs: resolvedStepDelayMs,
    startJitter,
    chunkSize: stateConfig.chunkSize,
    lastBatchSize: 1,
  };
}

export function advanceNativeConcurrentState(
  state: NativeConcurrentState,
  dtMs: number,
): NativeConcurrentAdvanceResult {
  if (state.phase === "done") return { state, steps: [] };

  let next = startNextNativePhaseIfSettled(state);
  if (next.phase === "done") return { state: next, steps: [] };

  next = {
    ...next,
    elapsedMs: next.elapsedMs + Math.max(0, dtMs),
    stepAccumulatorMs: next.stepAccumulatorMs + Math.max(0, dtMs),
    tick: next.tick + 1,
  };

  if (next.elapsedMs >= next.maxDurationMs) {
    return { state: completeNativeConcurrentState(next), steps: [] };
  }

  if (next.stepAccumulatorMs < next.stepDelayMs) {
    return { state: next, steps: [] };
  }

  next = {
    ...next,
    stepAccumulatorMs: Math.min(
      next.stepDelayMs,
      next.stepAccumulatorMs - next.stepDelayMs,
    ),
  };

  next = claimNativeTasks(next);
  const advanced = advanceNativeAgents(next);
  return {
    state: startNextNativePhaseIfSettled(advanced.state),
    steps: advanced.steps,
  };
}

export function completeNativeConcurrentState(
  state: NativeConcurrentState,
): NativeConcurrentState {
  return {
    ...state,
    phase: "done",
    pendingTaskIds: [],
    completedTaskIds: new Set(state.tasks.map((task) => task.id)),
    agents: state.agents.map(idleNativeAgent),
  };
}

export function getNativeConcurrentProgress(
  state: NativeConcurrentState,
): NativeConcurrentProgress {
  return {
    current: state.phase === "done" ? state.tasks.length : state.completedTaskIds.size,
    total: state.tasks.length,
    activeAgents: state.agents.filter((agent) => agent.cursorPhase === "typing").length,
  };
}

function buildNativeConcurrentTasks(
  run: Pick<NativePresentationRun, "finalDoc" | "finalSections">,
  instructions: readonly NativeDiffInstruction[],
): NativeConcurrentTask[] {
  void instructions;
  return buildWholeDocumentConcurrentTasks(visibleReviewSections(run.finalSections), run.finalDoc);
}

function buildWholeDocumentConcurrentTasks(
  finalSections: readonly ViewBlock[],
  finalDoc?: PmDoc,
): NativeConcurrentTask[] {
  const tasks: NativeConcurrentTask[] = [];
  const pmBlocks = pmBlockBySection(finalDoc);

  finalSections.forEach((section, blockIndex) => {
    const text = sectionText(section);
    if (text.length === 0) return;
    const pmBlock = pmBlocks.get(blockIndex);
    const pmMeta = pmBlock
      ? { blockId: pmBlock.blockId, pmAt: pmBlock.pmStart }
      : {};

    if (section.kind === "h1" || section.kind === "h2") {
      tasks.push({
        id: `skeleton-${blockIndex}`,
        phase: "skeleton",
        ...(pmBlock ? { blockId: pmBlock.blockId } : {}),
        blockIndex,
        operations: [{ kind: "insertText", blockIndex, at: 0, text, ...pmMeta }],
      });
      return;
    }

    if (section.kind === "p") {
      tasks.push({
        id: `content-${blockIndex}`,
        phase: "content",
        ...(pmBlock ? { blockId: pmBlock.blockId } : {}),
        blockIndex,
        operations: [{ kind: "insertText", blockIndex, at: 0, text, ...pmMeta }],
      });
      return;
    }

    if (section.kind === "table" && shouldTypewriteTable(section, finalDoc?.content[blockIndex])) {
      const operations: NativeConcurrentOperation[] = tableCellEntries(section)
        .filter((entry) => entry.text.length > 0)
        .map((entry) => ({
          kind: "insertText",
          blockIndex,
          at: 0,
          text: entry.text,
          target: {
            kind: "tableCell",
            rowIndex: entry.rowIndex,
            cellIndex: entry.cellIndex,
            textBlockIndex: 0,
          },
        }));
      if (operations.length > 0) {
        tasks.push({
          id: `content-${blockIndex}`,
          phase: "content",
          blockIndex,
          operations,
        });
      }
    }
  });

  return tasks;
}

function firstNativePhaseWithTasks(
  tasks: readonly NativeConcurrentTask[],
): NativeConcurrentPhase {
  if (tasks.some((task) => task.phase === "skeleton")) return "skeleton";
  if (tasks.some((task) => task.phase === "content")) return "content";
  if (tasks.some((task) => task.phase === "diff")) return "diff";
  return "done";
}

function taskIdsForPhase(
  tasks: readonly NativeConcurrentTask[],
  phase: NativeConcurrentPhase,
): string[] {
  if (phase === "done") return [];
  return tasks.filter((task) => task.phase === phase).map((task) => task.id);
}

function startNextNativePhaseIfSettled(
  state: NativeConcurrentState,
): NativeConcurrentState {
  if (state.phase === "done") return state;
  const hasActiveAgents = state.agents.some((agent) => agent.taskId !== null);
  if (hasActiveAgents || state.pendingTaskIds.length > 0) return state;

  const order: NativeConcurrentPhase[] = ["skeleton", "content", "diff"];
  const currentIndex = order.indexOf(state.phase);
  for (const phase of order.slice(currentIndex + 1)) {
    const pendingTaskIds = taskIdsForPhase(state.tasks, phase);
    if (pendingTaskIds.length > 0) {
      return { ...state, phase, pendingTaskIds };
    }
  }

  return completeNativeConcurrentState(state);
}

function claimNativeTasks(state: NativeConcurrentState): NativeConcurrentState {
  if (state.phase === "done" || state.pendingTaskIds.length === 0) return state;

  let pendingTaskIds = state.pendingTaskIds.slice();
  let agents = state.agents.slice();
  const taskById = new Map(state.tasks.map((task) => [task.id, task]));
  const activeSections = new Set(
    agents.flatMap((agent) => (agent.blockIndex == null ? [] : [agent.blockIndex])),
  );

  agents = agents.map((agent) => {
    if (agent.cursorPhase !== "idle" || pendingTaskIds.length === 0) return agent;

    const claimIndex = pendingTaskIds.findIndex((taskId) => {
      const task = taskById.get(taskId);
      return task ? !activeSections.has(task.blockIndex) : false;
    });
    if (claimIndex < 0) return agent;

    const [taskId] = pendingTaskIds.splice(claimIndex, 1);
    const task = taskId ? taskById.get(taskId) : undefined;
    if (!task) return agent;
    activeSections.add(task.blockIndex);

    return {
      ...agent,
      blockIndex: task.blockIndex,
      taskId: task.id,
      assignmentId: agent.assignmentId + 1,
      operationIndex: 0,
      charIndex: 0,
      cursorPhase: "typing",
      startDelayTicks: state.startJitter
        ? computeStartJitter(agent.id, agent.assignmentId + 1)
        : 0,
    };
  });

  return {
    ...state,
    agents,
    pendingTaskIds,
  };
}

function advanceNativeAgents(
  state: NativeConcurrentState,
): NativeConcurrentAdvanceResult {
  const taskById = new Map(state.tasks.map((task) => [task.id, task]));
  const completedTaskIds = new Set(state.completedTaskIds);
  const steps: NativeConcurrentStep[] = [];
  let lastBatchSize = state.lastBatchSize;

  const agents = state.agents.map((agent) => {
    if (agent.cursorPhase !== "typing" || !agent.taskId) return agent;

    // 启动抖动:延迟未到先跳过本帧(不出 step),实现各光标错位启动。
    if (agent.startDelayTicks > 0) {
      return { ...agent, startDelayTicks: agent.startDelayTicks - 1 };
    }

    const task = taskById.get(agent.taskId);
    if (!task) return idleNativeAgent(agent);

    const operation = task.operations[agent.operationIndex];
    if (!operation) {
      completedTaskIds.add(task.id);
      return idleNativeAgent(agent);
    }

    const operationKey = nativeOperationKey(task.id, agent.operationIndex);
    const baseStep = {
      agentId: agent.id,
      assignmentId: agent.assignmentId,
      label: agent.label,
      color: agent.color,
      taskId: task.id,
      operationIndex: agent.operationIndex,
      operationKey,
      ...(operation.blockId ? { blockId: operation.blockId } : {}),
      blockIndex: operation.blockIndex,
      ...(operation.target ? { target: operation.target } : {}),
    };

    if (operation.kind === "cursor") {
      steps.push({
        ...baseStep,
        kind: "cursor",
        ...(operation.pmAt !== undefined ? { pmAt: operation.pmAt } : {}),
        at: operation.at,
        tone: operation.tone,
        operationLength: 0,
        operationComplete: true,
      });
      return advanceNativeAgentOperation(agent, task, completedTaskIds);
    }

    if (operation.kind === "redDot") {
      steps.push({
        ...baseStep,
        kind: "redDot",
        ...(operation.pmAt !== undefined ? { pmAt: operation.pmAt } : {}),
        at: operation.at,
        operationLength: 0,
        operationComplete: true,
      });
      return advanceNativeAgentOperation(agent, task, completedTaskIds);
    }

    if (operation.kind === "insertText") {
      const graphemes = nativeOperationGraphemes(operation);
      const chunkFrom = agent.charIndex;
      // cell 必须保持 grapheme 逐字，不能跟随全文 chunkSize 自动放大。
      const operationChunkSize = operation.target?.kind === "tableCell" ? 1 : state.chunkSize;
      const chunkTo = Math.min(graphemes.length, chunkFrom + operationChunkSize);
      const text = graphemes.slice(chunkFrom, chunkTo).join("");
      const operationComplete = chunkTo >= graphemes.length;
      lastBatchSize = Math.max(lastBatchSize, Math.max(1, chunkTo - chunkFrom));
      steps.push({
        ...baseStep,
        kind: "insertText",
        ...(operation.pmAt !== undefined ? { pmAt: operation.pmAt } : {}),
        at: operation.at,
        chunkFrom,
        chunkTo,
        text,
        operationLength: graphemes.length,
        operationComplete,
      });
      if (operationComplete) {
        return advanceNativeAgentOperation(agent, task, completedTaskIds);
      }
      return { ...agent, charIndex: chunkTo };
    }

    const length = Math.max(0, operation.to - operation.from);
    const nextDeleted = Math.min(length, agent.charIndex + state.chunkSize);
    const chunkFrom = Math.max(operation.from, operation.to - nextDeleted);
    const chunkTo = operation.to - agent.charIndex;
    const operationComplete = nextDeleted >= length;
    lastBatchSize = Math.max(lastBatchSize, Math.max(1, chunkTo - chunkFrom));
    steps.push({
      ...baseStep,
      kind: "deleteText",
      ...(operation.pmFrom !== undefined ? { pmFrom: operation.pmFrom } : {}),
      ...(operation.pmTo !== undefined ? { pmTo: operation.pmTo } : {}),
      chunkFrom,
      chunkTo,
      operationLength: length,
      operationComplete,
    });
    if (operationComplete) {
      return advanceNativeAgentOperation(agent, task, completedTaskIds);
    }
    return { ...agent, charIndex: nextDeleted };
  });

  return {
    state: {
      ...state,
      agents,
      completedTaskIds,
      lastBatchSize,
    },
    steps,
  };
}

function nativeOperationGraphemes(
  operation: Extract<NativeConcurrentOperation, { kind: "insertText" }>,
): string[] {
  const cached = nativeOperationGraphemeCache.get(operation);
  if (cached) return cached;
  const graphemes = presentationSpans.splitGraphemes(operation.text);
  nativeOperationGraphemeCache.set(operation, graphemes);
  return graphemes;
}

function advanceNativeAgentOperation(
  agent: NativeConcurrentAgent,
  task: NativeConcurrentTask,
  completedTaskIds: Set<string>,
): NativeConcurrentAgent {
  const nextOperationIndex = agent.operationIndex + 1;
  if (nextOperationIndex >= task.operations.length) {
    completedTaskIds.add(task.id);
    return idleNativeAgent(agent);
  }

  return {
    ...agent,
    operationIndex: nextOperationIndex,
    charIndex: 0,
  };
}

function idleNativeAgent(agent: NativeConcurrentAgent): NativeConcurrentAgent {
  return {
    ...agent,
    blockIndex: null,
    taskId: null,
    operationIndex: 0,
    charIndex: 0,
    cursorPhase: "idle",
    startDelayTicks: 0,
  };
}

function createNativeAgents(agentCount: number): NativeConcurrentAgent[] {
  const count = clampInt(agentCount, MIN_NATIVE_AGENT_COUNT, MAX_NATIVE_AGENT_COUNT);
  return Array.from({ length: count }, (_, index) => ({
    id: `agent-${index + 1}`,
    label: AGENT_LABELS[index] ?? AGENT_LABELS[0],
    color: laneColor(index + 1),
    blockIndex: null,
    taskId: null,
    assignmentId: 0,
    operationIndex: 0,
    charIndex: 0,
    cursorPhase: "idle",
    startDelayTicks: 0,
  }));
}

// 每个光标认领任务时的"启动抖动"上限(帧):用确定性伪随机错开各光标启动,
// 形成"几个 Agent 各忙各的"错位感,而不是同步整齐。
const NATIVE_START_JITTER_MAX_TICKS = 6;

function computeStartJitter(agentId: string, assignmentId: number): number {
  // FNV-1a 风格哈希:确定性(可测) + 随 assignmentId 每轮认领变化(看着随机)。
  let h = 2166136261;
  for (let i = 0; i < agentId.length; i += 1) {
    h ^= agentId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= assignmentId;
  h = Math.imul(h, 16777619);
  return Math.abs(h) % (NATIVE_START_JITTER_MAX_TICKS + 1);
}

function nativeOperationKey(taskId: string, operationIndex: number): string {
  return `${taskId}:${operationIndex}`;
}

function cloneViewSection(section: ViewBlock): ViewBlock {
  const meta = {
    ...(section.blockId ? { blockId: section.blockId } : {}),
    ...(section.blockPatch
      ? {
          blockPatch: {
            patchId: section.blockPatch.patchId,
            op: section.blockPatch.op,
            ...(section.blockPatch.marker ? { marker: { ...section.blockPatch.marker } } : {}),
          },
        }
      : {}),
  };
  switch (section.kind) {
    case "h1":
      return { ...meta, kind: "h1", text: section.text, ...(section.textAlign ? { textAlign: section.textAlign } : {}), ...(section.spans ? { spans: section.spans.map((span) => ({ ...span })) } : {}) };
    case "h2":
      return { ...meta, kind: "h2", text: section.text, anchor: section.anchor, ...(section.textAlign ? { textAlign: section.textAlign } : {}), ...(section.spans ? { spans: section.spans.map((span) => ({ ...span })) } : {}) };
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return { ...meta, kind: section.kind, text: section.text, ...(section.textAlign ? { textAlign: section.textAlign } : {}), ...(section.spans ? { spans: section.spans.map((span) => ({ ...span })) } : {}) };
    case "p":
      return { ...meta, kind: "p", spans: section.spans.map((span) => ({ ...span })), ...(section.textAlign ? { textAlign: section.textAlign } : {}) };
    case "quote":
      return { ...meta, kind: "quote", text: section.text, ...(section.spans ? { spans: section.spans.map((span) => ({ ...span })) } : {}), ...(section.node ? { node: cloneJson(section.node) } : {}) };
    case "list":
      return {
        ...meta,
        kind: "list",
        ordered: section.ordered,
        ...(section.start != null ? { start: section.start } : {}),
        items: section.items.slice(),
        ...(section.node ? { node: cloneJson(section.node) } : {}),
        ...(section.itemSpans ? { itemSpans: section.itemSpans.map((spans) => spans.map((sp) => ({ ...sp }))) } : {}),
        ...(section.rowDiff ? { rowDiff: cloneJson(section.rowDiff) } : {}),
      };
    case "hr":
      return { ...meta, kind: "hr" };
    case "table":
      return {
        ...meta,
        kind: "table",
        head: section.head.slice(),
        rows: section.rows.map((row) => row.slice()),
        ...(section.node ? { node: cloneJson(section.node) } : {}),
        ...(section.headSpans
          ? { headSpans: section.headSpans.map((spans) => spans.map((sp) => ({ ...sp }))) }
          : {}),
        ...(section.rowSpans
          ? { rowSpans: section.rowSpans.map((row) => row.map((spans) => spans.map((sp) => ({ ...sp })))) }
          : {}),
        ...(section.cellDiff ? { cellDiff: cloneJson(section.cellDiff) } : {}),
      };
    case "code":
      return { ...meta, kind: "code", body: section.body, language: section.language ?? null };
    case "diagram":
      return { ...meta, kind: "diagram", source: section.source, lang: section.lang, svg: section.svg, overlay: cloneJson(section.overlay) };
    case "penNote":
      return { ...meta, kind: "penNote", text: section.text, ...(section.spans ? { spans: section.spans.map((span) => ({ ...span })) } : {}) };
    case "image":
      return {
        ...meta,
        kind: "image",
        src: section.src,
        alt: section.alt,
	        caption: section.caption,
	        width: section.width,
	        height: section.height,
	        align: section.align ?? "center",
	      };
    case "fileAttachment":
      return {
        ...meta,
        kind: "fileAttachment",
        fileId: section.fileId,
        filename: section.filename,
        mimeType: section.mimeType,
        size: section.size,
      };
    case "taskList":
      return { ...meta, kind: "taskList", node: cloneJson(section.node), text: section.text, ...(section.rowDiff ? { rowDiff: cloneJson(section.rowDiff) } : {}) };
    case "callout":
      return { ...meta, kind: "callout", node: cloneJson(section.node), text: section.text, ...(section.bodyDiff ? { bodyDiff: cloneJson(section.bodyDiff) } : {}) };
    case "columnList":
      return { ...meta, kind: "columnList", node: cloneJson(section.node), text: section.text, ...(section.columnsDiff ? { columnsDiff: cloneJson(section.columnsDiff) } : {}) };
    case "math":
      return { ...meta, kind: "math", node: section.node, latex: section.latex };
  }
}

function cloneJson<T>(value: T): T {
  if (value == null) return value;
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function buildWholeDocumentInstructions(
  finalSections: readonly ViewBlock[],
  finalDoc?: PmDoc,
): NativeDiffInstruction[] {
  const titles: NativeDiffInstruction[] = [];
  const body: NativeDiffInstruction[] = [];
  const pmBlocks = pmBlockBySection(finalDoc);

  finalSections.forEach((section, blockIndex) => {
    const pmBlock = pmBlocks.get(blockIndex);
    const instruction: NativeDiffInstruction = {
      kind: "insertSection",
      ...(pmBlock ? { blockId: pmBlock.blockId, pmAt: pmBlock.pmStart } : {}),
      blockIndex,
      section,
      label: AGENT_LABELS[blockIndex % AGENT_LABELS.length]!,
    };
    if (section.kind === "h1" || section.kind === "h2") {
      titles.push(instruction);
    } else {
      body.push(instruction);
    }
  });

  return [...titles, ...body];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}
