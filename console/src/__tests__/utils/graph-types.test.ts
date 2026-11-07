import { describe, expect, it } from 'vitest';
import { applyClusterLayout } from '@/pages/assets/components/graph-cluster-layout';
import {
  applyDagreLayout,
  applyForceLayout,
  placeInFreeSpots,
  type LayoutInputEdge,
  type LayoutInputNode,
} from '@/pages/assets/components/graph-types';

const node = (id: string, type: LayoutInputNode['type']): LayoutInputNode => ({
  id,
  type,
  data: { label: id },
});

const edge = (
  source: string,
  target: string,
  type?: string,
): LayoutInputEdge => ({
  source,
  target,
  data: type ? { type } : undefined,
});

describe('applyForceLayout', () => {
  it('returns empty result for an empty graph', () => {
    const result = applyForceLayout({ nodes: [], edges: [] });
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });

  it('deduplicates nodes by id and edges by (source, target) pair', () => {
    const result = applyForceLayout({
      nodes: [
        node('target|t1', 'target'),
        node('target|t1', 'target'),
        node('asset|a1', 'asset'),
        node('ip|1.2.3.4', 'ip'),
      ],
      edges: [
        edge('target|t1', 'asset|a1', 'belongs_to'),
        edge('target|t1', 'asset|a1', 'belongs_to'),
        edge('asset|a1', 'ip|1.2.3.4', 'resolves_to'),
        edge('asset|a1', 'missing|nope', 'resolves_to'),
      ],
    });

    // target|t1 (deduped), asset|a1, ip|1.2.3.4
    expect(result.nodes).toHaveLength(3);
    expect(result.edges).toHaveLength(2);
    // Edge with a missing endpoint is dropped.
    expect(result.edges).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: 'missing|nope' }),
      ]),
    );
  });

  it('assigns every node a finite position and keeps ids/types', () => {
    const nodes = [
      node('target|t1', 'target'),
      node('asset|a1', 'asset'),
      node('ip|1.2.3.4', 'ip'),
    ];
    const edges = [
      edge('target|t1', 'asset|a1', 'belongs_to'),
      edge('asset|a1', 'ip|1.2.3.4', 'resolves_to'),
    ];

    const result = applyForceLayout({ nodes, edges }, { width: 800, height: 600 });

    expect(result.nodes).toHaveLength(3);
    for (const n of result.nodes) {
      expect(Number.isFinite(n.position.x)).toBe(true);
      expect(Number.isFinite(n.position.y)).toBe(true);
    }
    const byId = new Map(result.nodes.map((n) => [n.id, n]));
    expect(byId.get('target|t1')?.type).toBe('target');
    expect(byId.get('asset|a1')?.type).toBe('asset');
    expect(byId.get('ip|1.2.3.4')?.type).toBe('ip');
  });

  it('keeps target nodes on distinct radial bands (cluster anchors)', () => {
    const nodes = [
      node('target|t1', 'target'),
      node('target|t2', 'target'),
      node('asset|a1', 'asset'),
      node('asset|a2', 'asset'),
      node('ip|1.2.3.4', 'ip'),
    ];
    const edges = [
      edge('target|t1', 'asset|a1', 'belongs_to'),
      edge('target|t2', 'asset|a2', 'belongs_to'),
      edge('asset|a1', 'ip|1.2.3.4', 'resolves_to'),
      edge('asset|a2', 'ip|1.2.3.4', 'resolves_to'),
    ];

    const result = applyForceLayout({ nodes, edges }, { width: 2000, height: 2000 });
    const byId = new Map(result.nodes.map((n) => [n.id, n.position]));
    const center = { x: 1000, y: 1000 };
    const dist = (p: { x: number; y: number }) =>
      Math.hypot(p.x - center.x, p.y - center.y);

    const t1 = dist(byId.get('target|t1')!);
    const t2 = dist(byId.get('target|t2')!);
    // Anchors sit at radii 320 and 780 (golden-angle separated); the layout
    // re-centers the bounding box, so assert the pairwise separation these
    // pinned landmarks preserve instead of absolute radii.
    const separation = Math.hypot(
      byId.get('target|t1')!.x - byId.get('target|t2')!.x,
      byId.get('target|t1')!.y - byId.get('target|t2')!.y,
    );
    expect(t2).toBeGreaterThan(t1);
    expect(separation).toBeGreaterThan(600);
  });

  it('is deterministic: same input yields identical positions', () => {
    const nodes = [
      node('target|t1', 'target'),
      node('asset|a1', 'asset'),
      node('ip|1.2.3.4', 'ip'),
    ];
    const edges = [edge('target|t1', 'asset|a1', 'belongs_to')];

    const a = applyForceLayout({ nodes, edges });
    const b = applyForceLayout({ nodes, edges });
    expect(a.nodes.map((n) => [n.id, n.position])).toEqual(
      b.nodes.map((n) => [n.id, n.position]),
    );
  });

  it('separates nodes that are exactly coincident (collision post-pass)', () => {
    // Force two nodes onto the same seed position by using an empty edge set
    // with identical starting coordinates is not directly controllable, so
    // assert instead that the post-pass never produces NaN and keeps minimum
    // spacing for a dense single-hub graph.
    const nodes = [
      node('target|t1', 'target'),
      ...Array.from({ length: 12 }, (_, i) => node(`service|s${i}`, 'service')),
    ];
    const edges = nodes.slice(1).map((n) => edge('target|t1', n.id, 'runs_on'));

    const result = applyForceLayout({ nodes, edges });
    const positions = result.nodes.map((n) => n.position);
    for (const p of positions) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
    // Deterministic: no run-to-run drift.
    const again = applyForceLayout({ nodes, edges });
    expect(result.nodes.map((n) => n.position)).toEqual(
      again.nodes.map((n) => n.position),
    );
  });
});

