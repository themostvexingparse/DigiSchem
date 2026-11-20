/**
 * CONTRACT (owned by editor/ui module): properties inspector for the current selection
 * or document metadata when nothing is selected.
 */
import type { DocumentStore } from "../model/store";
import type { ComponentInstance, PropValue, Rotation, TextNote, Wire } from "../model/types";
import type { PropDef } from "../model/component-def";
import { propBool, propNum, propStr } from "../model/component-def";
import { getDef } from "../model/registry";
import { geometryOf } from "../model/geometry";
import { FOCUS_LABEL_EVENT } from "../editor/editor";
import {
  deleteSelectionInStore,
  mirrorSelectionInStore,
  rotateSelectionInStore,
  setComponentRotationInDoc,
  keepWiresAttached,
} from "../editor/doc-ops";

type SyncFn = () => void;

export function mountProperties(host: HTMLElement, store: DocumentStore): void {
  let currentViewKey = "";
  let syncInPlace: SyncFn | null = null;
  let selfUpdating = false;

  const runSelfUpdate = (fn: () => void) => {
    selfUpdating = true;
    try {
      fn();
    } finally {
      selfUpdating = false;
    }
  };

  const setInputIfSafe = (el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, val: string) => {
    if (selfUpdating && document.activeElement === el) return;
    if (el.value !== val) el.value = val;
  };

  const setCheckboxIfSafe = (el: HTMLInputElement, checked: boolean) => {
    if (selfUpdating && document.activeElement === el) return;
    if (el.checked !== checked) el.checked = checked;
  };

  const makeRow = (labelText: string, control: HTMLElement): HTMLDivElement => {
    const row = document.createElement("div");
    row.className = "ds-prop-row";
    const lbl = document.createElement("label");
    lbl.textContent = labelText;
    lbl.title = labelText;
    row.appendChild(lbl);
    row.appendChild(control);
    return row;
  };

  const buildDocumentView = (): SyncFn => {
    host.innerHTML = "";
    const root = document.createElement("div");
    root.className = "ds-prop";

    const hdr = document.createElement("div");
    hdr.className = "ds-prop-hdr";
    const title = document.createElement("h3");
    title.className = "ds-prop-title";
    title.textContent = "Document";
    hdr.appendChild(title);
    root.appendChild(hdr);

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.placeholder = "Untitled";
    nameInput.addEventListener("input", () => {
      const val = nameInput.value;
      runSelfUpdate(() => {
        store.update("Rename document", (draft) => {
          draft.name = val;
        });
      });
    });
    root.appendChild(makeRow("Name", nameInput));

    const metaSec = document.createElement("div");
    metaSec.className = "ds-prop-sec";
    const secTitle = document.createElement("div");
    secTitle.className = "ds-prop-sec-title";
    secTitle.textContent = "Metadata";
    metaSec.appendChild(secTitle);

    const metaFields: { key: string; label: string; placeholder: string; input: HTMLInputElement }[] = [
      { key: "author", label: "Author", placeholder: "Student name", input: document.createElement("input") },
      { key: "course", label: "Course", placeholder: "e.g. Digital Design", input: document.createElement("input") },
      { key: "lab", label: "Lab", placeholder: "e.g. Lab 3", input: document.createElement("input") },
    ];

    for (const f of metaFields) {
      f.input.type = "text";
      f.input.placeholder = f.placeholder;
      f.input.addEventListener("input", () => {
        const val = f.input.value;
        runSelfUpdate(() => {
          store.update(`Edit ${f.key}`, (draft) => {
            if (!draft.meta) draft.meta = {};
            if (val === "") delete draft.meta[f.key];
            else draft.meta[f.key] = val;
          });
        });
      });
      metaSec.appendChild(makeRow(f.label, f.input));
    }
    root.appendChild(metaSec);

    const hint = document.createElement("div");
    hint.className = "ds-prop-hint";
    hint.textContent = "Select a component, wire, or text note to edit its properties.";
    root.appendChild(hint);

    host.appendChild(root);

    return () => {
      setInputIfSafe(nameInput, store.doc.name);
      for (const f of metaFields) {
        setInputIfSafe(f.input, store.doc.meta?.[f.key] ?? "");
      }
    };
  };

  const buildComponentView = (compId: string): SyncFn => {
    const initial = store.doc.components.find((c) => c.id === compId)!;
    const def = getDef(initial.type);

    host.innerHTML = "";
    const root = document.createElement("div");
    root.className = "ds-prop";

    const hdr = document.createElement("div");
    hdr.className = "ds-prop-hdr";
    const title = document.createElement("h3");
    title.className = "ds-prop-title";
    title.textContent = def?.name ?? initial.type;
    hdr.appendChild(title);
    if (def?.category) {
      const badge = document.createElement("span");
      badge.className = "ds-prop-badge";
      badge.textContent = def.category;
      hdr.appendChild(badge);
    }
    root.appendChild(hdr);

    if (def?.description) {
      const desc = document.createElement("p");
      desc.className = "ds-prop-desc";
      desc.textContent = def.description;
      root.appendChild(desc);
    }

    // Label input
    const labelInput = document.createElement("input");
    labelInput.type = "text";
    labelInput.dataset.dsLabelInput = compId;
    labelInput.placeholder = def?.labelPrefix ? `${def.labelPrefix}1` : "Label";
    labelInput.addEventListener("input", () => {
      const val = labelInput.value;
      runSelfUpdate(() => {
        store.update("Edit label", (draft) => {
          const c = draft.components.find((x) => x.id === compId);
          if (c) c.label = val === "" ? undefined : val;
        });
      });
    });
    root.appendChild(makeRow("Label", labelInput));

    // Rotation select
    const rotSel = document.createElement("select");
    for (const r of [0, 90, 180, 270] as Rotation[]) {
      const opt = document.createElement("option");
      opt.value = String(r);
      opt.textContent = `${r}°`;
      rotSel.appendChild(opt);
    }
    rotSel.addEventListener("change", () => {
      const targetRot = Number(rotSel.value) as Rotation;
      runSelfUpdate(() => {
        store.update("Rotate component", (draft) => {
          keepWiresAttached(draft, new Set([compId]), () => setComponentRotationInDoc(draft, compId, targetRot));
        });
      });
    });
    root.appendChild(makeRow("Rotation", rotSel));

    // Mirror checkbox
    const mirrorChk = document.createElement("input");
    mirrorChk.type = "checkbox";
    mirrorChk.addEventListener("change", () => {
      const checked = mirrorChk.checked;
      runSelfUpdate(() => {
        store.update("Mirror component", (draft) => {
          keepWiresAttached(draft, new Set([compId]), () => {
            const c = draft.components.find((x) => x.id === compId);
            if (c) c.mirror = checked || undefined;
          });
        });
      });
    });
    root.appendChild(makeRow("Mirror", mirrorChk));

    // Dynamic controls for every PropDef
    const propSyncs: ((c: ComponentInstance) => void)[] = [];
    if (def && def.props.length > 0) {
      const sec = document.createElement("div");
      sec.className = "ds-prop-sec";
      const secTitle = document.createElement("div");
      secTitle.className = "ds-prop-sec-title";
      secTitle.textContent = "Parameters";
      sec.appendChild(secTitle);

      for (const pdef of def.props) {
        const { control, sync } = buildPropControl(compId, pdef, def.defaultProps[pdef.key]);
        sec.appendChild(makeRow(pdef.label, control));
        propSyncs.push(sync);
      }
      root.appendChild(sec);
    }

    const pinInfo = document.createElement("div");
    pinInfo.className = "ds-prop-hint";
    root.appendChild(pinInfo);

    host.appendChild(root);

    return () => {
      const c = store.doc.components.find((x) => x.id === compId);
      if (!c) return;
      setInputIfSafe(labelInput, c.label ?? "");
      setInputIfSafe(rotSel, String(c.rotation));
      setCheckboxIfSafe(mirrorChk, Boolean(c.mirror));
      for (const s of propSyncs) s(c);
      const g = geometryOf(c);
      pinInfo.textContent = `Pins: ${g.pins.length} · Position: (${c.x}, ${c.y})`;
    };
  };

  const buildPropControl = (
    compId: string,
    pdef: PropDef,
    defaultVal: PropValue | undefined,
  ): { control: HTMLElement; sync: (c: ComponentInstance) => void } => {
    const applyProp = (val: PropValue) => {
      runSelfUpdate(() => {
        store.update(`Set ${pdef.label}`, (draft) => {
          keepWiresAttached(draft, new Set([compId]), () => {
            const c = draft.components.find((x) => x.id === compId);
            if (c) c.props[pdef.key] = val;
          });
        });
      });
    };

    switch (pdef.kind) {
      case "int": {
        const input = document.createElement("input");
        input.type = "number";
        input.step = "1";
        if (pdef.min !== undefined) input.min = String(pdef.min);
        if (pdef.max !== undefined) input.max = String(pdef.max);

        const clampInt = (raw: string, fallback: number): number => {
          const parsed = parseInt(raw, 10);
          let n = Number.isFinite(parsed) ? parsed : fallback;
          if (pdef.min !== undefined) n = Math.max(pdef.min, n);
          if (pdef.max !== undefined) n = Math.min(pdef.max, n);
          return n;
        };

        input.addEventListener("input", () => {
          const parsed = parseInt(input.value, 10);
          if (!Number.isFinite(parsed)) return;
          if (pdef.min !== undefined && parsed < pdef.min) return;
          if (pdef.max !== undefined && parsed > pdef.max) return;
          applyProp(parsed);
        });

        input.addEventListener("change", () => {
          const cur = store.doc.components.find((x) => x.id === compId);
          const fallback = cur
            ? propNum(cur.props, pdef.key, typeof defaultVal === "number" ? defaultVal : (pdef.min ?? 0))
            : (pdef.min ?? 0);
          const clamped = clampInt(input.value, fallback);
          input.value = String(clamped);
          applyProp(clamped);
        });

        return {
          control: input,
          sync: (c) => {
            const fallback = typeof defaultVal === "number" ? defaultVal : (pdef.min ?? 0);
            const v = propNum(c.props, pdef.key, fallback);
            setInputIfSafe(input, String(v));
          },
        };
      }
      case "enum": {
        const sel = document.createElement("select");
        for (const opt of pdef.options ?? []) {
          const o = document.createElement("option");
          o.value = opt.value;
          o.textContent = opt.label;
          sel.appendChild(o);
        }
        sel.addEventListener("change", () => applyProp(sel.value));
        return {
          control: sel,
          sync: (c) => {
            const fallback = typeof defaultVal === "string" ? defaultVal : (pdef.options?.[0]?.value ?? "");
            setInputIfSafe(sel, propStr(c.props, pdef.key, fallback));
          },
        };
      }
      case "bool": {
        const chk = document.createElement("input");
        chk.type = "checkbox";
        chk.addEventListener("change", () => applyProp(chk.checked));
        return {
          control: chk,
          sync: (c) => {
            const fallback = typeof defaultVal === "boolean" ? defaultVal : false;
            setCheckboxIfSafe(chk, propBool(c.props, pdef.key, fallback));
          },
        };
      }
      case "string": {
        const input = document.createElement("input");
        input.type = "text";
        input.addEventListener("input", () => applyProp(input.value));
        return {
          control: input,
          sync: (c) => {
            const fallback = typeof defaultVal === "string" ? defaultVal : "";
            setInputIfSafe(input, propStr(c.props, pdef.key, fallback));
          },
        };
      }
    }
  };

  const buildWireView = (wireId: string): SyncFn => {
    host.innerHTML = "";
    const root = document.createElement("div");
    root.className = "ds-prop";

    const hdr = document.createElement("div");
    hdr.className = "ds-prop-hdr";
    const title = document.createElement("h3");
    title.className = "ds-prop-title";
    title.textContent = "Wire";
    hdr.appendChild(title);
    root.appendChild(hdr);

    const widthInput = document.createElement("input");
    widthInput.type = "number";
    widthInput.min = "1";
    widthInput.max = "128";
    widthInput.step = "1";

    const applyWidth = (w: number) => {
      const clamped = Math.max(1, Math.min(128, Math.round(w)));
      runSelfUpdate(() => {
        store.update("Set wire width", (draft) => {
          const target = draft.wires.find((x) => x.id === wireId);
          if (target) target.width = clamped > 1 ? clamped : undefined;
        });
      });
    };

    widthInput.addEventListener("input", () => {
      const n = parseInt(widthInput.value, 10);
      if (Number.isFinite(n) && n >= 1 && n <= 128) applyWidth(n);
    });
    widthInput.addEventListener("change", () => {
      const n = parseInt(widthInput.value, 10);
      const valid = Number.isFinite(n) ? Math.max(1, Math.min(128, n)) : 1;
      widthInput.value = String(valid);
      applyWidth(valid);
    });

    root.appendChild(makeRow("Bus width", widthInput));

    const hint = document.createElement("div");
    hint.className = "ds-prop-hint";
    hint.textContent = "Width 1 = single wire; >1 renders as a bus.";
    root.appendChild(hint);

    const actions = document.createElement("div");
    actions.className = "ds-prop-actions";
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "ds-danger";
    delBtn.textContent = "Delete";
    delBtn.onclick = () => deleteSelectionInStore(store);
    actions.appendChild(delBtn);
    root.appendChild(actions);

    host.appendChild(root);

    return () => {
      const w: Wire | undefined = store.doc.wires.find((x) => x.id === wireId);
      if (!w) return;
      setInputIfSafe(widthInput, String(w.width ?? 1));
    };
  };

  const buildTextView = (textId: string): SyncFn => {
    host.innerHTML = "";
    const root = document.createElement("div");
    root.className = "ds-prop";

    const hdr = document.createElement("div");
    hdr.className = "ds-prop-hdr";
    const title = document.createElement("h3");
    title.className = "ds-prop-title";
    title.textContent = "Text Note";
    hdr.appendChild(title);
    root.appendChild(hdr);

    const col = document.createElement("div");
    col.className = "ds-prop-col";
    const lbl = document.createElement("label");
    lbl.textContent = "Text";
    const ta = document.createElement("textarea");
    ta.className = "ds-prop-textarea";
    ta.rows = 4;
    ta.addEventListener("input", () => {
      const val = ta.value;
      runSelfUpdate(() => {
        store.update("Edit text note", (draft) => {
          const target = draft.texts.find((x) => x.id === textId);
          if (target) target.text = val;
        });
      });
    });
    col.appendChild(lbl);
    col.appendChild(ta);
    root.appendChild(col);

    const sizeInput = document.createElement("input");
    sizeInput.type = "number";
    sizeInput.min = "8";
    sizeInput.max = "72";
    sizeInput.step = "1";

    const applySize = (n: number) => {
      const clamped = Math.max(8, Math.min(72, Math.round(n)));
      runSelfUpdate(() => {
        store.update("Set font size", (draft) => {
          const target = draft.texts.find((x) => x.id === textId);
          if (target) target.fontSize = clamped;
        });
      });
    };

    sizeInput.addEventListener("input", () => {
      const n = parseInt(sizeInput.value, 10);
      if (Number.isFinite(n) && n >= 8 && n <= 72) applySize(n);
    });
    sizeInput.addEventListener("change", () => {
      const n = parseInt(sizeInput.value, 10);
      const valid = Number.isFinite(n) ? Math.max(8, Math.min(72, n)) : 14;
      sizeInput.value = String(valid);
      applySize(valid);
    });
    root.appendChild(makeRow("Font size", sizeInput));

    const actions = document.createElement("div");
    actions.className = "ds-prop-actions";
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "ds-danger";
    delBtn.textContent = "Delete";
    delBtn.onclick = () => deleteSelectionInStore(store);
    actions.appendChild(delBtn);
    root.appendChild(actions);

    host.appendChild(root);

    return () => {
      const t: TextNote | undefined = store.doc.texts.find((x) => x.id === textId);
      if (!t) return;
      setInputIfSafe(ta, t.text);
      setInputIfSafe(sizeInput, String(t.fontSize ?? 14));
    };
  };

  const buildMultiView = (): SyncFn => {
    host.innerHTML = "";
    const root = document.createElement("div");
    root.className = "ds-prop";

    const hdr = document.createElement("div");
    hdr.className = "ds-prop-hdr";
    const title = document.createElement("h3");
    title.className = "ds-prop-title";
    hdr.appendChild(title);
    root.appendChild(hdr);

    const summary = document.createElement("div");
    summary.className = "ds-prop-hint";
    root.appendChild(summary);

    const actions = document.createElement("div");
    actions.className = "ds-prop-actions";

    const rotBtn = document.createElement("button");
    rotBtn.type = "button";
    rotBtn.textContent = "Rotate 90°";
    rotBtn.onclick = () => rotateSelectionInStore(store);

    const mirBtn = document.createElement("button");
    mirBtn.type = "button";
    mirBtn.textContent = "Mirror";
    mirBtn.onclick = () => mirrorSelectionInStore(store);

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "ds-danger";
    delBtn.textContent = "Delete";
    delBtn.onclick = () => deleteSelectionInStore(store);

    actions.appendChild(rotBtn);
    actions.appendChild(mirBtn);
    actions.appendChild(delBtn);
    root.appendChild(actions);

    host.appendChild(root);

    return () => {
      const sel = store.selection;
      title.textContent = `${sel.size} selected`;
      let nc = 0;
      let nw = 0;
      let nt = 0;
      for (const c of store.doc.components) if (sel.has(c.id)) nc++;
      for (const w of store.doc.wires) if (sel.has(w.id)) nw++;
      for (const t of store.doc.texts) if (sel.has(t.id)) nt++;
      const parts: string[] = [];
      if (nc) parts.push(`${nc} component${nc === 1 ? "" : "s"}`);
      if (nw) parts.push(`${nw} wire${nw === 1 ? "" : "s"}`);
      if (nt) parts.push(`${nt} text note${nt === 1 ? "" : "s"}`);
      summary.textContent = parts.join(", ");
    };
  };

  const render = () => {
    const sel = store.selection;
    let nextKey = "doc";
    let builder: (() => SyncFn) | null = null;

    if (sel.size === 0) {
      nextKey = "doc";
      builder = buildDocumentView;
    } else if (sel.size === 1) {
      const [id] = sel;
      const comp = store.doc.components.find((c) => c.id === id);
      if (comp) {
        nextKey = `comp:${comp.id}:${comp.type}`;
        builder = () => buildComponentView(comp.id);
      } else if (store.doc.wires.some((w) => w.id === id)) {
        nextKey = `wire:${id}`;
        builder = () => buildWireView(id);
      } else if (store.doc.texts.some((t) => t.id === id)) {
        nextKey = `text:${id}`;
        builder = () => buildTextView(id);
      } else {
        nextKey = "doc";
        builder = buildDocumentView;
      }
    } else {
      nextKey = "multi";
      builder = buildMultiView;
    }

    if (nextKey !== currentViewKey) {
      currentViewKey = nextKey;
      syncInPlace = builder();
    }
    syncInPlace?.();
  };

  // Focus label input when user double-clicks a component on the canvas
  window.addEventListener(FOCUS_LABEL_EVENT, (ev) => {
    const detail = (ev as CustomEvent<{ id?: string }>).detail;
    const id = detail?.id;
    if (!id || !host.isConnected) return;
    if (store.selection.size !== 1 || !store.selection.has(id)) return;
    render();
    const inputs = host.querySelectorAll<HTMLInputElement>("input[data-ds-label-input]");
    const labelInput =
      Array.from(inputs).find((el) => el.dataset.dsLabelInput === id) ?? inputs[0] ?? null;
    if (labelInput) {
      labelInput.focus();
      labelInput.select();
    }
  });

  store.subscribe(render);
  render();
}
