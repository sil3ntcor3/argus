import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FindingSources, FindingSourceBadges } from './finding-sources';
import type { VulnerabilitySourceDetailDto } from '@/services/apis/gen/queries';

vi.mock('@tanstack/react-router',()=>({ Link:({ children,to,...props }: { children:React.ReactNode;to:string })=><a href={to} {...props}>{children}</a> }));
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
