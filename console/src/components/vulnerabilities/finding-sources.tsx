import { Badge } from '@/components/ui/badge';
import { Link } from '@tanstack/react-router';
import type { VulnerabilitySourceDetailDto, VulnerabilitySourceSummaryDto } from '@/services/apis/gen/queries';
import { ImageIcon } from 'lucide-react';
import { useState } from 'react';

/** Restrict image schemes and keep a visible fallback after a load failure. */
function SourceLogo({ url }: { url?: string | null }) {
  const [failed, setFailed] = useState(false);
  const src = url?.startsWith('/') && !url.startsWith('//') ? '/api' + url
    : url && /^https?:\/\//i.test(url) ? url : undefined;
  return !src || failed ? <span role="img" aria-label="Scanner logo unavailable" className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
    <ImageIcon className="size-4" aria-hidden="true" />
  </span> : <img src={src} alt="" width={32} height={32} className="size-8 shrink-0 rounded-md object-contain" onError={() => setFailed(true)} />;
}

/** Link each source to its own scanner, under the existing tool-page permission. */
function SourceScanner({ source, canReadTools }: { source: VulnerabilitySourceDetailDto; canReadTools: boolean }) {
  const label = <><SourceLogo key={source.tool?.logoUrl ?? ''} url={source.tool?.logoUrl} />
    <span className="min-w-0 break-words">{source.tool?.name ?? source.toolName ?? 'Scanner'}</span></>;
  const className = 'flex min-w-0 items-center gap-2 text-sm font-medium';
  return canReadTools && source.tool?.id ? <Link to="/tools/$id" params={{ id: source.tool.id }} className={className + ' text-primary underline-offset-4 hover:underline focus-visible:underline'}>{label}</Link>
    : <span className={className}>{label}</span>;
}

const discoveryLabels: Record<string,string> = { tool:'Scanner',ai:'AI',ai_tool:'AI + tool',manual:'Manual' };
const reviewLabels: Record<string,string> = { pending_review:'Pending review',approved:'Approved',rejected:'Rejected' };
export function FindingSourceBadges({ discoveredBy,reviewStatus,sources = [] }: {
  discoveredBy?: string;reviewStatus?: string;sources?: VulnerabilitySourceSummaryDto[];
}) {
  const labels = [...new Set(sources.map(source=>source.kind==='tool' ? source.toolName??'Scanner'
    : source.kind==='ai_agent' ? `Agent: ${source.agentName??'AI'}` : 'User'))];
  return <div className="flex flex-wrap gap-1" aria-label="Finding sources">
    {reviewStatus && reviewStatus!=='approved' && <Badge variant="outline">{reviewLabels[reviewStatus]??'Under review'}</Badge>}
    <Badge variant="secondary">{discoveryLabels[discoveredBy??'tool']??'Unknown source'}</Badge>
    {labels.slice(0,4).map(label=><Badge variant="outline" key={label} className="max-w-full break-all whitespace-normal">{label}</Badge>)}
    {labels.length>4&&<Badge variant="outline">+{labels.length-4} sources</Badge>}
  </div>;
}
function ProofText({ title,values }: { title:string;values:unknown }) {
  const lines = typeof values==='string' ? [values] : Array.isArray(values) ? values.filter((value):value is string=>typeof value==='string') : [];
  if (!lines.length) return null;
  return <section className="min-w-0 space-y-2"><h4 className="text-sm font-medium">{title}</h4>
    {lines.map((value,index)=><pre key={index} className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-xs">{value}</pre>)}
  </section>;
}

/** Attached proof is plain text. Reference links require both DTO authorization and current access. */
export function FindingSources({ sources,canReadJobs,canReadAgents,canReadTools = false }: {
  sources:VulnerabilitySourceDetailDto[];canReadJobs:boolean;canReadAgents:boolean;canReadTools?:boolean;
}) {
  return <section className="min-w-0 space-y-3 rounded-lg border bg-card p-4" aria-label="Finding evidence">
    <h2 className="text-sm font-medium">Sources and evidence</h2>
    {!sources.length ? <p className="text-sm text-muted-foreground">No recorded sources.</p> : sources.map(source=><article key={source.id} className="min-w-0 space-y-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {source.kind==='tool' ? <SourceScanner source={source} canReadTools={canReadTools} />
          : <span className="break-words text-sm font-medium">{source.kind==='ai_agent' ? `Agent: ${source.agentName??'AI'}` : 'User'}</span>}
        <time className="text-xs text-muted-foreground" dateTime={source.createdAt}>{new Date(source.createdAt).toLocaleString()}</time>
      </div>
      {source.createdByUser&&<p className="text-xs text-muted-foreground">Submitted by {source.createdByUser.name}</p>}
      <div className="flex flex-wrap gap-3 text-sm">
        {canReadJobs&&source.jobHistoryId&&<Link to="/jobs/runs/$id" params={{ id:source.jobHistoryId }} className="text-primary underline">Source run</Link>}
        {canReadAgents&&source.agentConversationId&&<Link to="/aistudio/conversations/$conversationId" params={{ conversationId:source.agentConversationId }} className="text-primary underline">Source conversation</Link>}
      </div>
      {canReadAgents&&source.agentConversationId&&Boolean(source.toolCallIds?.length)&&<p className="break-all text-xs text-muted-foreground">Cited calls: {source.toolCallIds!.map(id=><code key={id} className="mr-2">{id}</code>)}</p>}
      {source.evidence&&<div className="min-w-0 space-y-3">
        <ProofText title="Requests" values={source.evidence.requests}/><ProofText title="Responses" values={source.evidence.responses}/>
        <ProofText title="Normal baseline" values={source.evidence.baseline}/><ProofText title="Evidence notes" values={source.evidence.notes}/>
      </div>}
    </article>)}
  </section>;
}
