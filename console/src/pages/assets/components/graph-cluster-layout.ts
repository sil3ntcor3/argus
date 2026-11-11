import {
  dedupeGraph,
  placeInFreeSpots,
  type LayoutInputEdge,
  type LayoutInputNode,
  type LayoutOutputNode,
  type LayoutResult,
} from './graph-types';

type Point = LayoutOutputNode['position'];

type Family = {
  id: string;
  members: LayoutInputNode[];
  localIps: string[];
  positions: Map<string, Point>;
  radius: number;
};

const ELLIPSE_WIDTH = 1.3;
const FAMILY_GAP = 90;

function placeFamily(
  family: Family,
  primaryIp: ReadonlyMap<string, string>,
  ownersByIp: ReadonlyMap<string, string[]>,
) {
  const { members, positions, localIps } = family;
  const ipOf = (node: LayoutInputNode) => primaryIp.get(node.id) ?? '';
  members.sort(
    (a, b) =>
      ipOf(a).localeCompare(ipOf(b)) ||
      a.data.label.localeCompare(b.data.label),
  );
  const count = members.length;
  const innerRing = 140;
  let outerRing = innerRing;
  const angles = new Map<string, number>();
  const setPosition = (id: string, angle: number, r: number) => {
    positions.set(id, {
      x: Math.cos(angle) * r * ELLIPSE_WIDTH,
      y: Math.sin(angle) * r,
    });
  };

  if (family.id) positions.set(family.id, { x: 0, y: 0 });
  for (let i = 0, ring = 0; i < count; ring++) {
    outerRing = innerRing + ring * 68;
    const capacity = Math.floor((2 * Math.PI * outerRing) / 118);
    const slots = Math.min(count - i, capacity);
    for (let slot = 0; slot < slots; slot++) {
      const { id } = members[i++];
      const angle =
        -Math.PI / 2 + (2 * Math.PI * (slot + (ring % 2) * 0.5)) / slots;
      angles.set(id, angle);
      setPosition(id, angle, outerRing);
    }
  }

  for (const ip of localIps) {
    const owners = ownersByIp.get(ip)!;
    let dx = 0;
    let dy = 0;
    for (const owner of owners) {
      const angle = angles.get(owner) ?? 0;
      dx += Math.cos(angle);
      dy += Math.sin(angle);
    }
    const isHub =
      owners.length > 2 &&
      (Math.hypot(dx, dy) / owners.length < 0.6 ||
        owners.length >= count * 0.25);
    setPosition(
      ip,
      Math.atan2(dy, dx),
      isHub ? innerRing * 0.6 : outerRing + 120,
    );
  }

  for (const { x, y } of positions.values()) {
    family.radius = Math.max(family.radius, Math.abs(x) + 70, Math.abs(y) + 70);
  }
}

/**
 * Traverse shared-IP neighbors together, then pack the families onto rows.
 * Visiting each shared IP once keeps a large fan-out linear in its edges.
 */
function packFamilies(
  families: Map<string, Family>,
  groupsByIp: Map<string, string[]>,
  fixed: ReadonlyMap<string, Point>,
): Map<string, Point> {
  const ipsByGroup = new Map<string, string[]>();
  for (const [ip, groups] of groupsByIp) {
    for (const group of groups) {
      const ips = ipsByGroup.get(group);
      if (ips) ips.push(ip);
      else ipsByGroup.set(group, [ip]);
    }
  }

  const sorted = [...families.values()].sort(
    (a, b) => b.radius - a.radius || a.id.localeCompare(b.id),
  );
  const ordered: Family[] = [];
  const visited = new Set<string>();
  const visitedIps = new Set<string>();
  const enqueue = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    ordered.push(families.get(id)!);
  };
  for (const seed of sorted) {
    const start = ordered.length;
    enqueue(seed.id);
    for (let i = start; i < ordered.length; i++) {
      for (const ip of ipsByGroup.get(ordered[i].id) ?? []) {
        if (visitedIps.has(ip)) continue;
        visitedIps.add(ip);
        groupsByIp.get(ip)!.forEach(enqueue);
      }
    }
  }

  const area = sorted.reduce(
    (sum, f) => sum + (f.radius * 2 + FAMILY_GAP) ** 2,
    0,
  );
  const rowWidth = Math.max(
    (sorted[0]?.radius ?? 0) * 2 + FAMILY_GAP,
    Math.sqrt(area) * 1.2,
  );
  const positions = new Map<string, Point>();
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  let fromRight = false;
  for (const family of ordered) {
    const diameter = family.radius * 2 + FAMILY_GAP;
    if (x + diameter > rowWidth) {
      x = 0;
      y += rowHeight;
      rowHeight = 0;
      fromRight = !fromRight;
    }
    const anchor = fixed.get(family.id);
    const centerX =
      anchor?.x ?? (fromRight ? rowWidth - x - diameter / 2 : x + diameter / 2);
    const centerY = anchor?.y ?? y + diameter / 2;
    for (const [id, point] of family.positions) {
      positions.set(id, { x: centerX + point.x, y: centerY + point.y });
    }
    x += diameter;
    rowHeight = Math.max(rowHeight, diameter);
  }
  return positions;
}

