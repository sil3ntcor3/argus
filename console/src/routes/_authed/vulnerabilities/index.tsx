import { createFileRoute, stripSearchParams } from '@tanstack/react-router';
import { z } from 'zod';
import { tableSearch } from '@/lib/table-search';
import Vulnerabilities from '@/pages/vulnerabilities/vulnerabilities';

const table = tableSearch({ sortBy: 'severity', sortOrder: 'DESC' });

const vulnerabilitiesSearchSchema = z.object({
  ...table.shape,
  status: z.string().optional(),
  discoveredBy: z.enum(['tool','ai','ai_tool','manual']).optional(),
  overdue: z.enum(['true']).optional(),
  severity: z.string().optional(),
  tags: z.string().optional(),
  createdFrom: z.string().optional(),
  createdTo: z.string().optional(),
  targetId: z.string().optional(),
});

export const Route = createFileRoute('/_authed/vulnerabilities/')({
  validateSearch: vulnerabilitiesSearchSchema,
  search: { middlewares: [stripSearchParams(table.defaults)] },
  component: () => (
      <Vulnerabilities />
  ),
});
