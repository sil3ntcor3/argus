import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FindingSources, FindingSourceBadges } from './finding-sources';
import type { VulnerabilitySourceDetailDto } from '@/services/apis/gen/queries';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, params, children, ...props }: { to: string; params: Record<string,string>; children: ReactNode }) =>
    <a href={Object.entries(params).reduce((path,[key,value])=>path.replace('$'+key,value),to)} {...props}>{children}</a>,
}));
const source:VulnerabilitySourceDetailDto={ id:'source',kind:'ai_agent',createdAt:'2026-11-13T12:00:00Z',toolName:null,tool:null,
  agentName:'pentest',jobHistoryId:'run',agentConversationId:'chat',toolCallIds:['call'],createdByUser:{ id:'actor',name:'Reviewer',image:null },
  evidence:{ requests:['<script>alert(1)</script>'],responses:['200 OK'],baseline:'Normal control response',notes:'Use staging only' } };
describe('Finding source evidence',()=>{
  it('renders proof as literal text with a baseline and permission-aware links',()=>{
    const { container }=render(<FindingSources sources={[source]} canReadJobs canReadAgents/>);
    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument();expect(container.querySelector('script')).toBeNull();
    expect(screen.getByText('Normal control response')).toBeInTheDocument();
    expect(screen.getByRole('link',{ name:'Source run' })).toBeInTheDocument();
    expect(screen.getByRole('link',{ name:'Source conversation' })).toBeInTheDocument();
    expect(screen.getByText('call')).toBeInTheDocument();
  });
  it('omits private reference controls without effective permissions',()=>{
    render(<FindingSources sources={[source]} canReadJobs={false} canReadAgents={false}/>);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();expect(screen.queryByText('call')).not.toBeInTheDocument();
    expect(screen.getByText('Normal control response')).toBeInTheDocument();
  });
  it('handles empty sources and compact discovery/review labels',()=>{
    render(<><FindingSources sources={[]} canReadJobs={false} canReadAgents={false}/>
      <FindingSourceBadges discoveredBy="ai_tool" reviewStatus="pending_review" sources={[source]}/></>);
    expect(screen.getByText('No recorded sources.')).toBeInTheDocument();expect(screen.getByText('AI + tool')).toBeInTheDocument();
    expect(screen.getByText('Pending review')).toBeInTheDocument();
  });
});

const scannerSource = { id: 'source', kind: 'tool', createdAt: '2026-11-14T12:00:00Z', toolName: 'Scanner', agentName: null,
  tool: { id: 'tool', name: 'Nuclei', logoUrl: '/logos/nuclei.png' }, jobHistoryId: 'run', agentConversationId: 'chat',
  toolCallIds: null, evidence: null, createdByUser: null } as VulnerabilitySourceDetailDto;

describe('Source-specific scanner presentation', () => {
  it('shows the source logo and tool link independently from the primary scanner', () => {
    const { container } = render(<FindingSources sources={[scannerSource]} canReadJobs canReadAgents canReadTools />);
    expect(screen.getByRole('link', { name: 'Nuclei' })).toHaveAttribute('href', '/tools/tool');
    expect(container.querySelector('img')).toHaveAttribute('src', '/api/logos/nuclei.png');
    expect(screen.getByRole('link', { name: 'Source run' })).toHaveAttribute('href', '/jobs/runs/run');
  });
  it('retains the scanner label but hides links after permission revocation', () => {
    const { rerender } = render(<FindingSources sources={[scannerSource]} canReadJobs canReadAgents canReadTools />);
    rerender(<FindingSources sources={[scannerSource]} canReadJobs={false} canReadAgents={false} canReadTools={false} />);
    expect(screen.getByText('Nuclei')).toBeVisible();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
  it('uses a visible fallback for missing or failed logos', () => {
    const { container, rerender } = render(<FindingSources sources={[scannerSource]} canReadJobs={false} canReadAgents={false} />);
    fireEvent.error(container.querySelector('img')!);
    expect(screen.getByLabelText('Scanner logo unavailable')).toBeVisible();
    rerender(<FindingSources sources={[{ ...scannerSource, tool: { ...scannerSource.tool!, logoUrl: null } }]} canReadJobs={false} canReadAgents={false} />);
    expect(container.querySelector('img')).toBeNull();
  });
  it.each(['javascript:alert(1)', '//outside.example/logo.svg'])('does not load unsafe logo %s', logoUrl => {
    const { container } = render(<FindingSources sources={[{ ...scannerSource, tool: { ...scannerSource.tool!, logoUrl } }]} canReadJobs={false} canReadAgents={false} />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('Nuclei')).toBeVisible();
  });
});