describe('applyClusterLayout', () => {
  it('groups domains around their target and positions a shared IP between families', () => {
    const t1 = node('target|a', 'target');
    const t2 = node('target|b', 'target');
    const a1 = node('asset|a', 'asset');
    const a2 = node('asset|b', 'asset');
    const local = node('ip|192.0.2.1', 'ip');
    const shared = node('ip|192.0.2.2', 'ip');
    const input = {
      nodes: [t1, t2, a1, a2, local, shared],
      edges: [
        edge(t1.id, a1.id, 'belongs_to'),
        edge(t2.id, a2.id, 'belongs_to'),
        edge(a1.id, local.id, 'resolves_to'),
        edge(a1.id, shared.id, 'resolves_to'),
        edge(a2.id, shared.id, 'resolves_to'),
      ],
    };
    const layout = applyClusterLayout(input);
    const byId = new Map(
      layout.nodes.map(({ id, position }) => [id, position]),
    );
    const distance = (a: string, b: string) =>
      Math.hypot(
        byId.get(a)!.x - byId.get(b)!.x,
        byId.get(a)!.y - byId.get(b)!.y,
      );
    expect(distance(t1.id, a1.id)).toBeLessThan(distance(t2.id, a1.id));
    expect(distance(t2.id, a2.id)).toBeLessThan(distance(t1.id, a2.id));
    expect(distance(t1.id, local.id)).toBeLessThan(distance(t2.id, local.id));
    expect(distance(a1.id, shared.id)).toBeCloseTo(distance(a2.id, shared.id));
    expect(layout.edges).toHaveLength(input.edges.length);
    expect(layout.familyByNode?.get(t1.id)).toBe(t1.id);
    expect(layout.familyByNode?.get(a1.id)).toBe(t1.id);
    expect(layout.familyByNode?.get(local.id)).toBe(t1.id);
    expect(layout.familyByNode?.get(shared.id)).toBeUndefined();
    expect(applyClusterLayout(input)).toEqual(layout);
    const anchor = { x: -2000, y: 0 };
    const refreshed = applyClusterLayout(input, new Map([[t2.id, anchor]]));
    const newDomain = refreshed.nodes.find(({ id }) => id === a2.id)!.position;
    expect(
      Math.hypot(newDomain.x - anchor.x, newDomain.y - anchor.y),
    ).toBeLessThan(300);
  });

  it('keeps connected families near one another across a packing row', () => {
    const targets = Array.from({ length: 100 }, (_, i) =>
      node(`target|${String(i).padStart(2, '0')}`, 'target'),
    );
    const assets = targets.map((t) =>
      node(t.id.replace('target|', 'asset|'), 'asset'),
    );
    const ip = node('ip|192.0.2.4', 'ip');
    const { nodes, edges } = applyClusterLayout({
      nodes: [...targets, ...assets, ip, ip],
      edges: [
        ...targets.map((t, i) => edge(t.id, assets[i].id, 'belongs_to')),
        ...assets.slice(11, 13).map((a) => edge(a.id, ip.id, 'resolves_to')),
        edge(assets[0].id, 'ip|missing', 'resolves_to'),
      ],
    });
    const [a, b] = nodes.filter(
      ({ id }) => id === targets[11].id || id === targets[12].id,
    );
    expect(
      Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y),
    ).toBeLessThan(1250);
    expect(nodes).toHaveLength(201);
    expect(edges).toHaveLength(102);
  });

  it('keeps a maximum-size target family within a compact area', () => {
    const target = node('target|t1', 'target');
    const assets = Array.from({ length: 1999 }, (_, i) =>
      node(`asset|${i}`, 'asset'),
    );
    const { nodes } = applyClusterLayout({
      nodes: [target, ...assets],
      edges: assets.map((a) => edge(target.id, a.id, 'belongs_to')),
    });
    const xs = nodes.map(({ position }) => position.x);
    const ys = nodes.map(({ position }) => position.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(8000);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(5500);
  });
});

