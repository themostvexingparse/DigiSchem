/** Seeded random networks of transistors, tri-state buffers, pulls and gates (no feedback). */
import type { SchematicDocument, PropValue } from "../../src/model/types";
import { mkDoc, Rng, type PartSpec } from "./sim-gen";

export interface GeneratedXrefCircuit {
  seed: number;
  kind: string;
  doc: SchematicDocument;
  inputIds: string[];
  outputIds: string[];
}

const GATE_TYPES = ["and", "or", "nand", "nor", "xor", "xnor", "not", "buf"] as const;

/**
 * Generates a strictly acyclic mixed schematic containing:
 * - 2..6 input pins, optional vcc/ground/constant/pull-up/pull-down
 * - 2..40 transistors (nmos, pmos, transmission-gate)
 * - 0..20 gates
 * - 0..4 tristates
 * - 1..6 output pins
 *
 * Acyclicity is enforced by strict layering: every gate input and every transistor gate pin
 * connects only to signals from strictly earlier layers, and switch channels only join nodes
 * within the current layer (plus layer-0 ideal supply rails, which never change value).
 */
export function generateRandomXrefCircuit(seed: number): GeneratedXrefCircuit {
  const rng = new Rng(seed);
  const parts: PartSpec[] = [];
  const nets: string[][] = [];
  let seq = 0;

  // Each net has an index into `nets`
  const newNet = (initialPins: string[] = []): number => {
    const id = nets.length;
    nets.push([...initialPins]);
    return id;
  };
  const attach = (netIdx: number, pin: string) => {
    nets[netIdx].push(pin);
  };

  // Layer 0: inputs + supplies
  const numInputs = rng.int(2, 6);
  const inputIds: string[] = [];
  const supplyNets: number[] = [];
  const prevLayerNets: number[] = [];

  for (let i = 0; i < numInputs; i++) {
    const id = `IN${i}`;
    inputIds.push(id);
    parts.push([id, "input-pin", { name: id, width: 1 }]);
    const n = newNet([`${id}.out`]);
    supplyNets.push(n);
    prevLayerNets.push(n);
  }

  // Always add VDD and GND nets (available as rails)
  parts.push(["VDD", "vcc"]);
  const vddNet = newNet(["VDD.vcc"]);
  supplyNets.push(vddNet);

  parts.push(["GND", "ground"]);
  const gndNet = newNet(["GND.gnd"]);
  supplyNets.push(gndNet);

  // Optional constants
  const numConst = rng.int(0, 2);
  for (let i = 0; i < numConst; i++) {
    const id = `K${i}`;
    const val = rng.bool(0.5) ? "1" : "0";
    parts.push([id, "constant", { value: val, width: 1 }]);
    const n = newNet([`${id}.out`]);
    supplyNets.push(n);
    prevLayerNets.push(n);
  }

  const targetTx = rng.int(2, 40);
  const targetGates = rng.int(0, 20);
  const targetTri = rng.int(0, 4);
  const numOutputs = rng.int(1, 6);

  let txCount = 0;
  let gateCount = 0;
  let triCount = 0;

  const pickPrev = (): number => rng.pick(prevLayerNets);
  const pickPrevOrFloat = (floatProb = 0.06): number => {
    if (rng.bool(floatProb)) return newNet(); // floating net!
    return rng.pick(prevLayerNets);
  };

  const addMos = (type: "nmos" | "pmos", gNet: number, dNet: number, sNet: number) => {
    const id = `M${seq++}`;
    parts.push([id, type]);
    attach(gNet, `${id}.g`);
    attach(dNet, `${id}.d`);
    attach(sNet, `${id}.s`);
    txCount++;
  };

  const addTG = (enNet: number, enbNet: number, aNet: number, bNet: number) => {
    const id = `TG${seq++}`;
    parts.push([id, "transmission-gate"]);
    attach(enNet, `${id}.en`);
    attach(enbNet, `${id}.enb`);
    attach(aNet, `${id}.a`);
    attach(bNet, `${id}.b`);
    txCount++;
  };

  const addPull = (netIdx: number, up: boolean) => {
    const id = `R${seq++}`;
    parts.push([id, up ? "pull-up" : "pull-down"]);
    attach(netIdx, `${id}.out`);
  };

  const addGate = (outNet: number) => {
    const kind = rng.pick(GATE_TYPES);
    const id = `G${seq++}`;
    if (kind === "not" || kind === "buf") {
      parts.push([id, kind]);
      attach(pickPrevOrFloat(0.05), `${id}.in0`);
    } else {
      const nIn = rng.int(2, 4);
      parts.push([id, kind, { inputs: nIn }]);
      for (let i = 0; i < nIn; i++) {
        attach(pickPrevOrFloat(0.04), `${id}.in${i}`);
      }
    }
    attach(outNet, `${id}.out`);
    gateCount++;
  };

  const addTristate = (outNet: number) => {
    const id = `T${seq++}`;
    const activeLowEnable = rng.bool(0.5);
    const invertedOut = rng.bool(0.5);
    parts.push([id, "tristate", { width: 1, activeLowEnable, invertedOut }]);
    attach(pickPrevOrFloat(0.05), `${id}.in`);
    attach(pickPrevOrFloat(0.08), `${id}.en`);
    attach(outNet, `${id}.out`);
    triCount++;
  };

  // Pick a flavor / mix of archetypes across 2..5 layers
  const archetype = rng.pick(["mixed", "cmos", "pass-chain", "tg-mux", "shorted", "floating"]);
  const numLayers = rng.int(2, 5);
  const allOutputCandidates: number[] = [];

  for (let layer = 0; layer < numLayers; layer++) {
    const layerNets: number[] = [];

    // 1. Add some logic gates and tristates in this layer (driving fresh layer nets,
    //    or occasionally sharing a layer net for contention / bus muxing)
    const gatesHere = layer === numLayers - 1 ? targetGates - gateCount : rng.int(0, Math.max(0, targetGates - gateCount));
    for (let g = 0; g < gatesHere; g++) {
      const share = layerNets.length > 0 && rng.bool(archetype === "shorted" ? 0.35 : 0.08);
      const outNet = share ? rng.pick(layerNets) : newNet();
      if (!share) layerNets.push(outNet);
      addGate(outNet);
    }

    const trisHere = layer === numLayers - 1 ? targetTri - triCount : rng.int(0, Math.max(0, targetTri - triCount));
    for (let t = 0; t < trisHere; t++) {
      const share = layerNets.length > 0 && rng.bool(0.5);
      const outNet = share ? rng.pick(layerNets) : newNet();
      if (!share) layerNets.push(outNet);
      addTristate(outNet);
    }

    // 2. Add transistor structures in this layer
    const txBudget = layer === numLayers - 1 ? targetTx - txCount : rng.int(0, Math.max(0, targetTx - txCount));
    if (txBudget > 0) {
      const mode =
        archetype === "mixed"
          ? rng.pick(["cmos-inv", "cmos-nand", "cmos-nor", "pass-chain", "tg-mux", "random-mesh"])
          : archetype === "cmos"
            ? rng.pick(["cmos-inv", "cmos-nand", "cmos-nor"])
            : archetype === "pass-chain"
              ? "pass-chain"
              : archetype === "tg-mux"
                ? "tg-mux"
                : "random-mesh";

      if (mode === "cmos-inv" && txBudget >= 2) {
        const a = pickPrev();
        const y = newNet();
        addMos("pmos", a, y, vddNet);
        addMos("nmos", a, y, gndNet);
        layerNets.push(y);
      } else if (mode === "cmos-nand" && txBudget >= 4) {
        const a = pickPrev();
        const b = pickPrev();
        const y = newNet();
        const mid = newNet();
        addMos("pmos", a, y, vddNet);
        addMos("pmos", b, y, vddNet);
        addMos("nmos", a, y, mid);
        addMos("nmos", b, mid, gndNet);
        layerNets.push(y, mid);
      } else if (mode === "cmos-nor" && txBudget >= 4) {
        const a = pickPrev();
        const b = pickPrev();
        const y = newNet();
        const mid = newNet();
        addMos("pmos", a, mid, vddNet);
        addMos("pmos", b, y, mid);
        addMos("nmos", a, y, gndNet);
        addMos("nmos", b, y, gndNet);
        layerNets.push(y, mid);
      } else if (mode === "tg-mux" && txBudget >= 2) {
        const sel = pickPrev();
        // Inverted select (via a NOT gate if gate budget allows, else random prev)
        let selBar: number;
        if (rng.bool(0.75)) {
          selBar = newNet();
          const invId = `INV${seq++}`;
          parts.push([invId, "not"]);
          attach(sel, `${invId}.in0`);
          attach(selBar, `${invId}.out`);
          // NOTE: selBar is in this layer's control? Wait — selBar must be in an earlier layer
          // than TG so there's no cycle. Since sel is from prevLayer and selBar is ONLY driven by INV
          // (no switch touches selBar), selBar is strictly acyclic!
        } else {
          selBar = pickPrevOrFloat(0.15);
        }
        const d0 = rng.pick(supplyNets);
        const d1 = rng.pick(supplyNets);
        const y = newNet();
        addTG(selBar, sel, d0, y);
        addTG(sel, selBar, d1, y);
        if (rng.bool(0.3)) addPull(y, rng.bool(0.5));
        layerNets.push(y);
      } else if (mode === "pass-chain") {
        const len = Math.min(txBudget, rng.int(2, 8));
        let cur = rng.bool(0.7) ? rng.pick(supplyNets) : newNet();
        if (!supplyNets.includes(cur)) {
          layerNets.push(cur);
          if (rng.bool(0.5)) addPull(cur, rng.bool(0.5));
        }
        for (let k = 0; k < len; k++) {
          const nxt = k === len - 1 && rng.bool(0.25) ? rng.pick(supplyNets) : newNet();
          if (!supplyNets.includes(nxt)) layerNets.push(nxt);
          const swKind = rng.pick(["nmos", "pmos", "tg"] as const);
          if (swKind === "tg") {
            addTG(pickPrevOrFloat(0.08), pickPrevOrFloat(0.08), cur, nxt);
          } else {
            addMos(swKind, pickPrevOrFloat(0.08), cur, nxt);
          }
          if (!supplyNets.includes(nxt) && rng.bool(0.25)) addPull(nxt, rng.bool(0.5));
          cur = nxt;
        }
      } else {
        // Random switch mesh over local layer nodes + supplies
        const localNodes: number[] = [...layerNets];
        const extraNodes = rng.int(2, Math.max(2, Math.min(10, txBudget + 1)));
        for (let i = 0; i < extraNodes; i++) {
          const nn = newNet();
          localNodes.push(nn);
          layerNets.push(nn);
          if (rng.bool(0.3)) addPull(nn, rng.bool(0.5));
          if (rng.bool(0.15) && archetype === "shorted") addPull(nn, rng.bool(0.5));
        }
        const pool = [...localNodes, ...supplyNets];
        const count = Math.min(txBudget, rng.int(2, Math.max(2, txBudget)));
        for (let k = 0; k < count; k++) {
          let a = rng.pick(pool);
          let b = rng.pick(pool);
          if (a === b) b = rng.pick(localNodes);
          // Optionally allow direct supply-to-supply switch in shorted/mixed mode
          if (supplyNets.includes(a) && supplyNets.includes(b) && archetype !== "shorted" && rng.bool(0.8)) {
            b = rng.pick(localNodes);
          }
          const swKind = rng.pick(["nmos", "pmos", "tg"] as const);
          if (swKind === "tg") {
            addTG(pickPrevOrFloat(0.08), pickPrevOrFloat(0.08), a, b);
          } else {
            addMos(swKind, pickPrevOrFloat(0.08), a, b);
          }
        }
      }
    }

    // Add optional pulls on some layer nets
    for (const ln of layerNets) {
      if (rng.bool(0.12)) addPull(ln, rng.bool(0.5));
    }

    for (const ln of layerNets) {
      prevLayerNets.push(ln);
      allOutputCandidates.push(ln);
    }
  }

  // Ensure at least 2 transistors exist
  while (txCount < 2) {
    const y = newNet();
    addMos(rng.bool(0.5) ? "nmos" : "pmos", pickPrev(), rng.pick(supplyNets), y);
    allOutputCandidates.push(y);
  }

  // Wire 1..6 output pins (including occasional floating outputs)
  const outputIds: string[] = [];
  const shuffled = rng.shuffle(allOutputCandidates);
  for (let i = 0; i < numOutputs; i++) {
    const id = `Y${i}`;
    outputIds.push(id);
    parts.push([id, "output-pin", { name: id, width: 1 }]);
    if (archetype === "floating" && i === numOutputs - 1 && rng.bool(0.6)) {
      // Leave floating (unconnected)
      continue;
    }
    const target = shuffled[i % shuffled.length] ?? newNet();
    attach(target, `${id}.in`);
  }

  return {
    seed,
    kind: archetype,
    doc: mkDoc(parts, nets, `xref_${seed}_${archetype}`),
    inputIds,
    outputIds,
  };
}

