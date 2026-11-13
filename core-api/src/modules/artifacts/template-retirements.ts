import { isUUID } from 'class-validator';

export const TEMPLATE_RETIREMENTS_KEY = 'argusTemplateRetirements';
export type TemplateRetirements = Record<string, string | null>;

/** Null entries await first observation after the pointer transaction commits. */
export function readTemplateRetirements(metadata: Record<string, unknown>): TemplateRetirements | null {
  const value = metadata[TEMPLATE_RETIREMENTS_KEY];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([key, time]) =>
    (key !== 'file' && (key.length !== 36 || !isUUID(key) || key !== key.toLowerCase())) ||
    (time !== null && (typeof time !== 'string' || !Number.isFinite(Date.parse(time)) || new Date(time).toISOString() !== time)))) return null;
  return Object.fromEntries(entries) as TemplateRetirements;
}
