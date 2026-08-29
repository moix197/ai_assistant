import type { ApprovalRequest } from "@hermes/agent";
import { describe, expect, it } from "vitest";
import { formatBatchPrompt, formatResolvedText } from "../approval-prompt-renderer";

describe("formatBatchPrompt", () => {
  it("renders a two-line identity block for a summary with a non-empty target (a known sheet with a description)", () => {
    const batch: ApprovalRequest[] = [
      {
        tool: "sheets_write",
        args: { mode: "append", sheet: "clients", range: "A1:B1", values: [["Jane", "555-0100"]] },
        summary: {
          action: "¿Escribir en clients?",
          target: "Registro de clientes 2026",
          effects: [],
        },
      },
    ];

    expect(formatBatchPrompt(batch)).toBe("¿Escribir en clients?\nRegistro de clientes 2026");
  });

  it("renders a single-line identity block, no target line, when the summary's target is absent (a known sheet with an empty description)", () => {
    const batch: ApprovalRequest[] = [
      {
        tool: "sheets_write",
        args: { mode: "append", sheet: "clients", range: "A1:B1", values: [["Jane", "555-0100"]] },
        summary: { action: "¿Escribir en clients?", effects: [] },
      },
    ];

    expect(formatBatchPrompt(batch)).toBe("¿Escribir en clients?");
  });

  it("falls back to the raw-JSON line, byte-identical to today, for a prepare-less call (no summary) — the echo fallback", () => {
    const batch: ApprovalRequest[] = [{ tool: "echo", args: { text: "hi" } }];

    expect(formatBatchPrompt(batch)).toBe('- echo({"text":"hi"})');
  });

  it("falls back to the raw-JSON line when a summary is present but its action is empty (malformed/defensive)", () => {
    const batch: ApprovalRequest[] = [
      { tool: "sheets_write", args: { mode: "append" }, summary: { action: "", effects: [] } },
    ];

    expect(formatBatchPrompt(batch)).toBe('- sheets_write({"mode":"append"})');
  });

  it("joins multiple calls' blocks with a blank line, mixing a legible summary and a raw-JSON fallback, with no shared trailing question line", () => {
    const batch: ApprovalRequest[] = [
      {
        tool: "sheets_write",
        args: { sheet: "clients" },
        summary: { action: "¿Escribir en clients?", effects: [] },
      },
      { tool: "echo", args: { text: "hi" } },
    ];

    expect(formatBatchPrompt(batch)).toBe('¿Escribir en clients?\n\n- echo({"text":"hi"})');
  });

  it("renders indented items with an itemsTotal-driven count line, followed by effects (Phase 5/6 shapes, exercised early since the renderer is final this phase)", () => {
    const batch: ApprovalRequest[] = [
      {
        tool: "sheets_write",
        args: {},
        summary: {
          action: "¿Escribir en clients?",
          target: "Clients",
          items: ["Jane, 555-0100", "John, 555-0200"],
          itemsTotal: 5,
          effects: ["Modo: agregar filas nuevas."],
        },
      },
    ];

    expect(formatBatchPrompt(batch)).toBe(
      [
        "¿Escribir en clients?",
        "Clients",
        "",
        "  Jane, 555-0100",
        "  John, 555-0200",
        "  …y 3 más (5 en total).",
        "",
        "Modo: agregar filas nuevas.",
      ].join("\n"),
    );
  });

  it("omits the itemsTotal count line when every item is already shown", () => {
    const batch: ApprovalRequest[] = [
      {
        tool: "sheets_write",
        args: {},
        summary: {
          action: "¿Escribir en clients?",
          items: ["Jane, 555-0100"],
          itemsTotal: 1,
          effects: [],
        },
      },
    ];

    expect(formatBatchPrompt(batch)).toBe("¿Escribir en clients?\n\n  Jane, 555-0100");
  });
});

describe("formatResolvedText", () => {
  it("appends the resolution label after the same block formatBatchPrompt produces", () => {
    const batch: ApprovalRequest[] = [{ tool: "echo", args: { text: "hi" } }];

    expect(formatResolvedText(batch, "Approved.")).toBe('- echo({"text":"hi"})\n\nApproved.');
  });
});
