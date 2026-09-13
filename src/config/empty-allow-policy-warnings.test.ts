import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "./types.js";
import { collectEmptyAllowPolicyWarnings } from "./validation-core.js";

function configWith(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

describe("collectEmptyAllowPolicyWarnings", () => {
  it("warns for an empty allow list on global tools (#147342)", () => {
    const warnings = collectEmptyAllowPolicyWarnings(
      configWith({ tools: { allow: [], deny: ["dangerous-*"] } }),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.path).toBe("tools");
    expect(warnings[0]?.message).toContain("Empty allow list permits everything not denied");
  });

  it("warns per sender in toolsBySender", () => {
    const warnings = collectEmptyAllowPolicyWarnings(
      configWith({
        tools: {
          toolsBySender: {
            "e164:+390000000000": { allow: [] },
            "e164:+391111111111": { allow: ["read"] },
          },
        },
      }),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.path).toBe("tools.toolsBySender.e164:+390000000000");
  });

  it("warns for agent entry tools and their sender overrides", () => {
    const warnings = collectEmptyAllowPolicyWarnings(
      configWith({
        agents: {
          entries: {
            chat: {
              tools: {
                allow: [],
                toolsBySender: { "e164:+390000000000": { allow: [] } },
              },
            },
            main: { tools: { allow: ["read"] } },
          },
        },
      }),
    );
    const paths = warnings.map((warning) => warning.path).sort();
    expect(paths).toEqual([
      "agents.entries.chat.tools",
      "agents.entries.chat.tools.toolsBySender.e164:+390000000000",
    ]);
  });

  it("stays silent when allow is omitted, non-empty, or absent", () => {
    const warnings = collectEmptyAllowPolicyWarnings(
      configWith({
        tools: { deny: ["*"] },
        agents: { entries: { main: { tools: { allow: ["read"] } } } },
      }),
    );
    expect(warnings).toEqual([]);
    expect(collectEmptyAllowPolicyWarnings(configWith({}))).toEqual([]);
  });
});
