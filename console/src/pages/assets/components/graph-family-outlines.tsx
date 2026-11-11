import { memo } from 'react';
import { ViewportPortal, type Node } from '@xyflow/react';
import { resolveNodeType } from './graph-node';
import {
  GRAPH_NODE_MAX_WIDTH,
  nodeFootprint,
  type GraphNodeData,
} from './graph-types';

type Bounds = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  color?: string;
};

const PADDING = 36;

export const GraphFamilyOutlines = memo(function GraphFamilyOutlines({
  nodes,
}: {
  nodes: Node[];
}) {
  const families = new Map<string, Bounds>();
  for (const { id, data, position } of nodes) {
    const { familyId, clusterColor } = data as GraphNodeData;
    if (!familyId) continue;
    const { up, down } = nodeFootprint(resolveNodeType(id));
    const left = position.x - GRAPH_NODE_MAX_WIDTH / 2;
    const right = position.x + GRAPH_NODE_MAX_WIDTH / 2;
    const top = position.y - up;
    const bottom = position.y + down;
    const bounds = families.get(familyId) ?? { left, right, top, bottom };
    bounds.left = Math.min(bounds.left, left);
    bounds.right = Math.max(bounds.right, right);
    bounds.top = Math.min(bounds.top, top);
    bounds.bottom = Math.max(bounds.bottom, bottom);
    if (id === familyId) bounds.color = clusterColor;
    families.set(familyId, bounds);
  }

  return (
    <ViewportPortal>
      {[...families].map(([id, { left, right, top, bottom, color }]) => {
        const tint = color ?? 'var(--color-graph-edge)';
        return (
          <div
            key={id}
            aria-hidden
            data-graph-family-outline={id}
            className="pointer-events-none absolute -z-10 rounded-[48px] border border-dashed"
            style={{
              left: left - PADDING,
              top: top - PADDING,
              width: right - left + 2 * PADDING,
              height: bottom - top + 2 * PADDING,
              backgroundColor: `color-mix(in srgb, ${tint} 7%, transparent)`,
              borderColor: `color-mix(in srgb, ${tint} 35%, transparent)`,
            }}
          />
        );
      })}
    </ViewportPortal>
  );
});
