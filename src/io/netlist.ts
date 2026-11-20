/**
 * Geometric connectivity netlist extractor using Union-Find.
 *
 * Connectivity rules:
 *  - All vertices/segments of a single wire are connected.
 *  - Two wires sharing a vertex connect.
 *  - A wire endpoint lying on another wire's segment (T-junction) connects.
 *  - Crossing wires WITHOUT a shared vertex or endpoint do NOT connect.
 *  - Component pins coinciding with a wire vertex or lying on a wire segment connect.
 *  - Component pins at identical world coordinates connect directly.
 *  - Components of type "tunnel" with the same non-empty prop "name" join their nets.
 */
import type { ComponentInstance, Point, SchematicDocument, Wire } from "../model/types";
import { propStr } from "../model/component-def";
import { getDef } from "../model/registry";
import { pointOnSegment, wireSegments, worldPins, type WorldPin } from "../model/geometry";

export interface NetPin {
  componentId: string;
  pinId: string;
}

export interface Net {
  /** Unique net identifier (e.g. "N1" or tunnel name). */
  id: string;
  /** Human-readable net name (tunnel name if joined by tunnels, otherwise `id`). */
  name: string;
  /** Member component pins connected to this net. */
  pins: NetPin[];
  /** Member wire IDs connected to this net. */
  wires: string[];
  /** Distinct tunnel names participating in this net. */
  tunnels: string[];
  /** Effective bus width (max of connected wire/pin widths, default 1). */
  width: number;
}

export interface Netlist {
  nets: Net[];
}

class UnionFind {
  private parent: number[];
  private rank: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
    this.rank = new Array<number>(size).fill(0);
  }

  find(x: number): number {
    let root = x;
    while (this.parent[root] !== root) {
      root = this.parent[root];
    }
    let curr = x;
    while (curr !== root) {
      const next = this.parent[curr];
      this.parent[curr] = root;
      curr = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    if (this.rank[ra] < this.rank[rb]) {
      this.parent[ra] = rb;
    } else if (this.rank[ra] > this.rank[rb]) {
      this.parent[rb] = ra;
    } else {
      this.parent[rb] = ra;
      this.rank[ra] += 1;
    }
  }
}

function ptKey(p: Point): string {
  return `${p.x},${p.y}`;
}

interface IndexedWire {
  node: number;
  wire: Wire;
  segments: [Point, Point][];
  endpoints: [Point, Point];
}

interface IndexedPin {
  node: number;
  worldPin: WorldPin;
  component: ComponentInstance;
}

/**
 * Extract electrical nets from a schematic document via geometric connectivity + tunnels.
 */
