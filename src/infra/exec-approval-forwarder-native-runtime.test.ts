// Covers #148031: the forwarding fallback is kept unless a native approval
// runtime is proven active for the target — through the real forwarder and
// the real shared suppression factory, with a spy deliver.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createApproverRestrictedNativeApprovalAdapter } from "../plugin-sdk/approval-delivery-helpers.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
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

afterEach(async () => {
  await Promise.all(activeForwarders.splice(0).map((forwarder) => forwarder.stop()));
  setActivePluginRegistry(createTestRegistry([]));
  vi.restoreAllMocks();
});

function registerRealFactoryPlugin() {
  const realAdapter = createApproverRestrictedNativeApprovalAdapter({
    channel: "telegram",
    channelLabel: "Telegram",
    listAccountIds: () => ["default"],
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

const nativeCfg = {
  approvals: { exec: { enabled: true, mode: "session" } },
} as OpenClawConfig;

const nativeRequest = {
  id: "req-1",
  request: {
    command: "echo hello",
    agentId: "main",
    sessionKey: "agent:main:main",
    turnSourceChannel: "telegram",
    turnSourceTo: "-100999",
    turnSourceAccountId: "default",
  },
  createdAtMs: 1000,
  expiresAtMs: 6000,
};

function createNativeForwarder(hasActiveNativeRuntime?: () => boolean) {
  const deliver = vi.fn().mockResolvedValue([]);
  const forwarder = createExecApprovalForwarder({
    getConfig: () => nativeCfg,
    deliver: deliver as never,
    nowMs: () => 1000,
    resolveSessionTarget: () => ({
      channel: "telegram",
      to: "-100999",
      accountId: "default",
    }),
    ...(hasActiveNativeRuntime === undefined ? {} : { hasActiveNativeRuntime }),
  });
  activeForwarders.push(forwarder);
  return { deliver, forwarder };
}

describe("exec approval forwarder native-runtime gate (#148031)", () => {
  it.each([false, undefined] as const)(
    "delivers the fallback when no native runtime is proven active (%s)",
    async (nativeRouteActive) => {
      registerRealFactoryPlugin();
      const { deliver, forwarder } = createNativeForwarder(
        nativeRouteActive === undefined ? undefined : () => nativeRouteActive,
      );
      await expect(forwarder.handleRequested(nativeRequest as never)).resolves.toBe(true);
      expect(deliver).toHaveBeenCalledTimes(1);
      const firstCall = deliver.mock.calls[0]?.[0] as
        | { payloads?: Array<{ text?: string }> }
        | undefined;
      expect(firstCall?.payloads?.[0]?.text).toContain("Telegram exec approval");
    },
  );

  it("suppresses the fallback while a native runtime is proven active", async () => {
    registerRealFactoryPlugin();
    const { deliver, forwarder } = createNativeForwarder(() => true);
    await expect(forwarder.handleRequested(nativeRequest as never)).resolves.toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });
});