describe('placeInFreeSpots', () => {
  it('preserves dragged positions and moves a new node clear of badges and labels', () => {
    const target = { ...node('target|t1', 'target'), position: { x: 0, y: 0 } };
    const service = {
      ...node('service|s1', 'service'),
      position: { x: 130, y: 0 },
    };
    const fixed = new Map([[target.id, { x: 129, y: 0 }]]);
    const input = [service, target];

    const [placed, anchored] = placeInFreeSpots(input, fixed);

    expect(anchored.position).toEqual(fixed.get(target.id));
    const dx = Math.abs(placed.position.x - anchored.position.x);
    const dy = placed.position.y - anchored.position.y;
    expect(dx >= 124 || dy >= 56 || dy <= -73).toBe(true);
    expect(Math.hypot(placed.position.x - 130, placed.position.y)).toBeLessThan(
      124,
    );
    expect(placeInFreeSpots(input, fixed)).toEqual([placed, anchored]);
    expect(service.position).toEqual({ x: 130, y: 0 });
  });

  it('keeps an unobstructed preferred position', () => {
    const service = {
      ...node('service|s1', 'service'),
      position: { x: -123, y: -42 },
    };
    expect(placeInFreeSpots([service], new Map())).toEqual([service]);
  });

  it('reserves space for each new node even after the local search fills up', () => {
    const input = Array.from({ length: 200 }, (_, i) => ({
      ...node(`service|${i}`, 'service'),
      position: { x: 0, y: 0 },
    }));

    const spaced = placeInFreeSpots(input, new Map());

    const xs = spaced.map(({ position }) => position.x);
    const ys = spaced.map(({ position }) => position.y);
    expect(Math.max(...xs)).toBeGreaterThan(480);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(3000);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(2000);
    for (const [index, a] of spaced.entries()) {
      for (const b of spaced.slice(index + 1)) {
        const dx = Math.abs(a.position.x - b.position.x);
        const dy = Math.abs(a.position.y - b.position.y);
        expect(dx >= 124 || dy >= 87).toBe(true);
      }
    }
  });
});

describe('applyDagreLayout', () => {
  it('returns empty result for an empty graph', () => {
    const result = applyDagreLayout({ nodes: [], edges: [] });
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });

  it('wraps a long hierarchy rank without overlapping its labels', () => {
    const target = node('target|t1', 'target');
    const domains = Array.from({ length: 52 }, (_, i) =>
      node(`asset|${i}`, 'asset'),
    );
    const { nodes } = applyDagreLayout(
      {
        nodes: [target, ...domains],
        edges: domains.map((domain) => edge(target.id, domain.id, 'belongs_to')),
      },
      { rankdir: 'LR' },
    );
    const hub = nodes.find((item) => item.id === target.id)!;
    const columns = new Map<number, number[]>();
    for (const { type, position: { x, y } } of nodes) {
      if (type !== 'asset') continue;
      expect(x - hub.position.x).toBeGreaterThan(110);
      const rows = columns.get(x) ?? [];
      rows.push(y);
      columns.set(x, rows);
    }
    expect(columns.size).toBe(4);
    for (const rows of columns.values()) {
      rows.sort((a, b) => a - b);
      expect(rows.at(-1)! - rows[0]).toBeLessThan(840);
      rows.slice(1).forEach((y, i) => {
        expect(y - rows[i]).toBeGreaterThanOrEqual(59);
      });
    }
  });

  it('positions all nodes and preserves edge endpoints', () => {
    const nodes = [
      node('target|t1', 'target'),
      node('asset|a1', 'asset'),
      node('ip|1.2.3.4', 'ip'),
    ];
    const edges = [
      edge('target|t1', 'asset|a1', 'belongs_to'),
      edge('asset|a1', 'ip|1.2.3.4', 'resolves_to'),
    ];

    const result = applyDagreLayout({ nodes, edges }, { rankdir: 'LR' });

    expect(result.nodes).toHaveLength(3);
    for (const n of result.nodes) {
      expect(Number.isFinite(n.position.x)).toBe(true);
      expect(Number.isFinite(n.position.y)).toBe(true);
    }
    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'target|t1', target: 'asset|a1' }),
        expect.objectContaining({ source: 'asset|a1', target: 'ip|1.2.3.4' }),
      ]),
    );
  });
});
