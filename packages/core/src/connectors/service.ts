import { getConnectorDefinition } from "./registryCore.js";
import type {
  ConnectorId,
  ConnectorState,
  ConnectorStatusDto,
  ConnectorStatusPatch,
  ConnectorTransitionKind,
  ConnectorTransitionTable,
} from "./types.js";

const STATES: ConnectorState[] = [
  "unavailable",
  "unconfigured",
  "disconnected",
  "pending",
  "connected",
  "needs_reauth",
];

const LEGAL_TARGETS: Readonly<Record<ConnectorState, readonly ConnectorState[]>> = {
  unavailable: ["unconfigured", "disconnected"],
  unconfigured: ["unavailable", "disconnected"],
  disconnected: ["unavailable", "unconfigured", "pending", "connected"],
  pending: ["unavailable", "unconfigured", "disconnected", "connected"],
  connected: ["unavailable", "unconfigured", "disconnected", "pending", "needs_reauth"],
  needs_reauth: ["unavailable", "unconfigured", "disconnected", "pending", "connected"],
};

function buildTransitionTable(): ConnectorTransitionTable {
  return Object.fromEntries(
    STATES.map((from) => [
      from,
      Object.fromEntries(
        STATES.map((to): [ConnectorState, ConnectorTransitionKind] => [
          to,
          from === to ? "idempotent" : LEGAL_TARGETS[from].includes(to) ? "transition" : "illegal",
        ]),
      ),
    ]),
  ) as ConnectorTransitionTable;
}

const DEFAULT_TRANSITION_TABLE = buildTransitionTable();

export const CONNECTOR_TRANSITION_TABLES: Readonly<Record<ConnectorId, ConnectorTransitionTable>> = {
  github: DEFAULT_TRANSITION_TABLE,
  feishu: DEFAULT_TRANSITION_TABLE,
  "wechat-mp": DEFAULT_TRANSITION_TABLE,
};

export class ConnectorTransitionError extends Error {
  readonly status = 409;
  readonly code = "ILLEGAL_CONNECTOR_TRANSITION";

  constructor(
    readonly connectorId: ConnectorId,
    readonly from: ConnectorState,
    readonly to: ConnectorState,
  ) {
    super(`连接器 ${connectorId} 不允许从 ${from} 迁移到 ${to}`);
    this.name = "ConnectorTransitionError";
  }
}

export function createConnectorStatus(
  state: ConnectorState,
  patch: ConnectorStatusPatch = {},
): ConnectorStatusDto {
  return {
    state,
    reasonCode: patch.reasonCode ?? null,
    account: patch.account ?? null,
    scopes: patch.scopes ? [...patch.scopes] : [],
    lastCheckedAt: patch.lastCheckedAt ?? null,
    statusFreshness: patch.statusFreshness ?? "unknown",
    canProbe: patch.canProbe ?? false,
    ...(patch.cliVersion !== undefined ? { cliVersion: patch.cliVersion } : {}),
  };
}

export interface ConnectorTransitionResult {
  status: ConnectorStatusDto;
  idempotent: boolean;
}

export function transitionConnectorStatus(
  connectorId: ConnectorId,
  current: ConnectorStatusDto,
  target: ConnectorState,
  patch: ConnectorStatusPatch = {},
): ConnectorTransitionResult {
  getConnectorDefinition(connectorId);
  const kind = CONNECTOR_TRANSITION_TABLES[connectorId][current.state][target];
  if (kind === "illegal") {
    throw new ConnectorTransitionError(connectorId, current.state, target);
  }
  if (kind === "idempotent") {
    return { status: current, idempotent: true };
  }
  return {
    status: createConnectorStatus(target, {
      ...patch,
      account: patch.account === undefined ? current.account : patch.account,
      scopes: patch.scopes === undefined ? current.scopes : patch.scopes,
      canProbe: patch.canProbe === undefined ? current.canProbe : patch.canProbe,
      cliVersion: patch.cliVersion === undefined ? current.cliVersion : patch.cliVersion,
    }),
    idempotent: false,
  };
}

export class ConnectorStateService {
  private readonly statuses = new Map<ConnectorId, ConnectorStatusDto>();

  constructor(initial: Partial<Record<ConnectorId, ConnectorStatusDto>> = {}) {
    for (const definition of ["github", "feishu", "wechat-mp"] as const) {
      this.statuses.set(
        definition,
        initial[definition] ?? createConnectorStatus("disconnected", { canProbe: true }),
      );
    }
  }

  getStatus(connectorId: ConnectorId): ConnectorStatusDto {
    getConnectorDefinition(connectorId);
    return this.statuses.get(connectorId)!;
  }

  transition(
    connectorId: ConnectorId,
    target: ConnectorState,
    patch: ConnectorStatusPatch = {},
  ): ConnectorTransitionResult {
    const result = transitionConnectorStatus(connectorId, this.getStatus(connectorId), target, patch);
    this.statuses.set(connectorId, result.status);
    return result;
  }

  start(connectorId: ConnectorId): ConnectorTransitionResult {
    return this.transition(connectorId, "pending", {
      reasonCode: null,
      statusFreshness: "fresh",
    });
  }

  disconnect(connectorId: ConnectorId): ConnectorTransitionResult {
    return this.transition(connectorId, "disconnected", {
      reasonCode: "USER_DISCONNECTED",
      account: null,
      scopes: [],
      statusFreshness: "fresh",
    });
  }

  pendingExpired(connectorId: ConnectorId): ConnectorTransitionResult {
    if (this.getStatus(connectorId).state === "disconnected") {
      return this.annotateDisconnected(connectorId, "PENDING_EXPIRED");
    }
    return this.transition(connectorId, "disconnected", {
      reasonCode: "PENDING_EXPIRED",
      account: null,
      scopes: [],
      statusFreshness: "fresh",
    });
  }

  pendingLost(connectorId: ConnectorId): ConnectorTransitionResult {
    if (this.getStatus(connectorId).state === "disconnected") {
      return this.annotateDisconnected(connectorId, "PENDING_LOST");
    }
    return this.transition(connectorId, "disconnected", {
      reasonCode: "PENDING_LOST",
      account: null,
      scopes: [],
      statusFreshness: "fresh",
    });
  }

  private annotateDisconnected(
    connectorId: ConnectorId,
    reasonCode: "PENDING_EXPIRED" | "PENDING_LOST",
  ): ConnectorTransitionResult {
    const current = this.getStatus(connectorId);
    if (current.reasonCode === reasonCode) return { status: current, idempotent: true };
    const status = createConnectorStatus("disconnected", {
      reasonCode,
      account: null,
      scopes: [],
      lastCheckedAt: current.lastCheckedAt,
      statusFreshness: "fresh",
      canProbe: current.canProbe,
    });
    this.statuses.set(connectorId, status);
    return { status, idempotent: false };
  }
}
