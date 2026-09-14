// Covers #148031 follow-up: forwarding fallback through the REAL gateway
// route coordinator lifecycle + REAL shared suppression factory + transport
// capture (not a bare boolean spy).
//
// - inactive handler (no reporter started) -> fallback DELIVERED
// - active handler (reporter.start) -> fallback SUPPRESSED
// - recovered handler (reporter.stop) -> fallback DELIVERED again
// - different account (reporter for ops, request for default) -> DELIVERED
//   (account isolation: another account's runtime must not suppress)
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createApproverRestrictedNativeApprovalAdapter } from "../plugin-sdk/approval-delivery-helpers.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { createApprovalNativeRouteCoordinator } from "./approval-native-route-coordinator.js";
import { createExecApprovalForwarder } from "./exec-approval-forwarder.js";

const { mockLogError } = vi.hoisted(() => ({ mockLogError: vi.fn() }));
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    subsystem: "gateway/exec-approvals",
    isEnabled: () => false,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: mockLogError,
    fatal: vi.fn(),
    raw: vi.fn(),
    child: vi.fn(),
  }),
}));

const activeForwarders: Array<ReturnType<typeof createExecApprovalForwarder>> = [];
const activeReporters: Array<{ stop: () => Promise<void> | void }> = [];

afterEach(async () => {
  await Promise.all(activeForwarders.splice(0).map((forwarder) => forwarder.stop()));
  await Promise.all(activeReporters.splice(0).map((reporter) => reporter.stop()));
  setActivePluginRegistry(createTestRegistry([]));
  vi.restoreAllMocks();
});

function registerRealFactoryPlugin() {
  const realAdapter = createApproverRestrictedNativeApprovalAdapter({
    channel: "telegram",
    channelLabel: "Telegram",
    listAccountIds: () => ["default", "ops"],
    hasApprovers: () => true,
    isExecAuthorizedSender: () => true,
    isNativeDeliveryEnabled: () => true,
    resolveNativeDeliveryMode: () => "both",
    requireMatchingTurnSourceChannel: true,
  });
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "telegram",
        plugin: {
          ...createChannelTestPluginBase({ id: "telegram" }),
          approvalCapability: {
            delivery: {
              shouldSuppressForwardingFallback:
                realAdapter.delivery?.shouldSuppressForwardingFallback,
            },
            render: {
              exec: {
                buildPendingPayload: ({ request }: { request: { id: string } }) => ({
                  text: `Telegram exec approval ${request.id}`,
                }),
              },
            },
          },
        },
        source: "test",
      },
    ]),
  );
}

const baseCfg = {
  approvals: { exec: { enabled: true, mode: "session" } },
} as OpenClawConfig;

function buildRequest(accountId: string, id = `req-${accountId}`) {
  return {
    id,
    request: {
      command: "echo hello",
      agentId: "main",
      sessionKey: "agent:main:main",
      turnSourceChannel: "telegram",
      turnSourceTo: "-100999",
      turnSourceAccountId: accountId,
    },
    createdAtMs: 1000,
    expiresAtMs: 6000,
  };
}

function startReporter(
  coordinator: ReturnType<typeof createApprovalNativeRouteCoordinator>,
  opts: { channel: string; accountId: string },
) {
  const reporter = coordinator.createReporter({
    handledKinds: new Set(["exec" as const]),
    channel: opts.channel,
    accountId: opts.accountId,
    requestGateway: (async () => ({ ok: true })) as never,
    shouldHandle: () => true,
    classifyRoute: () => "unbound" as const,
  });
  reporter.start();
  activeReporters.push(reporter);
  return reporter;
}