export function buildNetlist(doc: SchematicDocument): Netlist {
  const indexedWires: IndexedWire[] = [];
  for (const wire of doc.wires) {
    if (wire.points.length < 2) continue;
    indexedWires.push({
      node: indexedWires.length,
      wire,
      segments: wireSegments(wire),
      endpoints: [wire.points[0], wire.points[wire.points.length - 1]],
    });
  }

  const wireCount = indexedWires.length;
  const indexedPins: IndexedPin[] = [];
  for (const comp of doc.components) {
    for (const wp of worldPins(comp)) {
      indexedPins.push({
        node: wireCount + indexedPins.length,
        worldPin: wp,
        component: comp,
      });
    }
  }

  const uf = new UnionFind(wireCount + indexedPins.length);

  // 1. Wires sharing any vertex connect.
  const vertexToWire = new Map<string, number>();
  for (const iw of indexedWires) {
    for (const p of iw.wire.points) {
      const k = ptKey(p);
      const existing = vertexToWire.get(k);
      if (existing !== undefined) {
        uf.union(iw.node, existing);
      } else {
        vertexToWire.set(k, iw.node);
      }
    }
  }

  // 2. T-junctions: a wire's endpoint lying on another wire's segment connects them.
  // Crossing wires without a shared vertex or endpoint do NOT connect.
  for (let i = 0; i < indexedWires.length; i++) {
    const a = indexedWires[i];
    for (let j = 0; j < indexedWires.length; j++) {
      if (i === j || uf.find(a.node) === uf.find(indexedWires[j].node)) continue;
      const b = indexedWires[j];
      const [ep0, ep1] = a.endpoints;
      for (const [s0, s1] of b.segments) {
        if (pointOnSegment(ep0, s0, s1) || pointOnSegment(ep1, s0, s1)) {
          uf.union(a.node, b.node);
          break;
        }
      }
    }
  }

  // 3. Pins at the same world point connect; pins at wire vertices or on wire segments connect.
  const pinPosToNode = new Map<string, number>();
  for (const ip of indexedPins) {
    const pos = ip.worldPin.pos;
    const k = ptKey(pos);

    const existingPin = pinPosToNode.get(k);
    if (existingPin !== undefined) {
      uf.union(ip.node, existingPin);
    } else {
      pinPosToNode.set(k, ip.node);
    }

    const wireAtVertex = vertexToWire.get(k);
    if (wireAtVertex !== undefined) {
      uf.union(ip.node, wireAtVertex);
    }

    for (const iw of indexedWires) {
      if (uf.find(ip.node) === uf.find(iw.node)) continue;
      for (const [s0, s1] of iw.segments) {
        if (pointOnSegment(pos, s0, s1)) {
          uf.union(ip.node, iw.node);
          break;
        }
      }
    }
  }

  // 4. Components of type "tunnel" with the same non-empty prop "name" join their nets.
  const tunnelFirstNode = new Map<string, number>();
  const tunnelNameByNode = new Map<number, string>();
  for (const ip of indexedPins) {
    if (ip.component.type !== "tunnel") continue;
    const name = propStr(ip.component.props, "name", "").trim();
    if (!name) continue;
    tunnelNameByNode.set(ip.node, name);
    const first = tunnelFirstNode.get(name);
    if (first !== undefined) {
      uf.union(ip.node, first);
    } else {
      tunnelFirstNode.set(name, ip.node);
    }
  }

  // 5. Group wires, pins, and tunnel names by Union-Find root in stable document order.
  interface Bucket {
    pins: NetPin[];
    wires: string[];
    tunnels: Set<string>;
    width: number;
  }
  const buckets = new Map<number, Bucket>();
  const getBucket = (root: number): Bucket => {
    let b = buckets.get(root);
    if (!b) {
      b = { pins: [], wires: [], tunnels: new Set<string>(), width: 1 };
      buckets.set(root, b);
    }
    return b;
  };

  for (const iw of indexedWires) {
    const b = getBucket(uf.find(iw.node));
    b.wires.push(iw.wire.id);
    if (iw.wire.width && iw.wire.width > b.width) {
      b.width = iw.wire.width;
    }
  }

  for (const ip of indexedPins) {
    const b = getBucket(uf.find(ip.node));
    b.pins.push({ componentId: ip.worldPin.componentId, pinId: ip.worldPin.pin.id });
    if (ip.worldPin.pin.width && ip.worldPin.pin.width > b.width) {
      b.width = ip.worldPin.pin.width;
    }
    const tName = tunnelNameByNode.get(ip.node);
    if (tName) {
      b.tunnels.add(tName);
    }
  }

  // Reserve explicit tunnel names so auto-generated N1, N2... never collide with them.
  const usedNames = new Set<string>();
  for (const b of buckets.values()) {
    if (b.tunnels.size > 0) {
      const sorted = [...b.tunnels].sort();
      usedNames.add(sorted.join("/"));
    }
  }

  let autoCounter = 1;
  const nextAutoName = (): string => {
    while (usedNames.has(`N${autoCounter}`)) {
      autoCounter += 1;
    }
    const name = `N${autoCounter}`;
    usedNames.add(name);
    autoCounter += 1;
    return name;
  };

  const nets: Net[] = [];
  for (const b of buckets.values()) {
    const tunnels = [...b.tunnels].sort();
    const netName = tunnels.length > 0 ? tunnels.join("/") : nextAutoName();
    nets.push({
      id: netName,
      name: netName,
      pins: b.pins,
      wires: b.wires,
      tunnels,
      width: b.width,
    });
  }

  return { nets };
}

/**
 * Format the schematic netlist as human-readable text, one net per line,
 * using component labels (falling back to component id) and pin names (falling back to pinId).
 */
export function exportNetlistText(doc: SchematicDocument): string {
  const { nets } = buildNetlist(doc);
  if (nets.length === 0) return "";

  const compById = new Map<string, ComponentInstance>();
  for (const c of doc.components) compById.set(c.id, c);

  const pinNameCache = new Map<string, Map<string, string>>();
  const resolvePinName = (comp: ComponentInstance, pinId: string): string => {
    let map = pinNameCache.get(comp.id);
    if (!map) {
      map = new Map<string, string>();
      const def = getDef(comp.type);
      if (def) {
        const g = def.geometry({ ...def.defaultProps, ...comp.props });
        for (const p of g.pins) map.set(p.id, p.name);
      }
      pinNameCache.set(comp.id, map);
    }
    return map.get(pinId) ?? pinId;
  };

  const lines: string[] = [];
  for (const net of nets) {
    const pinTokens = net.pins.map((np) => {
      const comp = compById.get(np.componentId);
      const compLabel = comp?.label && comp.label.trim().length > 0 ? comp.label : np.componentId;
      const pinName = comp ? resolvePinName(comp, np.pinId) : np.pinId;
      return `${compLabel}.${pinName}`;
    });
    const widthTag = net.width > 1 ? ` [${net.width}]` : "";
    if (pinTokens.length > 0) {
      lines.push(`${net.name}${widthTag}: ${pinTokens.join(", ")}`);
    } else {
      lines.push(`${net.name}${widthTag}: (wires: ${net.wires.join(", ")})`);
    }
  }
  return lines.join("\n");
}

/**
 * Export the schematic netlist as pretty-printed JSON.
 */
export function exportNetlistJson(doc: SchematicDocument): string {
  return JSON.stringify(buildNetlist(doc), null, 2) + "\n";
}
