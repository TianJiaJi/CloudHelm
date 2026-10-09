/** Ordered display content. Reference bodies are stored separately from snapshots. */
export interface ReferenceInfo {
  id: string; kind: 'terminal' | 'paste'; hostId?: string; hostLabel?: string; terminalId?: string;
  generation?: number; command?: string; capturedAt: number; running?: boolean; exitCode?: number; summarized?: boolean;
}
export type MessagePart = { type: 'text'; text: string } | { type: 'reference'; instanceId?: string; reference: ReferenceInfo; content?: string };
export interface MessageDocument { requestId: string; parts: MessagePart[] }
export interface ReferenceBody { reference: ReferenceInfo; original: string; summary?: string }
export interface TerminalQuoteRequest { terminalId: string; hostId: string; selection?: string; conversationId?: string }
export interface StructuredSend { document: MessageDocument; conversationId?: string; hostId: string | null; model?: { provider: string; modelId: string }; thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'; localSelectionTokens: string[] }