function createWiredForwarder(
  coordinator: ReturnType<typeof createApprovalNativeRouteCoordinator>,
  transportLog: Array<{ channel: string; to: string; accountId?: string; text?: string }>,
  accountId: string,
) {
  // Production wiring mirror (server-channels.ts): the forwarder asks the
  // instance route coordinator whether a native runtime is active.
  const hasActiveNativeRuntime = (params: {
    approvalKind: "exec";
    channel: string;
    accountId?: string | null;
  }) =>
    coordinator.hasActiveRuntime({
      approvalKind: params.approvalKind,
      channel: params.channel,
      accountId: params.accountId,
    });
  const deliver = async (params: {
    channel: string;
    to: string;
    accountId?: string;
    payloads: Array<{ text?: string }>;
  }) => {
    transportLog.push({
      channel: params.channel,
      to: params.to,
      accountId: params.accountId,
      text: params.payloads[0]?.text,
    });
    return [];
  };
  const forwarder = createExecApprovalForwarder({
    getConfig: () => baseCfg,
    deliver: deliver as never,
    nowMs: () => 1000,
    resolveSessionTarget: () => ({
      channel: "telegram",
      to: "-100999",
      accountId,
    }),
    hasActiveNativeRuntime: hasActiveNativeRuntime as never,
  });
  activeForwarders.push(forwarder);
  return forwarder;
}

describe("exec approval forwarder gateway-runtime delivery (#148226)", () => {
  it("delivers with inactive handler, suppresses when active, delivers again after recovery", async () => {
    registerRealFactoryPlugin();
    const coordinator = createApprovalNativeRouteCoordinator();
    const transportLog: Array<{ text?: string }> = [];
    const forwarder = createWiredForwarder(coordinator, transportLog as never, "default");

    // 1) inactive: no reporter started -> fallback delivered to transport
    await expect(
      forwarder.handleRequested(buildRequest("default", "req-inactive") as never),
    ).resolves.toBe(true);
    expect(transportLog).toHaveLength(1);
    expect(transportLog[0]?.text).toContain("req-inactive");

    // 2) active: reporter started for same channel/account -> suppressed
    const reporter = startReporter(coordinator, { channel: "telegram", accountId: "default" });
    expect(
      coordinator.hasActiveRuntime({
        approvalKind: "exec",
        channel: "telegram",
        accountId: "default",
      }),
    ).toBe(true);
    transportLog.length = 0;
    await expect(
      forwarder.handleRequested(buildRequest("default", "req-active") as never),
    ).resolves.toBe(false);
    expect(transportLog).toHaveLength(0);

    // 3) recovered: reporter stopped -> fallback delivered again
    await reporter.stop();
    expect(
      coordinator.hasActiveRuntime({
        approvalKind: "exec",
        channel: "telegram",
        accountId: "default",
      }),
    ).toBe(false);
    await expect(
      forwarder.handleRequested(buildRequest("default", "req-recovered") as never),
    ).resolves.toBe(true);
    expect(transportLog).toHaveLength(1);
    expect(transportLog[0]?.text).toContain("req-recovered");
  });

  it("isolates accounts: another account runtime does not suppress this target", async () => {
    registerRealFactoryPlugin();
    const coordinator = createApprovalNativeRouteCoordinator();
    const defaultLog: Array<{ text?: string }> = [];
    const opsLog: Array<{ text?: string }> = [];
    const defaultForwarder = createWiredForwarder(coordinator, defaultLog as never, "default");
    const opsForwarder = createWiredForwarder(coordinator, opsLog as never, "ops");

    // Only ops has an active native runtime.
    startReporter(coordinator, { channel: "telegram", accountId: "ops" });
    expect(
      coordinator.hasActiveRuntime({ approvalKind: "exec", channel: "telegram", accountId: "ops" }),
    ).toBe(true);
    expect(
      coordinator.hasActiveRuntime({
        approvalKind: "exec",
        channel: "telegram",
        accountId: "default",
      }),
    ).toBe(false);

    // default target still gets the fallback (isolation).
    await expect(
      defaultForwarder.handleRequested(buildRequest("default", "req-default") as never),
    ).resolves.toBe(true);
    expect(defaultLog).toHaveLength(1);
    expect(defaultLog[0]?.text).toContain("req-default");

    // ops target is suppressed by its own active runtime.
    await expect(
      opsForwarder.handleRequested(buildRequest("ops", "req-ops") as never),
    ).resolves.toBe(false);
    expect(opsLog).toHaveLength(0);
  });
});