type GraphInput = { nodes: LayoutInputNode[]; edges: LayoutInputEdge[] };

function readClusterGraph(graphData: GraphInput) {
  const { nodes, edges } = dedupeGraph(graphData);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const targetByAsset = new Map<string, string>();
  const primaryIp = new Map<string, string>();
  const ownersByIp = new Map<string, string[]>();
  for (const { source, target, data } of edges) {
    if (
      data?.type === 'belongs_to' &&
      byId.get(source)?.type === 'target' &&
      byId.get(target)?.type === 'asset'
    ) {
      if (!targetByAsset.has(target)) targetByAsset.set(target, source);
    }
    if (
      data?.type === 'resolves_to' &&
      byId.get(source)?.type === 'asset' &&
      byId.get(target)?.type === 'ip'
    ) {
      const owners = ownersByIp.get(target);
      if (owners) owners.push(source);
      else ownersByIp.set(target, [source]);
      const previous = primaryIp.get(source);
      if (!previous || target < previous) primaryIp.set(source, target);
    }
  }

  const familyByNode = new Map(targetByAsset);
  for (const { id, type } of nodes) {
    if (type === 'target') familyByNode.set(id, id);
  }
  const groupsByIp = new Map<string, string[]>();
  for (const [ip, owners] of ownersByIp) {
    const groups = [
      ...new Set(owners.map((id) => targetByAsset.get(id) ?? '')),
    ];
    if (groups.length > 1) groupsByIp.set(ip, groups);
    else if (groups[0]) familyByNode.set(ip, groups[0]);
  }
  return { nodes, edges, familyByNode, groupsByIp, ownersByIp, primaryIp };
}

/** Read current ownership without changing the layout or locked positions. */
export function getClusterFamilyMembership(graphData: GraphInput) {
  return readClusterGraph(graphData).familyByNode;
}

/** Target-centered families with shared addresses between their domains. */
export function applyClusterLayout(
  graphData: GraphInput,
  fixed: ReadonlyMap<string, Point> = new Map(),
): LayoutResult {
  const { nodes, edges, familyByNode, groupsByIp, ownersByIp, primaryIp } =
    readClusterGraph(graphData);
  const families = new Map<string, Family>();
  const ensureFamily = (id: string) => {
    const existing = families.get(id);
    if (existing) return existing;
    const family: Family = {
      id,
      members: [],
      localIps: [],
      positions: new Map(),
      radius: 80,
    };
    families.set(id, family);
    return family;
  };
  for (const node of nodes) {
    if (groupsByIp.has(node.id)) continue;
    const family = ensureFamily(familyByNode.get(node.id) ?? '');
    if (ownersByIp.has(node.id)) family.localIps.push(node.id);
    else if (node.type !== 'target') family.members.push(node);
  }

  for (const family of families.values())
    placeFamily(family, primaryIp, ownersByIp);
  const positions = packFamilies(families, groupsByIp, fixed);
  for (const ip of groupsByIp.keys()) {
    const owners = ownersByIp.get(ip)!;
    let x = 0;
    let y = 0;
    for (const owner of owners) {
      const point = fixed.get(owner) ?? positions.get(owner)!;
      x += point.x;
      y += point.y;
    }
    positions.set(ip, { x: x / owners.length, y: y / owners.length });
  }

  const hubs = new Map(
    nodes
      .filter(({ type }) => type === 'target')
      .map(({ id }) => [id, positions.get(id)!]),
  );
  return {
    familyByNode,
    nodes: placeInFreeSpots(
      nodes.map((node) => ({ ...node, position: positions.get(node.id)! })),
      fixed.size ? fixed : hubs,
    ),
    edges: edges.map((edge) => ({
      ...edge,
      id: `e-${edge.source}-${edge.target}`,
    })),
  };
}
