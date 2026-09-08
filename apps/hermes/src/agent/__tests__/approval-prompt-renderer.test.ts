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

  it("falls back to the pre-Phase-3 header-plus-raw-JSON format, byte-identical to today minus the trailing question line, for a prepare-less call (no summary) — the echo fallback", () => {
    const batch: ApprovalRequest[] = [{ tool: "echo", args: { text: "hi" } }];

    expect(formatBatchPrompt(batch)).toBe('The model wants to run:\n- echo({"text":"hi"})');
  });

  it("falls back to the header-plus-raw-JSON format when a summary is present but its action is empty (malformed/defensive)", () => {
    const batch: ApprovalRequest[] = [
      { tool: "sheets_write", args: { mode: "append" }, summary: { action: "", effects: [] } },
    ];

    expect(formatBatchPrompt(batch)).toBe(
      'The model wants to run:\n- sheets_write({"mode":"append"})',
    );
  });

  it("renders a mixed batch per call: the summary call gets its legible block, the prepare-less call gets its own raw-JSON line, headerless, joined by a blank line", () => {
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

  it("renders the whole batch in the pre-Phase-3 fallback format (header, one raw-JSON line per call), byte-identical to today, only when EVERY call lacks a usable summary", () => {
    const batch: ApprovalRequest[] = [
      { tool: "sheets_write", args: { sheet: "clients" } },
      { tool: "echo", args: { text: "hi" } },
    ];

    expect(formatBatchPrompt(batch)).toBe(
      'The model wants to run:\n- sheets_write({"sheet":"clients"})\n- echo({"text":"hi"})',
    );
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

  it("renders the plan's golden-path 1-row append example verbatim (06-legible-approvals-bounded-reads Phase 5, settled decision 21's literal copy, minus the not-yet-added valueInputOption consequence sentence) — a hand-built ApprovalSummary, not a real sheets_write call", () => {
    const batch: ApprovalRequest[] = [
      {
        tool: "sheets_write",
        args: {
          mode: "append",
          sheet: "clients",
          range: "A1:B1",
          values: [["Test Uno", "1990-05-12"]],
        },
        summary: {
          action: "¿Agregar una fila a Clients?",
          target: "Registro de clientes 2026",
          items: ["Test Uno, 1990-05-12"],
          itemsTotal: 1,
          effects: ["Agrega una fila nueva al final. No cambia nada de lo existente."],
        },
      },
    ];

    expect(formatBatchPrompt(batch)).toBe(
      [
        "¿Agregar una fila a Clients?",
        "Registro de clientes 2026",
        "",
        "  Test Uno, 1990-05-12",
        "",
        "Agrega una fila nueva al final. No cambia nada de lo existente.",
      ].join("\n"),
    );
  });

  it("renders a 40-row append's count line as '…y 37 más (40 en total).'", () => {
    const batch: ApprovalRequest[] = [
      {
        tool: "sheets_write",
        args: { mode: "append", sheet: "clients", range: "A1:B1", values: [] },
        summary: {
          action: "¿Agregar 40 filas a Clients?",
          target: "Clients",
          items: ["Name0, 555-0100", "Name1, 555-0101", "Name2, 555-0102"],
          itemsTotal: 40,
          effects: ["Agrega una fila nueva al final. No cambia nada de lo existente."],
        },
      },
    ];

    expect(formatBatchPrompt(batch)).toBe(
      [
        "¿Agregar 40 filas a Clients?",
        "Clients",
        "",
        "  Name0, 555-0100",
        "  Name1, 555-0101",
        "  Name2, 555-0102",
        "  …y 37 más (40 en total).",
        "",
        "Agrega una fila nueva al final. No cambia nada de lo existente.",
      ].join("\n"),
    );
  });

  it("renders update-mode copy with a distinct verb and no A1-notation substring anywhere in the rendered prompt", () => {
    const batch: ApprovalRequest[] = [
      {
        tool: "sheets_write",
        args: {
          mode: "update",
          sheet: "clients",
          range: "A2:B2",
          values: [["Test Uno", "actualizado"]],
        },
        summary: {
          action: "¿Reemplazar 1 fila en Clients?",
          target: "Registro de clientes 2026",
          items: ["Test Uno, actualizado"],
          itemsTotal: 1,
          effects: ["Sobrescribe una fila que ya existe."],
        },
      },
    ];

    const rendered = formatBatchPrompt(batch);

    expect(rendered).toBe(
      [
        "¿Reemplazar 1 fila en Clients?",
        "Registro de clientes 2026",
        "",
        "  Test Uno, actualizado",
        "",
        "Sobrescribe una fila que ya existe.",
      ].join("\n"),
    );
    expect(rendered).not.toContain("A2:B2");
    expect(rendered).not.toMatch(/[A-Z]+\d+:[A-Z]+\d+/);
  });

  it("zero-row edge case: items is [] and itemsTotal is omitted — no preview block and no count line, only the question, target, and mode-description effect (06-legible-approvals-bounded-reads Phase 5)", () => {
    const batch: ApprovalRequest[] = [
      {
        tool: "sheets_write",
        args: { mode: "append", sheet: "clients", range: "A1:B1", values: [] },
        summary: {
          action: "¿Agregar 0 filas a clients?",
          target: "Clients",
          items: [],
          effects: ["Agrega una fila nueva al final. No cambia nada de lo existente."],
        },
      },
    ];

    const rendered = formatBatchPrompt(batch);

    expect(rendered).toBe(
      [
        "¿Agregar 0 filas a clients?",
        "Clients",
        "",
        "Agrega una fila nueva al final. No cambia nada de lo existente.",
      ].join("\n"),
    );
    expect(rendered).toContain("¿Agregar 0 filas a clients?");
    expect(rendered).toContain("Clients");
    expect(rendered).toContain("Agrega una fila nueva al final. No cambia nada de lo existente.");
    expect(rendered).not.toContain("  "); // no indented preview-item lines
    expect(rendered).not.toContain("más");
    expect(rendered).not.toContain("en total");
  });

  it("empty-description fallback re-asserted against the richer items/effects shape: no target line, but items and effects still render", () => {
    const batch: ApprovalRequest[] = [
      {
        tool: "sheets_write",
        args: { mode: "append", sheet: "clients", range: "A1:B1", values: [["Jane", "555-0100"]] },
        summary: {
          action: "¿Agregar una fila a clients?",
          items: ["Jane, 555-0100"],
          itemsTotal: 1,
          effects: ["Agrega una fila nueva al final. No cambia nada de lo existente."],
        },
      },
    ];

    expect(formatBatchPrompt(batch)).toBe(
      [
        "¿Agregar una fila a clients?",
        "",
        "  Jane, 555-0100",
        "",
        "Agrega una fila nueva al final. No cambia nada de lo existente.",
      ].join("\n"),
    );
  });

  it("renders gmail_archive's summary through the unchanged renderer (09-gmail-read-then-send Phase 3, hand-built ApprovalSummary — no renderer change needed)", () => {
    const batch: ApprovalRequest[] = [
      {
        tool: "gmail_archive",
        args: { threadId: "thread-1" },
        summary: {
          action: "¿Archivar esta conversación?",
          target: "Q3 budget",
          effects: ["Sale de Recibidos. Sigue disponible en Todos los mensajes."],
        },
      },
    ];

    expect(formatBatchPrompt(batch)).toBe(
      [
        "¿Archivar esta conversación?",
        "Q3 budget",
        "",
        "Sale de Recibidos. Sigue disponible en Todos los mensajes.",
      ].join("\n"),
    );
  });

  it("renders gmail_label's 'add' summary through the unchanged renderer (09-gmail-read-then-send Phase 3)", () => {
    const batch: ApprovalRequest[] = [
      {
        tool: "gmail_label",
        args: { threadId: "thread-1", label: "Trabajo", action: "add" },
        summary: {
          action: '¿Ponerle la etiqueta "Trabajo" a esta conversación?',
          effects: ['Se agrega la etiqueta "Trabajo".'],
        },
      },
    ];

    expect(formatBatchPrompt(batch)).toBe(
      [
        '¿Ponerle la etiqueta "Trabajo" a esta conversación?',
        "",
        'Se agrega la etiqueta "Trabajo".',
      ].join("\n"),
    );
  });

  it("renders gmail_label's 'remove' summary distinctly from 'add' (09-gmail-read-then-send Phase 3)", () => {
    const batch: ApprovalRequest[] = [
      {
        tool: "gmail_label",
        args: { threadId: "thread-1", label: "Trabajo", action: "remove" },
        summary: {
          action: '¿Sacarle la etiqueta "Trabajo" a esta conversación?',
          effects: ['Se quita la etiqueta "Trabajo".'],
        },
      },
    ];

    expect(formatBatchPrompt(batch)).toBe(
      [
        '¿Sacarle la etiqueta "Trabajo" a esta conversación?',
        "",
        'Se quita la etiqueta "Trabajo".',
      ].join("\n"),
    );
  });

  it("renders gmail_draft_reply's create summary — including the body preview through the generic items mechanism — through the unchanged renderer (09-gmail-read-then-send Phase 4)", () => {
    const batch: ApprovalRequest[] = [
      {
        tool: "gmail_draft_reply",
        args: { threadId: "thread-1", body: "El viernes me sirve." },
        summary: {
          action: "¿Guardar este borrador de respuesta?",
          target: "Para: sarah@example.com — Re: Confirmación",
          items: ["El viernes me sirve."],
          effects: ["Se guarda como borrador en Gmail. No se envía nada todavía."],
        },
      },
    ];

    expect(formatBatchPrompt(batch)).toBe(
      [
        "¿Guardar este borrador de respuesta?",
        "Para: sarah@example.com — Re: Confirmación",
        "",
        "  El viernes me sirve.",
        "",
        "Se guarda como borrador en Gmail. No se envía nada todavía.",
      ].join("\n"),
    );
  });

  it("renders gmail_draft_reply's update summary with the distinct '¿Actualizar el borrador?' action (09-gmail-read-then-send Phase 4)", () => {
    const batch: ApprovalRequest[] = [
      {
        tool: "gmail_draft_reply",
        args: { threadId: "thread-1", body: "El lunes me sirve.", draftId: "draft-1" },
        summary: {
          action: "¿Actualizar el borrador?",
          target: "Para: sarah@example.com — Re: Confirmación",
          items: ["El lunes me sirve."],
          effects: ["Se guarda como borrador en Gmail. No se envía nada todavía."],
        },
      },
    ];

    expect(formatBatchPrompt(batch)).toBe(
      [
        "¿Actualizar el borrador?",
        "Para: sarah@example.com — Re: Confirmación",
        "",
        "  El lunes me sirve.",
        "",
        "Se guarda como borrador en Gmail. No se envía nada todavía.",
      ].join("\n"),
    );
  });

  it("renders gmail_send_draft's summary — including the irreversible-send effect — through the unchanged renderer (09-gmail-read-then-send Phase 5)", () => {
    const batch: ApprovalRequest[] = [
      {
        tool: "gmail_send_draft",
        args: { draftId: "draft-1" },
        summary: {
          action: "¿Enviar este correo?",
          target: "Para: sarah@example.com — Re: Confirmación",
          items: ["El viernes me sirve."],
          effects: ["Se envía de verdad. Esto no se puede deshacer."],
        },
      },
    ];

    expect(formatBatchPrompt(batch)).toBe(
      [
        "¿Enviar este correo?",
        "Para: sarah@example.com — Re: Confirmación",
        "",
        "  El viernes me sirve.",
        "",
        "Se envía de verdad. Esto no se puede deshacer.",
      ].join("\n"),
    );
  });
});

describe("formatResolvedText", () => {
  it("appends the resolution label after the same block formatBatchPrompt produces", () => {
    const batch: ApprovalRequest[] = [{ tool: "echo", args: { text: "hi" } }];

    expect(formatResolvedText(batch, "Approved.")).toBe(
      'The model wants to run:\n- echo({"text":"hi"})\n\nApproved.',
    );
  });
});
